import { sql } from '@vercel/postgres';
import { requireAuth, generateUUID, respond } from '../../../lib/auth';

export const maxDuration = 60;

export async function OPTIONS() {
  return new Response(null, { status: 200 });
}

export async function GET(request) {
  const user = await requireAuth(request);
  if (!user) return respond({ error: 'Not authenticated' }, 401);
  const { searchParams } = new URL(request.url);
  const orgId = searchParams.get('org_id');
  if (!orgId) return respond({ error: 'org_id required' }, 400);

  const r = await sql`SELECT uuid, report_json, respondent_count, overall_score, risk_level, created_at FROM reports WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 1`;
  if (r.rows.length > 0) {
    const row = r.rows[0];
    row.report_json = JSON.parse(row.report_json);
    return respond({ report: row });
  }
  return respond({ report: null });
}

export async function POST(request) {
  try {
    const user = await requireAuth(request);
    if (!user) return respond({ error: 'Not authenticated' }, 401);
    const { searchParams } = new URL(request.url);
    const orgId = searchParams.get('org_id');
    if (!orgId) return respond({ error: 'org_id required' }, 400);

    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_API_KEY) return respond({ error: 'ANTHROPIC_API_KEY not configured' }, 500);

    // Verify ownership
    const orgResult = await sql`SELECT * FROM organizations WHERE id = ${orgId} AND owner_id = ${user.id}`;
    const org = orgResult.rows[0];
    if (!org) return respond({ error: 'Not found' }, 404);

    // H-07: Check for existing recent report (generated within last 5 minutes)
    const existing = await sql`SELECT uuid, report_json, respondent_count, overall_score, risk_level, created_at FROM reports WHERE org_id = ${orgId} AND created_at > NOW() - INTERVAL '5 minutes' ORDER BY created_at DESC LIMIT 1`;
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      row.report_json = JSON.parse(row.report_json);
      return respond({ report: row, cached: true });
    }

    // H-07: Check/set generating flag on assessment
    const assessResult = await sql`SELECT id, status FROM assessments WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 1`;
    if (assessResult.rows.length === 0) return respond({ error: 'No assessment' }, 404);
    const aid = assessResult.rows[0].id;

    if (assessResult.rows[0]?.status === 'generating') {
      return respond({ error: 'Report generation already in progress' }, 409);
    }

    // Set generating status
    await sql`UPDATE assessments SET status = 'generating' WHERE id = ${aid}`;

  // Get completed respondents
  const respondentsResult = await sql`SELECT * FROM respondents WHERE assessment_id = ${aid} AND status = 'completed'`;
  const respondents = respondentsResult.rows;
  if (respondents.length === 0) return respond({ error: 'No completed respondents' }, 400);

  // Get all responses
  const allRespResult = await sql`SELECT r.*, resp.uuid as resp_uuid, resp.role, resp.role_category, q.benchmark_value, q.is_critical, q.critical_condition FROM responses r JOIN respondents resp ON r.respondent_id = resp.id JOIN questions q ON r.question_id = q.id WHERE r.assessment_id = ${aid} AND resp.status = 'completed' ORDER BY r.section_number, r.question_code`;
  const allResp = allRespResult.rows;

  // Get all pulses
  const allPulsesResult = await sql`SELECT ep.*, resp.uuid as resp_uuid FROM emotional_pulses ep JOIN respondents resp ON ep.respondent_id = resp.id WHERE ep.assessment_id = ${aid} AND resp.status = 'completed'`;
  const allPulses = allPulsesResult.rows;

  // Pre-compute scores (same logic as PHP)
  const sectionNames = ['','Leadership & Oversight','Systems & Technology','Bookkeeping & Monthly Finances','Donations, Revenue & Restricted Funds','Spending & Approvals','Payroll & People','Financial Reporting','Audits & Compliance','Policies & Documentation','Data Quality & Records','Cash, Banking & Reserves','Risk, Insurance & Safety','Budgeting & Planning'];
  const scores = {};
  const priorities = {};
  const criticalFindings = [];
  const sectionData = {};

  for (let sec = 1; sec <= 13; sec++) {
    const secResp = allResp.filter(r => Number(r.section_number) === sec);
    const scorable = secResp.filter(r => r.answer_matches_benchmark !== null);

    const byQ = {};
    for (const r of scorable) {
      if (!byQ[r.question_code]) byQ[r.question_code] = {};
      byQ[r.question_code][r.resp_uuid] = r.answer_matches_benchmark;
    }
    const qScores = {};
    for (const [code, resps] of Object.entries(byQ)) {
      const vals = Object.values(resps).map(v => v ? 1 : 0);
      qScores[code] = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    const numQ = Object.keys(qScores).length;
    const scoreVal = numQ > 0 ? Math.round(Object.values(qScores).reduce((a, b) => a + b, 0) / numQ * 5 * 10) / 10 : 2.5;
    scores[sec] = scoreVal;

    let hasCrit = false;
    let critCode = null;
    for (const r of secResp) {
      if (r.is_critical && !r.answer_matches_benchmark) {
        hasCrit = true;
        critCode = r.question_code;
        criticalFindings.push({ code: r.question_code, answer: r.answer_raw, condition: r.critical_condition });
      }
    }
    const pri = (hasCrit || scoreVal <= 2.5) ? 'HIGH' : (scoreVal <= 3.5 ? 'MEDIUM' : 'LOW');
    priorities[sec] = pri;

    // Agreement
    const byQAll = {};
    for (const r of secResp) {
      if (r.question_type !== 'open_ended' && r.question_type !== 'free_text') {
        if (!byQAll[r.question_code]) byQAll[r.question_code] = {};
        byQAll[r.question_code][r.resp_uuid] = r.answer_normalized || r.answer_raw;
      }
    }
    let agreed = 0, totalQ = 0;
    for (const resps of Object.values(byQAll)) {
      totalQ++;
      if (new Set(Object.values(resps)).size === 1) agreed++;
    }
    const agreePct = totalQ > 0 ? Math.round(agreed / totalQ * 100) : 0;

    // Store section score
    const matchCount = scorable.filter(r => r.answer_matches_benchmark).length;
    await sql`INSERT INTO section_scores (assessment_id, org_id, section_number, section_name, score, priority, questions_total, questions_matching, respondent_agreement_pct, has_critical_finding, critical_finding_code)
      VALUES (${aid}, ${orgId}, ${sec}, ${sectionNames[sec]}, ${scoreVal}, ${pri}, ${numQ}, ${matchCount}, ${agreePct}, ${hasCrit}, ${critCode})
      ON CONFLICT (assessment_id, section_number) DO UPDATE SET
      score=EXCLUDED.score, priority=EXCLUDED.priority, questions_total=EXCLUDED.questions_total, questions_matching=EXCLUDED.questions_matching, respondent_agreement_pct=EXCLUDED.respondent_agreement_pct, has_critical_finding=EXCLUDED.has_critical_finding, critical_finding_code=EXCLUDED.critical_finding_code`;

    // Build section data for AI
    const factual = {};
    const openEnded = {};
    for (const r of secResp) {
      const code = r.question_code;
      if (r.question_type === 'open_ended' || r.question_type === 'free_text') {
        if (r.answer_raw) {
          if (!openEnded[code]) openEnded[code] = {};
          openEnded[code][r.resp_uuid] = r.answer_raw;
        }
      } else {
        if (!factual[code]) factual[code] = {};
        factual[code][r.resp_uuid] = r.answer_raw;
      }
    }
    sectionData[sec] = { factual, open_ended: openEnded, score: scoreVal, priority: pri, agreement: agreePct };
  }

  // Heatmap
  const words = ['confident','concerned','overwhelmed','hopeful','uncertain','frustrated','encouraged','afraid','empowered','lost'];
  const heatmap = Array.from({ length: 13 }, () => Array(10).fill(0));
  const emotionTotals = Object.fromEntries(words.map(w => [w, 0]));
  for (const p of allPulses) {
    const si = Number(p.section_number);
    if (si >= 1 && si <= 13) {
      words.forEach((w, wi) => { const v = p['word_' + w] ? 1 : 0; heatmap[si - 1][wi] += v; emotionTotals[w] += v; });
    } else {
      words.forEach(w => { emotionTotals[w] += (p['word_' + w] ? 1 : 0); });
    }
  }

  // Sentiment shifts
  const shifts = [];
  for (const resp of respondents) {
    const iv = await sql`SELECT valence_score FROM emotional_pulses WHERE respondent_id = ${resp.id} AND pulse_point = 'initial'`;
    const fv = await sql`SELECT valence_score FROM emotional_pulses WHERE respondent_id = ${resp.id} AND pulse_point = 'final'`;
    if (iv.rows[0]?.valence_score != null && fv.rows[0]?.valence_score != null) {
      const i = Number(iv.rows[0].valence_score);
      const f = Number(fv.rows[0].valence_score);
      shifts.push({ id: resp.uuid, initial: i, final: f, shift: Math.round((f - i) * 100) / 100 });
    }
  }

  const overallScore = Math.round(Object.values(scores).reduce((a, b) => a + b, 0) / 13 * 10) / 10;
  const highCount = Object.values(priorities).filter(p => p === 'HIGH').length;
  const riskLevel = highCount <= 1 ? 'Low' : highCount <= 3 ? 'Moderate' : highCount <= 6 ? 'Elevated' : 'Critical';
  const needsAttention = Object.values(scores).filter(s => s <= 3.0).length;

  // Build AI payload
  const respProfiles = respondents.map(r => ({
    id: r.uuid, role: r.role, cat: r.role_category, years: r.years_involved, health: r.financial_health_rating,
    mission: (r.mission_description || '').slice(0, 200), highlight: (r.recent_highlight || '').slice(0, 200), concerns: (r.concerns_text || '').slice(0, 200)
  }));

  // Get final reflections
  const finalsResult = await sql`SELECT r.question_code, r.answer_raw, resp.uuid FROM responses r JOIN respondents resp ON r.respondent_id = resp.id WHERE r.assessment_id = ${aid} AND r.section_number = 14 AND resp.status = 'completed' AND r.answer_raw != ''`;
  const finals = {};
  for (const r of finalsResult.rows) {
    if (!finals[r.question_code]) finals[r.question_code] = {};
    finals[r.question_code][r.uuid] = r.answer_raw;
  }

  const payload = JSON.stringify({
    org: { name: org.name, type: org.org_type, irs: org.irs_classification, denom: org.denomination, budget: org.annual_budget, staff_ft: org.employees_ft, staff_pt: org.employees_pt, contractors: org.contractors, volunteers: org.volunteers, city: org.address_city, state: org.address_state, founded: org.year_founded, payroll: org.payroll_method, last_audit: org.last_audit, fed_funding: org.federal_funding, endowment: org.endowment, gov_body: org.governing_body_type, board: org.board_members_current, fin_committee: org.finance_committee, fin_person: org.finance_person_type },
    respondents: respProfiles,
    pre_computed: { scores: Object.values(scores), priorities: Object.values(priorities), overall_score: overallScore, risk_level: riskLevel, needs_attention: needsAttention, agreement: Array.from({ length: 13 }, (_, i) => sectionData[i + 1].agreement), criticals: criticalFindings, heatmap, emotion_totals: emotionTotals, shifts },
    sections: sectionData,
    finals
  });

  // System prompt (same as PHP version)
  const systemPrompt = `You are a senior nonprofit financial consultant generating a report for the Provident Assessment Platform. You receive pre-computed scores and respondent data. Your job is NARRATIVE SYNTHESIS — the backend already did the math.

Return ONLY valid JSON. No markdown. No backticks. No preamble.

SCORING IS PRE-COMPUTED. Use scores, priorities, and heatmap as given. DO NOT recalculate.

RULES: Cite respondent counts ("3 of 5 confirmed"). NEVER quote verbatim — paraphrase. Divergence IS the finding. Strengths must be genuine. Concerns: state directly, explain why it matters. Recommendations: specific and actionable, no "consider" or "evaluate." Tone: direct, encouraging, professional.

OUTPUT JSON:
{"executive_summary":"3-4 paragraphs with \\n between. P1=context. P2=dominant theme. P3=bright spots. P4=path forward. 300-500 words.",
"team":{"perception_gap":"2 paragraphs comparing health ratings across roles. Flag proximity divergence.","consistency_pct":78},
"emotional_landscape":{"aggregate_narrative":"1 paragraph on dominant emotions and ratio.","heatmap_narrative":"2 paragraphs on hot columns, hot rows, role divergence.","shift_narrative":"1 paragraph on initial vs final pulse shifts."},
"sections":[{"number":1,"title":"Leadership & Oversight","score_explanation":"1 paragraph tracing score to specific questions.","strengths":["strength with count"],"concerns":["concern with data and why it matters"],"team_said":"2-3 paragraphs synthesizing open-ended.","recommendations":["specific action"],"vision":"1 paragraph from aspirational responses.","pulse_narrative":"1 sentence."}],
"priorities":[{"rank":1,"title":"imperative title","timeline":"0-90 days","urgency":"red","description":"2-3 sentences.","owner":"Role","section_ref":8}],
"targets":[{"area":"name","current":1.6,"target":4.0}],
"key_person_risk":{"narrative":"1 paragraph identifying single point of failure.","functions":[{"function":"Month-end close","owner":"Bookkeeper","documented":false,"backup":"None","risk":"CRITICAL"}]},
"mission":{"score":4.3,"descriptions":[{"id":"R1","paraphrase":"summary","alignment":"Strong"}],"highlights":"1 paragraph.","narrative":"1 paragraph."}}`;

  // Call Anthropic API
  const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'Generate report.\n\n' + payload }]
    })
  });

  if (!apiResponse.ok) {
    const detail = await apiResponse.json().catch(() => ({}));
    // Reset generating status on API failure
    await sql`UPDATE assessments SET status = 'active' WHERE id = ${aid}`;
    return respond({ error: `API returned ${apiResponse.status}`, detail }, 502);
  }

  const apiData = await apiResponse.json();
  let text = '';
  for (const block of (apiData.content || [])) {
    if (block.text) text += block.text;
  }
  text = text.trim().replace(/^```json\s*|```\s*$/gm, '');
  let report;
  try {
    report = JSON.parse(text);
  } catch (e) {
    await sql`UPDATE assessments SET status = 'active' WHERE id = ${aid}`;
    return respond({ error: 'Failed to parse AI response', raw: text.slice(0, 500) }, 500);
  }

  // Merge pre-computed
  report.scores = Object.values(scores);
  report.priorities_list = Object.values(priorities);
  report.heatmap = heatmap;
  report.emotion_totals = emotionTotals;
  report.respondent_count = respondents.length;
  report.overall_score = overallScore;
  report.risk_level = riskLevel;
  report.needs_attention = needsAttention;
  report.respondent_profiles = respProfiles;

  // Store report
  const rUuid = generateUUID();
  const tokens = apiData.usage?.output_tokens || null;
  const reportJson = JSON.stringify(report);
  await sql`INSERT INTO reports (uuid, assessment_id, org_id, report_json, ai_model, ai_tokens_used, respondent_count, overall_score, risk_level) VALUES (${rUuid}, ${aid}, ${orgId}, ${reportJson}, 'claude-sonnet-4-6', ${tokens}, ${respondents.length}, ${overallScore}, ${riskLevel})`;

    // Update assessment
    await sql`UPDATE assessments SET status = 'completed', overall_score = ${overallScore}, risk_level = ${riskLevel}, completed_at = NOW() WHERE id = ${aid}`;

    return respond({ report: { uuid: rUuid, report_json: report, respondent_count: respondents.length, overall_score: overallScore, risk_level: riskLevel, created_at: new Date().toISOString() } });
  } catch (error) {
    console.error('POST report error:', error);
    // Reset generating status on failure
    try {
      const { searchParams } = new URL(request.url);
      const orgId = searchParams.get('org_id');
      if (orgId) {
        const assessResult = await sql`SELECT id FROM assessments WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 1`;
        if (assessResult.rows.length > 0) {
          await sql`UPDATE assessments SET status = 'active' WHERE id = ${assessResult.rows[0].id}`;
        }
      }
    } catch (e) {
      console.error('Error resetting assessment status:', e);
    }
    return respond({ error: 'Server error' }, 500);
  }
}

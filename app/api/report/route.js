import { sql } from '@vercel/postgres';
import { requireAuth, generateUUID, respond, checkOrgAccess } from '../../../lib/auth';

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

  // Viewers, respondents, admins, and super admins can view reports
  const access = await checkOrgAccess(user, orgId, ['admin', 'respondent', 'viewer']);
  if (!access.allowed) return respond({ error: 'Access denied' }, 403);

  const r = await sql`SELECT uuid, report_json, respondent_count, overall_score, risk_level, created_at FROM reports WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 1`;
  if (r.rows.length > 0) {
    const row = r.rows[0];
    try { row.report_json = JSON.parse(row.report_json); } catch (e) { row.report_json = null; }
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

    // Only admins and super admins can generate reports
    const access = await checkOrgAccess(user, orgId, ['admin']);
    if (!access.allowed) return respond({ error: 'Only organization admins can generate reports' }, 403);

    const orgResult = await sql`SELECT * FROM organizations WHERE id = ${orgId}`;
    const org = orgResult.rows[0];
    if (!org) return respond({ error: 'Not found' }, 404);

    // H-07: Check for existing recent report (generated within last 5 minutes)
    const existing = await sql`SELECT uuid, report_json, respondent_count, overall_score, risk_level, created_at FROM reports WHERE org_id = ${orgId} AND created_at > NOW() - INTERVAL '5 minutes' ORDER BY created_at DESC LIMIT 1`;
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      try { row.report_json = JSON.parse(row.report_json); } catch (e) { row.report_json = null; }
      return respond({ report: row, cached: true });
    }

    // H-07: Atomic check/set generating flag (prevents race condition)
    const assessResult = await sql`SELECT id FROM assessments WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 1`;
    if (assessResult.rows.length === 0) return respond({ error: 'No assessment' }, 404);
    const aid = assessResult.rows[0].id;

    const lockResult = await sql`UPDATE assessments SET status = 'generating' WHERE id = ${aid} AND status != 'generating' RETURNING id`;
    if (lockResult.rows.length === 0) {
      return respond({ error: 'Report generation already in progress' }, 409);
    }

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
  const sectionScoresToInsert = [];

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

    // Collect section score for batch insert
    const matchCount = scorable.filter(r => r.answer_matches_benchmark).length;
    sectionScoresToInsert.push({
      assessment_id: aid,
      org_id: orgId,
      section_number: sec,
      section_name: sectionNames[sec],
      score: scoreVal,
      priority: pri,
      questions_total: numQ,
      questions_matching: matchCount,
      respondent_agreement_pct: agreePct,
      has_critical_finding: hasCrit,
      critical_finding_code: critCode
    });

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

  // Batch insert section scores
  if (sectionScoresToInsert.length > 0) {
    const values = sectionScoresToInsert.map((row, idx) => {
      const offset = idx * 11;
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11})`;
    }).join(',');

    const flatParams = sectionScoresToInsert.flatMap(row => [
      row.assessment_id, row.org_id, row.section_number, row.section_name, row.score, row.priority,
      row.questions_total, row.questions_matching, row.respondent_agreement_pct, row.has_critical_finding, row.critical_finding_code
    ]);

    const query = `INSERT INTO section_scores (assessment_id, org_id, section_number, section_name, score, priority, questions_total, questions_matching, respondent_agreement_pct, has_critical_finding, critical_finding_code)
      VALUES ${values}
      ON CONFLICT (assessment_id, section_number) DO UPDATE SET
      score=EXCLUDED.score, priority=EXCLUDED.priority, questions_total=EXCLUDED.questions_total, questions_matching=EXCLUDED.questions_matching, respondent_agreement_pct=EXCLUDED.respondent_agreement_pct, has_critical_finding=EXCLUDED.has_critical_finding, critical_finding_code=EXCLUDED.critical_finding_code`;

    await sql.query(query, flatParams);
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

  // Sentiment shifts - fetch all initial and final pulses in one query per type
  const shiftsMap = {};
  const initialPulsesResult = await sql`SELECT respondent_id, valence_score FROM emotional_pulses WHERE assessment_id = ${aid} AND pulse_point = 'initial'`;
  const finalPulsesResult = await sql`SELECT respondent_id, valence_score FROM emotional_pulses WHERE assessment_id = ${aid} AND pulse_point = 'final'`;

  const initialByResp = Object.fromEntries(initialPulsesResult.rows.map(r => [r.respondent_id, r.valence_score]));
  const finalByResp = Object.fromEntries(finalPulsesResult.rows.map(r => [r.respondent_id, r.valence_score]));

  const shifts = [];
  for (const resp of respondents) {
    const iv = initialByResp[resp.id];
    const fv = finalByResp[resp.id];
    if (iv != null && fv != null) {
      const i = Number(iv);
      const f = Number(fv);
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

  // System prompt — condensed for token efficiency
  const systemPrompt = `You are a nonprofit financial consultant generating a JSON report. You receive pre-computed scores and data. Your job is NARRATIVE SYNTHESIS — the backend did the math.

Return ONLY valid JSON. No markdown, backticks, or preamble. Be concise — each narrative field should be 2-4 sentences max unless specified.

RULES: Use pre-computed scores as given. Cite respondent counts. Paraphrase, never quote verbatim. Be specific and actionable.

OUTPUT JSON STRUCTURE:
{"executive_summary":"2-3 short paragraphs separated by \\n. P1=context+score. P2=key theme+concerns. P3=bright spots+path forward. 150-250 words max.",
"team":{"perception_gap":"1 paragraph comparing health ratings across roles.","consistency_pct":78},
"emotional_landscape":{"aggregate_narrative":"2-3 sentences on dominant emotions.","heatmap_narrative":"3-4 sentences on hot spots in the emotion heatmap.","shift_narrative":"2 sentences on sentiment shifts."},
"sections":[{"number":1,"title":"Section Name","score_explanation":"2 sentences tracing score to data.","strengths":["1 strength with count"],"concerns":["1 concern with why it matters"],"team_said":"1 paragraph synthesizing open-ended responses.","recommendations":["1 specific action"],"pulse_narrative":"1 sentence."}],
"priorities":[{"rank":1,"title":"title","timeline":"0-90 days","urgency":"red","description":"1-2 sentences.","owner":"Role","section_ref":8}],
"targets":[{"area":"name","current":1.6,"target":4.0}],
"key_person_risk":{"narrative":"2-3 sentences on single points of failure.","functions":[{"function":"name","owner":"Role","documented":false,"backup":"None","risk":"CRITICAL"}]},
"mission":{"score":4.3,"descriptions":[{"id":"R1","paraphrase":"summary","alignment":"Strong"}],"highlights":"2 sentences.","narrative":"2 sentences."}}

IMPORTANT: Include all 13 sections in the sections array. Keep each section concise. Limit strengths to 2, concerns to 3, recommendations to 2 per section. Top 5 priorities only. 3-5 key person risk functions.`;

  // Call Anthropic API
  const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      system: systemPrompt,
      messages: [
        { role: 'user', content: 'Generate report.\n\n' + payload },
        { role: 'assistant', content: '{' }
      ]
    })
  });

  if (!apiResponse.ok) {
    const detail = await apiResponse.json().catch(() => ({}));
    // Reset generating status on API failure
    await sql`UPDATE assessments SET status = 'active' WHERE id = ${aid} AND status = 'generating'`;
    return respond({ error: `API returned ${apiResponse.status}`, detail }, 502);
  }

  const apiData = await apiResponse.json();

  // Check if response was truncated
  if (apiData.stop_reason === 'max_tokens') {
    await sql`UPDATE assessments SET status = 'active' WHERE id = ${aid} AND status = 'generating'`;
    return respond({ error: 'AI response was truncated (too long). Please try again.' }, 500);
  }

  let text = '';
  for (const block of (apiData.content || [])) {
    if (block.text) text += block.text;
  }
  // Prepend the prefilled '{' since the API continues from the assistant prefill
  text = '{' + text;
  // Robust JSON extraction: find the outermost { ... }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    await sql`UPDATE assessments SET status = 'active' WHERE id = ${aid} AND status = 'generating'`;
    return respond({ error: 'No JSON object found in AI response', raw: text.slice(0, 500) }, 500);
  }
  text = text.slice(firstBrace, lastBrace + 1);
  let report;
  try {
    report = JSON.parse(text);
  } catch (e) {
    // Try fixing common issues: trailing commas, control chars
    let cleaned = text.replace(/,\s*([}\]])/g, '$1').replace(/[\x00-\x1f\x7f]/g, c => c === '\n' || c === '\t' ? c : '');
    try {
      report = JSON.parse(cleaned);
    } catch (e2) {
      await sql`UPDATE assessments SET status = 'active' WHERE id = ${aid} AND status = 'generating'`;
      return respond({ error: 'Failed to parse AI response', raw: text.slice(0, 500), parseError: e2.message }, 500);
    }
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
  await sql`INSERT INTO reports (uuid, assessment_id, org_id, report_json, ai_model, ai_tokens_used, respondent_count, overall_score, risk_level) VALUES (${rUuid}, ${aid}, ${orgId}, ${reportJson}, 'claude-haiku-4-5-20251001', ${tokens}, ${respondents.length}, ${overallScore}, ${riskLevel})`;

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
          await sql`UPDATE assessments SET status = 'active' WHERE id = ${assessResult.rows[0].id} AND status = 'generating'`;
        }
      }
    } catch (e) {
      console.error('Error resetting assessment status:', e);
    }
    return respond({ error: 'Server error' }, 500);
  }
}

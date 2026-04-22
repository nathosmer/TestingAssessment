import { sql } from '@vercel/postgres';
import { requireAuth, respond, checkOrgAccess } from '../../../lib/auth';
import { checkEntitlement, recordPurchase, PRODUCTS, formatPrice } from '../../../lib/billing';

export const maxDuration = 120; // Detailed report takes longer

export async function OPTIONS() {
  return new Response(null, { status: 200 });
}

/**
 * GET — Check if a detailed report exists for this org
 */
export async function GET(request) {
  const user = await requireAuth(request);
  if (!user) return respond({ error: 'Not authenticated' }, 401);
  const { searchParams } = new URL(request.url);
  const orgId = searchParams.get('org_id');
  if (!orgId) return respond({ error: 'org_id required' }, 400);

  const access = await checkOrgAccess(user, orgId, ['admin', 'respondent', 'viewer']);
  if (!access.allowed) return respond({ error: 'Access denied' }, 403);

  // Check entitlement
  const ent = await checkEntitlement(user.id, 'detailed_report', orgId);

  // Check if a detailed report already exists (stored in reports table with ai_model containing 'detailed')
  try {
    const existing = await sql`
      SELECT uuid, report_json, created_at FROM reports
      WHERE org_id = ${orgId} AND ai_model LIKE '%detailed%'
      ORDER BY created_at DESC LIMIT 1
    `;
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      try { row.report_json = JSON.parse(row.report_json); } catch (e) {}
      return respond({ has_report: true, entitled: ent.entitled, report: row });
    }
  } catch (e) { /* table column may not exist */ }

  return respond({
    has_report: false,
    entitled: ent.entitled,
    product: { ...PRODUCTS.detailed_report, price: formatPrice(PRODUCTS.detailed_report.price_cents) },
  });
}

/**
 * POST — Generate a detailed text report via Claude API
 */
export async function POST(request) {
  try {
    const user = await requireAuth(request);
    if (!user) return respond({ error: 'Not authenticated' }, 401);
    const { searchParams } = new URL(request.url);
    const orgId = searchParams.get('org_id');
    if (!orgId) return respond({ error: 'org_id required' }, 400);

    const access = await checkOrgAccess(user, orgId, ['admin']);
    if (!access.allowed) return respond({ error: 'Only admins can generate detailed reports' }, 403);

    // Check entitlement — must have purchased or be granted access
    const ent = await checkEntitlement(user.id, 'detailed_report', orgId);
    if (!ent.entitled) {
      return respond({
        error: 'Purchase required',
        requires_purchase: true,
        product: { ...PRODUCTS.detailed_report, price: formatPrice(PRODUCTS.detailed_report.price_cents) },
      }, 402);
    }

    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_API_KEY) return respond({ error: 'ANTHROPIC_API_KEY not configured' }, 500);

    // Get the existing dashboard report data (must have a report generated first)
    const reportResult = await sql`
      SELECT report_json FROM reports
      WHERE org_id = ${orgId} AND (ai_model NOT LIKE '%detailed%' OR ai_model IS NULL)
      ORDER BY created_at DESC LIMIT 1
    `;
    if (reportResult.rows.length === 0) {
      return respond({ error: 'Generate a dashboard report first before requesting the detailed report.' }, 400);
    }
    let dashReport;
    try { dashReport = JSON.parse(reportResult.rows[0].report_json); } catch (e) {
      return respond({ error: 'Could not parse existing report data' }, 500);
    }

    // Get org data
    const orgResult = await sql`SELECT * FROM organizations WHERE id = ${orgId}`;
    const org = orgResult.rows[0];
    if (!org) return respond({ error: 'Organization not found' }, 404);

    // Get assessment data
    const assessResult = await sql`SELECT id FROM assessments WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 1`;
    if (assessResult.rows.length === 0) return respond({ error: 'No assessment found' }, 404);
    const aid = assessResult.rows[0].id;

    // Get all responses for the detailed analysis
    const allRespResult = await sql`
      SELECT r.question_code, r.answer_raw, r.section_number, r.question_type, r.answer_matches_benchmark,
        resp.role, resp.role_category, resp.uuid as resp_uuid,
        q.question_text, q.benchmark_value, q.is_critical
      FROM responses r
      JOIN respondents resp ON r.respondent_id = resp.id
      JOIN questions q ON r.question_id = q.id
      WHERE r.assessment_id = ${aid} AND resp.status = 'completed'
      ORDER BY r.section_number, r.question_code
    `;

    // Get respondent profiles
    const respResult = await sql`SELECT * FROM respondents WHERE assessment_id = ${aid} AND status = 'completed'`;

    // Get emotional pulses
    const pulsesResult = await sql`
      SELECT ep.*, resp.uuid as resp_uuid, resp.role
      FROM emotional_pulses ep
      JOIN respondents resp ON ep.respondent_id = resp.id
      WHERE ep.assessment_id = ${aid} AND resp.status = 'completed'
    `;

    // Build comprehensive data payload
    const orgProfile = {
      name: org.name, type: org.org_type, irs: org.irs_classification,
      denomination: org.denomination, budget: org.annual_budget,
      staff_ft: org.employees_ft, staff_pt: org.employees_pt,
      contractors: org.contractors, volunteers: org.volunteers,
      city: org.address_city, state: org.address_state,
      founded: org.year_founded, payroll: org.payroll_method,
      last_audit: org.last_audit, federal_funding: org.federal_funding,
      endowment: org.endowment, gov_body: org.governing_body_type,
      board_current: org.board_members_current, board_min: org.board_members_min,
      board_max: org.board_members_max, finance_committee: org.finance_committee,
      finance_person: org.finance_person_type,
    };

    const sectionNames = ['','Leadership & Oversight','Systems & Technology','Bookkeeping & Monthly Finances','Donations, Revenue & Restricted Funds','Spending & Approvals','Payroll & People','Financial Reporting','Audits & Compliance','Policies & Documentation','Data Quality & Records','Cash, Banking & Reserves','Risk, Insurance & Safety','Budgeting & Planning'];

    // Build section detail data
    const sectionDetails = {};
    for (let sec = 1; sec <= 13; sec++) {
      const secResp = allRespResult.rows.filter(r => Number(r.section_number) === sec);
      const questions = {};
      for (const r of secResp) {
        if (!questions[r.question_code]) {
          questions[r.question_code] = {
            text: r.question_text, type: r.question_type,
            benchmark: r.benchmark_value, is_critical: r.is_critical,
            responses: []
          };
        }
        questions[r.question_code].responses.push({
          respondent: r.resp_uuid.slice(0, 4),
          role: r.role,
          answer: r.answer_raw,
          matches_benchmark: r.answer_matches_benchmark,
        });
      }
      sectionDetails[sec] = { name: sectionNames[sec], questions };
    }

    const respondentProfiles = respResult.rows.map(r => ({
      id: r.uuid.slice(0, 4), role: r.role, category: r.role_category,
      years: r.years_involved, health_rating: r.financial_health_rating,
      mission: (r.mission_description || '').slice(0, 300),
      highlight: (r.recent_highlight || '').slice(0, 300),
      concerns: (r.concerns_text || '').slice(0, 300),
    }));

    const payload = JSON.stringify({
      org: orgProfile,
      dashboard_report: {
        overall_score: dashReport.overall_score,
        risk_level: dashReport.risk_level,
        scores: dashReport.scores,
        priorities_list: dashReport.priorities_list,
        executive_summary: dashReport.executive_summary,
        emotion_totals: dashReport.emotion_totals,
        respondent_count: dashReport.respondent_count,
      },
      respondents: respondentProfiles,
      sections: sectionDetails,
    });

    // System prompt for comprehensive detailed report
    const systemPrompt = `You are a senior nonprofit financial consultant at Provident Strategic Advisers writing a comprehensive Financial Stewardship Assessment Report. This is a premium, detailed document meant to be delivered as a professional PDF to organizational leadership and board members.

DOCUMENT STRUCTURE — Write each section as continuous prose. Use the exact section headers provided. The report should read like a professional consulting deliverable.

Return ONLY valid JSON with this structure:
{
  "title": "Financial Stewardship Assessment Report",
  "subtitle": "Comprehensive Analysis & Recommendations",
  "org_name": "Organization Name",
  "date": "Month Year",
  "respondent_count": N,

  "cover_metrics": {
    "overall_score": 3.2,
    "risk_level": "Moderate",
    "audit_readiness": "Needs Attention",
    "respondent_count": N
  },

  "executive_summary": "3-4 substantial paragraphs (400-500 words total). Open with context (org type, size, respondent count, overall score). Identify the dominant theme. Support with specific evidence citing respondent counts. Highlight bright spots genuinely. Close with a forward-looking assessment of what improvement looks like.",

  "respondent_overview": {
    "narrative": "2-3 paragraphs analyzing role diversity, tenure spread, and perception gaps. If the person closest to finances rates health lower than leadership, flag as a key finding.",
    "profiles": [{"id":"R1","role":"Pastor","tenure":"8 years","health":"Good enough","alignment":"Strong"}]
  },

  "emotional_landscape": {
    "aggregate_narrative": "2-3 paragraphs interpreting the overall emotional profile. Which emotions dominate? Is the ratio of positive to negative concerning? What does the single most selected emotion signal?",
    "section_patterns": "2-3 paragraphs identifying which sections trigger the strongest emotional responses and what that means diagnostically.",
    "shift_narrative": "1-2 paragraphs on how sentiment shifted from start to end of the assessment."
  },

  "section_scorecard_narrative": "1-2 paragraphs summarizing the overall pattern across all 13 sections. Where is the org strongest? Where are the gaps? Are there clusters of weakness?",

  "sections": [
    {
      "number": 1,
      "title": "Leadership & Oversight",
      "score": 3.2,
      "priority": "MEDIUM",
      "analysis": "3-4 substantial paragraphs (300-400 words). Open with what the score means in context. Walk through the specific question responses that drove the score — cite respondent counts and specific answers. Identify what is working well with genuine specificity. Identify gaps and explain WHY they matter (not just that they exist). If respondents disagreed, explain the divergence. Close with the implications.",
      "strengths": ["Specific strength with evidence"],
      "concerns": ["Specific concern with why it matters"],
      "recommendations": [
        {"action": "Specific recommendation", "timeline": "0-90 days", "owner": "Board Chair", "why": "Brief rationale"}
      ],
      "emotional_note": "1-2 sentences on the emotional pulse data for this section."
    }
  ],

  "top_priorities": [
    {"rank": 1, "title": "Priority title", "urgency": "red", "timeline": "0-90 days", "description": "2-3 sentences with specific rationale and steps.", "owner": "Responsible role", "section_ref": 8}
  ],

  "key_person_risk": {
    "narrative": "2-3 paragraphs analyzing single points of failure in financial operations. Which functions depend on one person? What happens if they leave tomorrow?",
    "functions": [{"function": "Payroll Processing", "current_owner": "Office Manager", "documented": false, "backup": "None", "risk_level": "CRITICAL"}]
  },

  "mission_alignment": {
    "score": 4.2,
    "narrative": "2-3 paragraphs on how well financial practices align with stated mission. Synthesize respondent descriptions of mission and compare with financial reality.",
    "highlights": "Key observations about mission-money alignment."
  },

  "conclusion": "2-3 paragraphs. Summarize the path forward. Be encouraging but honest. Emphasize that every organization has gaps and that identifying them is the first step. Close with a concrete vision of what the organization looks like in 12 months if they act on the top priorities.",

  "appendix_methodology": "1-2 paragraphs explaining the scoring methodology, respondent anonymity, and how to interpret scores."
}

CRITICAL RULES:
- Every claim must trace to specific question responses in the data. Never fabricate findings.
- Cite respondent counts: "3 of 4 respondents indicated..." not "respondents indicated..."
- Paraphrase open-ended responses, never quote verbatim.
- Use pre-computed scores exactly as provided.
- Include all 13 sections in the sections array with detailed analysis.
- Tone: Direct but constructive. This is a tool for improvement, not judgment.
- Write for a board-level audience — professional, clear, no jargon.
- Total report should be 4,000-6,000 words — this is a premium deliverable.`;

    // Call Anthropic API with a larger model for quality
    const model = process.env.DETAILED_REPORT_MODEL || 'claude-sonnet-4-20250514';
    const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 16384,
        system: systemPrompt,
        messages: [
          { role: 'user', content: 'Generate the comprehensive detailed report for this organization.\n\n' + payload },
          { role: 'assistant', content: '{' }
        ]
      })
    });

    if (!apiResponse.ok) {
      const detail = await apiResponse.json().catch(() => ({}));
      return respond({ error: `AI API returned ${apiResponse.status}`, detail }, 502);
    }

    const apiData = await apiResponse.json();
    let text = '';
    for (const block of (apiData.content || [])) {
      if (block.text) text += block.text;
    }
    text = '{' + text;

    // Parse JSON
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      return respond({ error: 'No JSON in AI response', raw: text.slice(0, 500) }, 500);
    }
    text = text.slice(firstBrace, lastBrace + 1);

    let detailedReport;
    try {
      detailedReport = JSON.parse(text);
    } catch (e) {
      let cleaned = text.replace(/,\s*([}\]])/g, '$1').replace(/[\x00-\x1f\x7f]/g, c => c === '\n' || c === '\t' ? c : '');
      try {
        detailedReport = JSON.parse(cleaned);
      } catch (e2) {
        return respond({ error: 'Failed to parse AI response', parseError: e2.message, raw: text.slice(0, 500) }, 500);
      }
    }

    // Merge in computed data
    detailedReport.org_name = org.name;
    detailedReport.cover_metrics = detailedReport.cover_metrics || {};
    detailedReport.cover_metrics.overall_score = dashReport.overall_score;
    detailedReport.cover_metrics.risk_level = dashReport.risk_level;
    detailedReport.cover_metrics.respondent_count = dashReport.respondent_count;

    // Store the detailed report
    const rUuid = crypto.randomUUID();
    const tokens = apiData.usage?.output_tokens || null;
    const reportJson = JSON.stringify(detailedReport);
    await sql`INSERT INTO reports (uuid, assessment_id, org_id, report_json, ai_model, ai_tokens_used, respondent_count, overall_score, risk_level)
      VALUES (${rUuid}, ${aid}, ${orgId}, ${reportJson}, ${'detailed-' + model}, ${tokens}, ${dashReport.respondent_count}, ${dashReport.overall_score}, ${dashReport.risk_level})`;

    return respond({
      ok: true,
      report: { uuid: rUuid, report_json: detailedReport, created_at: new Date().toISOString() },
    });
  } catch (error) {
    console.error('Detailed report error:', error);
    return respond({ error: 'Server error: ' + error.message }, 500);
  }
}

import { sql } from '@vercel/postgres';
import { requireAuth, generateUUID, respond } from '../../../lib/auth';

async function getOrCreateResp(userId, orgId) {
  const a = await sql`SELECT id FROM assessments WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 1`;
  if (a.rows.length === 0) return null;
  const aid = a.rows[0].id;

  let r = await sql`SELECT * FROM respondents WHERE assessment_id = ${aid} AND user_id = ${userId}`;
  if (r.rows.length === 0) {
    const uuid = generateUUID();
    await sql`INSERT INTO respondents (uuid, assessment_id, org_id, user_id, status) VALUES (${uuid}, ${aid}, ${orgId}, ${userId}, 'invited')`;
    r = await sql`SELECT * FROM respondents WHERE assessment_id = ${aid} AND user_id = ${userId}`;
  }
  return r.rows[0];
}

export async function OPTIONS() {
  return new Response(null, { status: 200 });
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || '';
  const orgId = searchParams.get('org_id');

  // Questions - requires auth
  if (action === 'questions') {
    const user = await requireAuth(request);
    if (!user) return respond({ error: 'Not authenticated' }, 401);
    if (!orgId) return respond({ error: 'org_id required' }, 400);
    const trackResult = await sql`SELECT assessment_track FROM organizations WHERE id = ${orgId}`;
    const track = trackResult.rows[0]?.assessment_track || 'nonprofit';
    const qs = await sql`SELECT id, code, part, section_number, question_text, question_type, response_options, display_order, is_scorable, benchmark_value FROM questions WHERE assessment_track = ${track} AND version_retired IS NULL ORDER BY display_order`;
    return respond({ questions: qs.rows });
  }

  // Get my assessment data
  if (action === '' || action === null) {
    const user = await requireAuth(request);
    if (!user) return respond({ error: 'Not authenticated' }, 401);
    if (!orgId) return respond({ error: 'org_id required' }, 400);
    const resp = await getOrCreateResp(user.id, orgId);
    if (!resp) return respond({ error: 'No assessment found' }, 404);

    const answersResult = await sql`SELECT question_code, question_type, answer_raw, section_number FROM responses WHERE respondent_id = ${resp.id}`;
    const answers = {};
    for (const row of answersResult.rows) {
      answers[row.question_code] = row.answer_raw;
    }

    const pulsesResult = await sql`SELECT pulse_point, word_confident, word_concerned, word_overwhelmed, word_hopeful, word_uncertain, word_frustrated, word_encouraged, word_afraid, word_empowered, word_lost, why_text FROM emotional_pulses WHERE respondent_id = ${resp.id}`;
    const pulses = {};
    const wordKeys = ['confident','concerned','overwhelmed','hopeful','uncertain','frustrated','encouraged','afraid','empowered','lost'];
    for (const row of pulsesResult.rows) {
      const words = [];
      for (const w of wordKeys) {
        if (row['word_' + w]) words.push(w);
      }
      pulses[row.pulse_point] = { words, why: row.why_text };
    }

    return respond({ respondent: resp, answers, pulses });
  }

  // Invites list
  if (action === 'invites') {
    const user = await requireAuth(request);
    if (!user) return respond({ error: 'Not authenticated' }, 401);
    if (!orgId) return respond({ error: 'org_id required' }, 400);
    const inv = await sql`SELECT uuid, email, status, created_at FROM invites WHERE org_id = ${orgId} ORDER BY created_at DESC`;
    return respond({ invites: inv.rows });
  }

  // Respondents list (admin)
  if (action === 'respondents') {
    const user = await requireAuth(request);
    if (!user) return respond({ error: 'Not authenticated' }, 401);
    if (!orgId) return respond({ error: 'org_id required' }, 400);
    const ownerCheck = await sql`SELECT id FROM organizations WHERE id = ${orgId} AND owner_id = ${user.id}`;
    if (ownerCheck.rows.length === 0) return respond({ error: 'Admin only' }, 403);
    const a = await sql`SELECT id FROM assessments WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 1`;
    if (a.rows.length === 0) return respond({ respondents: [] });
    const r = await sql`SELECT uuid, role, role_category, status, progress_pct, financial_health_rating, started_at, completed_at FROM respondents WHERE assessment_id = ${a.rows[0].id}`;
    return respond({ respondents: r.rows });
  }

  return respond({ error: 'Bad request' }, 400);
}

export async function POST(request) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || '';
  const orgId = searchParams.get('org_id');
  const input = await request.json().catch(() => ({}));

  // Accept invite (public)
  if (action === 'accept_invite') {
    const token = input.token || '';
    if (!token) return respond({ error: 'Token required' }, 400);
    const inv = await sql`SELECT * FROM invites WHERE token = ${token} AND status = 'pending'`;
    if (inv.rows.length === 0) return respond({ error: 'Invalid invite' }, 404);
    const invite = inv.rows[0];
    await sql`UPDATE invites SET status = 'accepted', accepted_at = NOW() WHERE id = ${invite.id}`;
    return respond({ ok: true, org_id: Number(invite.org_id), assessment_id: Number(invite.assessment_id), email: invite.email });
  }

  const user = await requireAuth(request);
  if (!user) return respond({ error: 'Not authenticated' }, 401);
  if (!orgId && action !== 'accept_invite') return respond({ error: 'org_id required' }, 400);

  // Verify access
  const ownerCheck = await sql`SELECT id FROM organizations WHERE id = ${orgId} AND owner_id = ${user.id}`;
  const isOwner = ownerCheck.rows.length > 0;
  if (!isOwner) {
    const invCheck = await sql`SELECT id FROM invites WHERE org_id = ${orgId} AND email = ${user.email} AND status IN ('accepted','started','completed')`;
    if (invCheck.rows.length === 0) return respond({ error: 'Access denied' }, 403);
  }

  // Save profile
  if (action === 'profile') {
    const resp = await getOrCreateResp(user.id, orgId);
    if (!resp) return respond({ error: 'No assessment found' }, 404);

    let roleCat = 'other';
    const role = input.role || '';
    if (/Pastor|ED|CEO/i.test(role)) roleCat = 'executive';
    else if (/Board|Treasurer|Committee/i.test(role)) roleCat = 'governance';
    else if (/Finance|Bookkeeper|Account/i.test(role)) roleCat = 'finance';
    else if (/Admin|Program|Ministry|Ops/i.test(role)) roleCat = 'operations';
    else if (/Volunteer/i.test(role)) roleCat = 'volunteer';

    let finProx = 'none';
    const fi = input.finance_involvement || '';
    if (/manage/i.test(fi)) finProx = 'high';
    else if (/approve|review/i.test(fi)) finProx = 'medium';
    else if (/receive|department/i.test(fi)) finProx = 'low';

    let healthNum = 3;
    const h = input.financial_health_rating || '';
    if (h === 'Strong') healthNum = 5;
    else if (h === 'Good enough') healthNum = 4;
    else if (h === 'Not sure') healthNum = 3;
    else if (h === 'A little worried') healthNum = 2;
    else if (h === 'Very concerned') healthNum = 1;

    await sql`UPDATE respondents SET
      respondent_name = ${input.respondent_name || null},
      role = ${role},
      role_category = ${roleCat},
      years_involved = ${input.years_involved ? Number(input.years_involved) : null},
      paid_volunteer = ${input.paid_volunteer || null},
      finance_involvement = ${fi},
      finance_proximity = ${finProx},
      mission_description = ${input.mission_description || null},
      recent_highlight = ${input.recent_highlight || null},
      mission_alignment = ${input.mission_alignment ? Number(input.mission_alignment) : null},
      financial_health_rating = ${h},
      financial_health_numeric = ${healthNum},
      concerns_text = ${input.concerns_text || null},
      status = CASE WHEN status = 'invited' THEN 'profile_complete' ELSE status END,
      started_at = COALESCE(started_at, NOW()),
      consent_given_at = NOW()
      WHERE id = ${resp.id}`;
    return respond({ ok: true });
  }

  // Save answers
  if (action === 'save_answers') {
    const resp = await getOrCreateResp(user.id, orgId);
    if (!resp) return respond({ error: 'No assessment found' }, 404);
    const answers = input.answers || [];
    const aid = resp.assessment_id;

    for (const a of answers) {
      const code = a.code || '';
      let val = a.value;
      const sec = Number(a.section || 0);
      if (!code || val === '' || val === undefined) continue;

      const qResult = await sql`SELECT id, question_type, benchmark_value, is_critical, critical_condition FROM questions WHERE code = ${code} AND assessment_track = 'nonprofit' AND version_retired IS NULL LIMIT 1`;
      const q = qResult.rows[0];
      if (!q) continue;

      let norm = null;
      let match = null;
      const rawVal = Array.isArray(val) ? JSON.stringify(val) : String(val);

      if (q.question_type === 'yn' || q.question_type === 'select') {
        norm = String(val);
        if (q.benchmark_value) match = (String(val) === q.benchmark_value);
      } else if (q.question_type === 'select_multi') {
        norm = Array.isArray(val) ? val.join(',') : String(val);
      } else if (q.question_type === 'likert') {
        norm = String(val);
      }

      await sql`INSERT INTO responses (respondent_id, assessment_id, org_id, question_id, question_code, section_number, question_type, answer_raw, answer_normalized, answer_matches_benchmark)
        VALUES (${resp.id}, ${aid}, ${orgId}, ${q.id}, ${code}, ${sec}, ${q.question_type}, ${rawVal}, ${norm}, ${match})
        ON CONFLICT (respondent_id, question_code) DO UPDATE SET
        answer_raw = EXCLUDED.answer_raw, answer_normalized = EXCLUDED.answer_normalized, answer_matches_benchmark = EXCLUDED.answer_matches_benchmark, updated_at = NOW()`;

      // Handle multi-select selections
      if (q.question_type === 'select_multi' && Array.isArray(val)) {
        const respIdResult = await sql`SELECT id FROM responses WHERE respondent_id = ${resp.id} AND question_code = ${code}`;
        const rid = respIdResult.rows[0]?.id;
        if (rid) {
          await sql`DELETE FROM response_selections WHERE response_id = ${rid}`;
          for (const v of val) {
            await sql`INSERT INTO response_selections (response_id, selection_value) VALUES (${rid}, ${v})`;
          }
        }
      }
    }

    // Update progress
    const total = await sql`SELECT COUNT(*) as cnt FROM questions WHERE part = 'S' AND assessment_track = 'nonprofit' AND version_retired IS NULL`;
    const answered = await sql`SELECT COUNT(*) as cnt FROM responses WHERE respondent_id = ${resp.id} AND section_number BETWEEN 1 AND 13`;
    const totalCount = Number(total.rows[0].cnt) || 1;
    const answeredCount = Number(answered.rows[0].cnt);
    const pct = Math.min(100, Math.round(answeredCount / totalCount * 100));
    const sec = answers.length > 0 ? Number(answers[answers.length - 1].section || 0) : 0;

    await sql`UPDATE respondents SET progress_pct = ${pct}, current_section = ${sec}, status = CASE WHEN status IN ('invited','profile_complete') THEN 'in_progress' ELSE status END WHERE id = ${resp.id}`;
    return respond({ ok: true, progress: pct });
  }

  // Save pulse
  if (action === 'save_pulse') {
    const resp = await getOrCreateResp(user.id, orgId);
    if (!resp) return respond({ error: 'No assessment found' }, 404);
    const point = input.pulse_point || '';
    const words = input.words || [];
    const why = input.why || '';
    const secNum = input.section_number || null;
    if (!point) return respond({ error: 'pulse_point required' }, 400);

    const vmap = { confident:0.7, concerned:-0.4, overwhelmed:-0.6, hopeful:0.5, uncertain:-0.2, frustrated:-0.7, encouraged:0.6, afraid:-0.8, empowered:0.8, lost:-0.5 };
    const amap = { confident:0.5, concerned:0.5, overwhelmed:0.8, hopeful:0.4, uncertain:0.3, frustrated:0.7, encouraged:0.5, afraid:0.9, empowered:0.6, lost:0.2 };
    const wordKeys = ['confident','concerned','overwhelmed','hopeful','uncertain','frustrated','encouraged','afraid','empowered','lost'];

    const wBools = {};
    let valSum = 0, aroSum = 0;
    for (const w of wordKeys) {
      const sel = words.includes(w);
      wBools[w] = sel;
      if (sel) { valSum += vmap[w]; aroSum += amap[w]; }
    }
    const cnt = words.length;
    const valence = cnt > 0 ? Math.round(valSum / cnt * 100) / 100 : null;
    const arousal = cnt > 0 ? Math.round(aroSum / cnt * 100) / 100 : null;

    await sql`INSERT INTO emotional_pulses (respondent_id, assessment_id, org_id, pulse_point, section_number,
      word_confident, word_concerned, word_overwhelmed, word_hopeful, word_uncertain, word_frustrated, word_encouraged, word_afraid, word_empowered, word_lost,
      words_selected, valence_score, arousal_score, why_text)
      VALUES (${resp.id}, ${resp.assessment_id}, ${orgId}, ${point}, ${secNum},
      ${wBools.confident}, ${wBools.concerned}, ${wBools.overwhelmed}, ${wBools.hopeful}, ${wBools.uncertain}, ${wBools.frustrated}, ${wBools.encouraged}, ${wBools.afraid}, ${wBools.empowered}, ${wBools.lost},
      ${cnt}, ${valence}, ${arousal}, ${why})
      ON CONFLICT (respondent_id, pulse_point) DO UPDATE SET
      word_confident=EXCLUDED.word_confident, word_concerned=EXCLUDED.word_concerned, word_overwhelmed=EXCLUDED.word_overwhelmed, word_hopeful=EXCLUDED.word_hopeful, word_uncertain=EXCLUDED.word_uncertain, word_frustrated=EXCLUDED.word_frustrated, word_encouraged=EXCLUDED.word_encouraged, word_afraid=EXCLUDED.word_afraid, word_empowered=EXCLUDED.word_empowered, word_lost=EXCLUDED.word_lost,
      words_selected=EXCLUDED.words_selected, valence_score=EXCLUDED.valence_score, arousal_score=EXCLUDED.arousal_score, why_text=EXCLUDED.why_text`;
    return respond({ ok: true });
  }

  // Complete assessment
  if (action === 'complete') {
    const resp = await getOrCreateResp(user.id, orgId);
    if (!resp) return respond({ error: 'No assessment found' }, 404);
    const er = input.experience_rating || null;
    await sql`UPDATE respondents SET status = 'completed', completed_at = NOW(), experience_rating = ${er}, progress_pct = 100 WHERE id = ${resp.id}`;
    await sql`UPDATE assessments SET respondent_completed = respondent_completed + 1 WHERE id = ${resp.assessment_id}`;
    return respond({ ok: true });
  }

  // Create invite
  if (action === 'invite') {
    if (!isOwner) return respond({ error: 'Admin only' }, 403);
    const email = (input.email || '').toLowerCase().trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return respond({ error: 'Valid email required' }, 400);
    const aResult = await sql`SELECT id FROM assessments WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 1`;
    if (aResult.rows.length === 0) return respond({ error: 'No assessment' }, 404);
    const aid = aResult.rows[0].id;
    const existingInv = await sql`SELECT id FROM invites WHERE org_id = ${orgId} AND email = ${email} AND status NOT IN ('expired','revoked')`;
    if (existingInv.rows.length > 0) return respond({ error: 'Already invited' }, 409);
    const token = generateUUID().replace(/-/g, '') + generateUUID().replace(/-/g, '');
    const uuid = generateUUID();
    await sql`INSERT INTO invites (uuid, org_id, assessment_id, invited_by, email, token, expires_at) VALUES (${uuid}, ${orgId}, ${aid}, ${user.id}, ${email}, ${token}, NOW() + INTERVAL '30 days')`;
    const invResult = await sql`SELECT id FROM invites WHERE token = ${token}`;
    const rUuid = generateUUID();
    await sql`INSERT INTO respondents (uuid, assessment_id, org_id, invite_id, status) VALUES (${rUuid}, ${aid}, ${orgId}, ${invResult.rows[0].id}, 'invited')`;
    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    return respond({ ok: true, invite_url: `${appUrl}/?invite=${token}`, token }, 201);
  }

  return respond({ error: 'Bad request' }, 400);
}

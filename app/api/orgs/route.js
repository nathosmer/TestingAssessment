import { sql } from '@vercel/postgres';
import { requireAuth, generateUUID, respond } from '../../../lib/auth';

const ORG_FIELDS = ['org_type','annual_budget','employees_ft','employees_pt','contractors','volunteers','locations',
  'address_street','address_city','address_state','address_zip','year_founded',
  'irs_classification','denomination','payroll_method','last_audit','federal_funding','endowment',
  'governing_body_type','board_members_current','board_members_min','board_members_max',
  'finance_committee','finance_person_type'];

export async function OPTIONS() {
  return new Response(null, { status: 200 });
}

export async function GET(request) {
  try {
    const user = await requireAuth(request);
    if (!user) return respond({ error: 'Not authenticated' }, 401);
    const { searchParams } = new URL(request.url);
    const orgId = searchParams.get('id');

    if (!orgId) {
      const result = await sql`
        SELECT o.*, (SELECT COUNT(*) FROM assessments WHERE org_id = o.id) as assessment_count
        FROM organizations o WHERE o.owner_id = ${user.id} AND o.deleted_at IS NULL
        ORDER BY o.updated_at DESC
      `;
      return respond({ orgs: result.rows });
    }

    const result = await sql`SELECT * FROM organizations WHERE id = ${orgId} AND owner_id = ${user.id} AND deleted_at IS NULL`;
    const org = result.rows[0];
    if (!org) return respond({ error: 'Not found' }, 404);

    const assessment = await sql`SELECT id, uuid, status, respondent_completed, overall_score, risk_level, created_at FROM assessments WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 1`;
    org.latest_assessment = assessment.rows[0] || null;

    if (org.latest_assessment) {
      const stats = await sql`SELECT status, COUNT(*) as cnt FROM respondents WHERE assessment_id = ${org.latest_assessment.id} GROUP BY status`;
      org.respondent_stats = stats.rows;
    }

    return respond({ org });
  } catch (error) {
    console.error('GET orgs error:', error);
    return respond({ error: 'Server error' }, 500);
  }
}

export async function POST(request) {
  try {
    const user = await requireAuth(request);
    if (!user) return respond({ error: 'Not authenticated' }, 401);
    const input = await request.json().catch(() => ({}));
    const name = (input.name || '').trim();
    if (!name) return respond({ error: 'Name required' }, 400);

    const uuid = generateUUID();

    // Build dynamic insert (C-03)
    // ORG_FIELDS is the allowlist of permitted fields
    const cols = ['uuid', 'owner_id', 'name'];
    const vals = [uuid, user.id, name];

    for (const f of ORG_FIELDS) {
      if (input[f] !== undefined && input[f] !== null && input[f] !== '') {
        cols.push(f);
        vals.push(input[f]);
      }
    }

    const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
    const queryText = `INSERT INTO organizations (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`;
    const orgResult = await sql.query(queryText, vals);
    const orgId = orgResult.rows[0].id;

    // Create assessment
    const aUuid = generateUUID();
    const assessResult = await sql`INSERT INTO assessments (uuid, org_id, initiated_by, status) VALUES (${aUuid}, ${orgId}, ${user.id}, 'active') RETURNING id`;
    const aId = assessResult.rows[0].id;

    // Create respondent for admin
    const rUuid = generateUUID();
    await sql`INSERT INTO respondents (uuid, assessment_id, org_id, user_id, status) VALUES (${rUuid}, ${aId}, ${orgId}, ${user.id}, 'invited')`;

    const org = await sql`SELECT * FROM organizations WHERE id = ${orgId}`;
    return respond({ org: org.rows[0] }, 201);
  } catch (error) {
    console.error('POST orgs error:', error);
    return respond({ error: 'Server error' }, 500);
  }
}

export async function PUT(request) {
  try {
    const user = await requireAuth(request);
    if (!user) return respond({ error: 'Not authenticated' }, 401);
    const { searchParams } = new URL(request.url);
    const orgId = searchParams.get('id');
    if (!orgId) return respond({ error: 'id required' }, 400);

    const check = await sql`SELECT id FROM organizations WHERE id = ${orgId} AND owner_id = ${user.id}`;
    if (check.rows.length === 0) return respond({ error: 'Not found' }, 404);

    const input = await request.json().catch(() => ({}));
    const sets = [];
    const vals = [];
    let paramIdx = 1;

    if (input.name) {
      sets.push(`name = $${paramIdx++}`);
      vals.push(input.name.trim());
    }
    for (const f of ORG_FIELDS) {
      if (input[f] !== undefined) {
        sets.push(`${f} = $${paramIdx++}`);
        vals.push(input[f]);
      }
    }
    if (sets.length === 0) return respond({ error: 'Nothing to update' }, 400);

    sets.push(`updated_at = NOW()`);
    vals.push(orgId);
    const queryText = `UPDATE organizations SET ${sets.join(', ')} WHERE id = $${paramIdx}`;
    await sql.query(queryText, vals);

    const org = await sql`SELECT * FROM organizations WHERE id = ${orgId}`;
    return respond({ org: org.rows[0] });
  } catch (error) {
    console.error('PUT orgs error:', error);
    return respond({ error: 'Server error' }, 500);
  }
}

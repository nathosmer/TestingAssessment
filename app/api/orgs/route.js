import { sql } from '@vercel/postgres';
import { requireAuth, generateUUID, respond, checkOrgAccess, getOrgRole } from '../../../lib/auth';

const ORG_FIELDS = ['org_type','annual_budget','employees_ft','employees_pt','contractors','volunteers','locations',
  'address_street','address_city','address_state','address_zip','year_founded',
  'irs_classification','denomination','payroll_method','last_audit','federal_funding','endowment',
  'governing_body_type','board_members_current','board_members_min','board_members_max',
  'finance_committee','finance_person_type'];

export async function OPTIONS() {
  return new Response(null, { status: 200 });
}

export async function GET(request) {
  const user = await requireAuth(request);
  if (!user) return respond({ error: 'Not authenticated' }, 401);
  const { searchParams } = new URL(request.url);
  const orgId = searchParams.get('id');

  if (!orgId) {
    // List orgs — try org_members join first, fall back to owner_id
    let result;
    try {
      if (user.site_role === 'super_admin') {
        result = await sql`
          SELECT o.*, 'super_admin' as my_role,
            (SELECT COUNT(*) FROM assessments WHERE org_id = o.id) as assessment_count
          FROM organizations o WHERE o.deleted_at IS NULL
          ORDER BY o.updated_at DESC
        `;
      } else {
        result = await sql`
          SELECT o.*, om.role as my_role,
            (SELECT COUNT(*) FROM assessments WHERE org_id = o.id) as assessment_count
          FROM organizations o
          JOIN org_members om ON om.org_id = o.id AND om.user_id = ${user.id}
          WHERE o.deleted_at IS NULL
          ORDER BY o.updated_at DESC
        `;
      }
    } catch (e) {
      // org_members table may not exist yet — fall back to owner_id
      result = await sql`
        SELECT o.*, 'admin' as my_role,
          (SELECT COUNT(*) FROM assessments WHERE org_id = o.id) as assessment_count
        FROM organizations o WHERE o.owner_id = ${user.id} AND o.deleted_at IS NULL
        ORDER BY o.updated_at DESC
      `;
    }
    return respond({ orgs: result.rows });
  }

  // Single org detail — try RBAC check, fall back to owner check
  let access;
  try {
    access = await checkOrgAccess(user, orgId, ['admin', 'respondent', 'viewer']);
  } catch (e) {
    // org_members table may not exist — check ownership instead
    const ownerCheck = await sql`SELECT id FROM organizations WHERE id = ${orgId} AND owner_id = ${user.id}`;
    access = ownerCheck.rows.length > 0 ? { allowed: true, role: 'admin' } : { allowed: false, role: null };
  }
  if (!access.allowed) return respond({ error: 'Access denied' }, 403);

  const result = await sql`SELECT * FROM organizations WHERE id = ${orgId} AND deleted_at IS NULL`;
  const org = result.rows[0];
  if (!org) return respond({ error: 'Not found' }, 404);

  org.my_role = access.role;

  const assessment = await sql`SELECT id, uuid, status, respondent_completed, overall_score, risk_level, created_at FROM assessments WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 1`;
  org.latest_assessment = assessment.rows[0] || null;

  if (org.latest_assessment) {
    const stats = await sql`SELECT status, COUNT(*) as cnt FROM respondents WHERE assessment_id = ${org.latest_assessment.id} GROUP BY status`;
    org.respondent_stats = stats.rows;
  }

  // Include org members list for admins (if table exists)
  if (access.role === 'admin' || access.role === 'super_admin') {
    try {
      const members = await sql`
        SELECT om.id, om.user_id, om.role, om.created_at, u.name, u.email
        FROM org_members om JOIN users u ON om.user_id = u.id
        WHERE om.org_id = ${orgId}
        ORDER BY om.role, u.name
      `;
      org.members = members.rows;
    } catch (e) {
      org.members = [];
    }
  }

  return respond({ org });
}

export async function POST(request) {
  try {
    const user = await requireAuth(request);
    if (!user) return respond({ error: 'Not authenticated' }, 401);
    const input = await request.json().catch(() => ({}));
    const name = (input.name || '').trim();
    if (!name) return respond({ error: 'Name required' }, 400);

    const uuid = generateUUID();

    // Build dynamic insert
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

    // Create org_member entry for creator as admin (table may not exist yet)
    try {
      await sql`INSERT INTO org_members (user_id, org_id, role) VALUES (${user.id}, ${orgId}, 'admin')`;
    } catch (e) {
      console.warn('org_members insert skipped (table may not exist):', e.message);
    }

    // Create assessment
    const aUuid = generateUUID();
    const assessResult = await sql`INSERT INTO assessments (uuid, org_id, initiated_by, status) VALUES (${aUuid}, ${orgId}, ${user.id}, 'active') RETURNING id`;
    const aId = assessResult.rows[0].id;

    // Create respondent for creator
    const rUuid = generateUUID();
    await sql`INSERT INTO respondents (uuid, assessment_id, org_id, user_id, status) VALUES (${rUuid}, ${aId}, ${orgId}, ${user.id}, 'invited')`;

    const org = await sql`SELECT * FROM organizations WHERE id = ${orgId}`;
    return respond({ org: org.rows[0] }, 201);
  } catch (error) {
    console.error('Create org error:', error);
    return respond({ error: 'Server error: ' + error.message }, 500);
  }
}

export async function PUT(request) {
  const user = await requireAuth(request);
  if (!user) return respond({ error: 'Not authenticated' }, 401);
  const { searchParams } = new URL(request.url);
  const orgId = searchParams.get('id');
  if (!orgId) return respond({ error: 'id required' }, 400);

  // Only admins and super admins can edit org settings
  const access = await checkOrgAccess(user, orgId, ['admin']);
  if (!access.allowed) return respond({ error: 'Access denied' }, 403);

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
}

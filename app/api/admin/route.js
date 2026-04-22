import { sql } from '@vercel/postgres';
import { requireSuperAdmin, requireAuth, generateToken, respond } from '../../../lib/auth';

export async function OPTIONS() {
  return new Response(null, { status: 200 });
}

export async function GET(request) {
  const admin = await requireSuperAdmin(request);
  if (!admin) return respond({ error: 'Forbidden' }, 403);

  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || '';

  // List all organizations with stats
  if (action === 'orgs') {
    const result = await sql`
      SELECT o.*,
        u.name as owner_name, u.email as owner_email,
        (SELECT COUNT(*) FROM assessments WHERE org_id = o.id) as assessment_count,
        (SELECT COUNT(*) FROM org_members WHERE org_id = o.id) as member_count,
        (SELECT overall_score FROM assessments WHERE org_id = o.id ORDER BY created_at DESC LIMIT 1) as latest_score,
        (SELECT risk_level FROM assessments WHERE org_id = o.id ORDER BY created_at DESC LIMIT 1) as latest_risk
      FROM organizations o
      LEFT JOIN users u ON o.owner_id = u.id
      WHERE o.deleted_at IS NULL
      ORDER BY o.updated_at DESC
    `;
    return respond({ orgs: result.rows });
  }

  // List all users
  if (action === 'users') {
    const result = await sql`
      SELECT u.id, u.uuid, u.name, u.email, u.site_role, u.created_at, u.last_login_at, u.deleted_at,
        (SELECT COUNT(*) FROM org_members WHERE user_id = u.id) as org_count,
        (SELECT COUNT(*) FROM respondents WHERE user_id = u.id AND status = 'completed') as completed_assessments
      FROM users u
      ORDER BY u.created_at DESC
    `;
    return respond({ users: result.rows });
  }

  // View members of a specific org
  if (action === 'org_members') {
    const orgId = searchParams.get('org_id');
    if (!orgId) return respond({ error: 'org_id required' }, 400);
    const result = await sql`
      SELECT om.*, u.name, u.email, u.last_login_at,
        (SELECT status FROM respondents WHERE user_id = om.user_id AND org_id = om.org_id ORDER BY created_at DESC LIMIT 1) as respondent_status
      FROM org_members om
      JOIN users u ON om.user_id = u.id
      WHERE om.org_id = ${orgId}
      ORDER BY om.role, u.name
    `;
    return respond({ members: result.rows });
  }

  // Platform stats
  if (action === 'stats') {
    const users = await sql`SELECT COUNT(*) as total, COUNT(CASE WHEN deleted_at IS NULL THEN 1 END) as active FROM users`;
    const orgs = await sql`SELECT COUNT(*) as total FROM organizations WHERE deleted_at IS NULL`;
    const assessments = await sql`SELECT COUNT(*) as total, COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed FROM assessments`;
    const reports = await sql`SELECT COUNT(*) as total FROM reports`;
    return respond({
      stats: {
        users: users.rows[0],
        orgs: orgs.rows[0],
        assessments: assessments.rows[0],
        reports: reports.rows[0]
      }
    });
  }

  return respond({ error: 'Unknown action' }, 400);
}

export async function POST(request) {
  const admin = await requireSuperAdmin(request);
  if (!admin) return respond({ error: 'Forbidden' }, 403);

  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || '';
  const input = await request.json().catch(() => ({}));

  // Deactivate a user (soft delete)
  if (action === 'deactivate_user') {
    const userId = input.user_id;
    if (!userId) return respond({ error: 'user_id required' }, 400);
    // Prevent deactivating yourself
    if (Number(userId) === admin.id) return respond({ error: 'Cannot deactivate yourself' }, 400);
    await sql`UPDATE users SET deleted_at = NOW() WHERE id = ${userId} AND deleted_at IS NULL`;
    await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
    return respond({ ok: true });
  }

  // Reactivate a user
  if (action === 'reactivate_user') {
    const userId = input.user_id;
    if (!userId) return respond({ error: 'user_id required' }, 400);
    await sql`UPDATE users SET deleted_at = NULL WHERE id = ${userId}`;
    return respond({ ok: true });
  }

  // Change a user's site role
  if (action === 'set_site_role') {
    const userId = input.user_id;
    const role = input.role;
    if (!userId || !role) return respond({ error: 'user_id and role required' }, 400);
    if (!['super_admin', 'user'].includes(role)) return respond({ error: 'Invalid role' }, 400);
    if (Number(userId) === admin.id) return respond({ error: 'Cannot change your own site role' }, 400);
    await sql`UPDATE users SET site_role = ${role} WHERE id = ${userId}`;
    return respond({ ok: true });
  }

  // Impersonate: generate a session for another user (for debugging)
  if (action === 'impersonate') {
    const userId = input.user_id;
    if (!userId) return respond({ error: 'user_id required' }, 400);
    const userResult = await sql`SELECT id, uuid, name, email, site_role FROM users WHERE id = ${userId} AND deleted_at IS NULL`;
    const u = userResult.rows[0];
    if (!u) return respond({ error: 'User not found' }, 404);
    const token = generateToken();
    const exp = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour only
    await sql`INSERT INTO sessions (user_id, token, expires_at) VALUES (${u.id}, ${token}, ${exp})`;
    return respond({ user: u, token, expires_at: exp, notice: 'Impersonation session expires in 1 hour' });
  }

  // Set org member role (super admin can change any org membership)
  if (action === 'set_org_role') {
    const userId = input.user_id;
    const orgId = input.org_id;
    const role = input.role;
    if (!userId || !orgId || !role) return respond({ error: 'user_id, org_id, and role required' }, 400);
    if (!['admin', 'respondent', 'viewer'].includes(role)) return respond({ error: 'Invalid role' }, 400);
    await sql`
      INSERT INTO org_members (user_id, org_id, role, invited_by)
      VALUES (${userId}, ${orgId}, ${role}, ${admin.id})
      ON CONFLICT (user_id, org_id) DO UPDATE SET role = ${role}, updated_at = NOW()
    `;
    return respond({ ok: true });
  }

  return respond({ error: 'Unknown action' }, 400);
}

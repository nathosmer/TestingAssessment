import { sql } from '@vercel/postgres';

export function generateUUID() {
  return crypto.randomUUID();
}

export function generateToken() {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Authenticate request and return user object with site_role.
 * Returns null if not authenticated.
 */
export async function requireAuth(request) {
  let token = '';
  const authHeader = request.headers.get('authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  }
  if (!token) {
    const cookie = request.headers.get('cookie') || '';
    const match = cookie.match(/prov_token=([^;]+)/);
    if (match) token = match[1];
  }
  if (!token) {
    return null;
  }
  let user;
  try {
    const result = await sql`
      SELECT u.id, u.name, u.email, u.uuid, u.site_role
      FROM sessions s JOIN users u ON s.user_id = u.id
      WHERE s.token = ${token} AND s.expires_at > NOW()
    `;
    user = result.rows[0] || null;
  } catch (e) {
    // site_role column may not exist yet
    const result = await sql`
      SELECT u.id, u.name, u.email, u.uuid
      FROM sessions s JOIN users u ON s.user_id = u.id
      WHERE s.token = ${token} AND s.expires_at > NOW()
    `;
    user = result.rows[0] || null;
  }
  // Default site_role for users created before migration
  if (user && !user.site_role) user.site_role = 'user';
  return user;
}

/**
 * Check if user is a super admin. Returns the user object or null.
 */
export async function requireSuperAdmin(request) {
  const user = await requireAuth(request);
  if (!user) return null;
  if (user.site_role !== 'super_admin') return null;
  return user;
}

/**
 * Get a user's role within an organization.
 * Super admins get 'super_admin' which bypasses all org checks.
 * Returns: 'super_admin' | 'admin' | 'respondent' | 'viewer' | null
 */
export async function getOrgRole(userId, orgId, siteRole) {
  if (siteRole === 'super_admin') return 'super_admin';
  const result = await sql`
    SELECT role FROM org_members WHERE user_id = ${userId} AND org_id = ${orgId}
  `;
  return result.rows[0]?.role || null;
}

/**
 * Permission check: does the user have one of the allowed roles for this org?
 * Usage: const access = await checkOrgAccess(user, orgId, ['admin', 'respondent']);
 * Returns { allowed: true, role: 'admin' } or { allowed: false, role: null }
 */
export async function checkOrgAccess(user, orgId, allowedRoles) {
  const role = await getOrgRole(user.id, orgId, user.site_role);
  if (!role) return { allowed: false, role: null };
  // super_admin always passes
  if (role === 'super_admin') return { allowed: true, role: 'super_admin' };
  if (allowedRoles.includes(role)) return { allowed: true, role };
  return { allowed: false, role };
}

// Role hierarchy for comparison
const ROLE_LEVELS = { super_admin: 4, admin: 3, respondent: 2, viewer: 1 };

/**
 * Check if roleA has at least the same level as roleB.
 */
export function hasRoleLevel(roleA, minRole) {
  return (ROLE_LEVELS[roleA] || 0) >= (ROLE_LEVELS[minRole] || 0);
}

export function setAuthCookie(response, token) {
  const maxAge = 60 * 60 * 24 * 30; // 30 days
  response.headers.set(
    'Set-Cookie',
    `prov_token=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`
  );
  return response;
}

export function clearAuthCookie(response) {
  response.headers.set(
    'Set-Cookie',
    'prov_token=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
  );
  return response;
}

export function respond(data, status = 200) {
  return Response.json(data, { status });
}

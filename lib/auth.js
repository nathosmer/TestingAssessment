import { sql } from '@vercel/postgres';

export function generateUUID() {
  return crypto.randomUUID();
}

export function generateToken() {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

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
  const result = await sql`
    SELECT u.id, u.name, u.email, u.uuid
    FROM sessions s JOIN users u ON s.user_id = u.id
    WHERE s.token = ${token} AND s.expires_at > NOW()
  `;
  return result.rows[0] || null;
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

export function respond(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers });
}

export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  };
}

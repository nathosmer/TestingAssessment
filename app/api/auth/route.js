import { sql } from '@vercel/postgres';
import bcrypt from 'bcryptjs';
import { generateUUID, generateToken, respond } from '../../../lib/auth';

const SESSION_LIFETIME_SECONDS = 60 * 60 * 24 * 30; // 30 days

export async function OPTIONS() {
  return new Response(null, { status: 200 });
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || '';

  if (action === 'check') {
    let token = '';
    const authHeader = request.headers.get('authorization') || '';
    if (authHeader.startsWith('Bearer ')) token = authHeader.slice(7);
    if (!token) {
      const cookie = request.headers.get('cookie') || '';
      const match = cookie.match(/prov_token=([^;]+)/);
      if (match) token = match[1];
    }
    if (!token) return respond({ authenticated: false });
    const result = await sql`
      SELECT u.id, u.uuid, u.name, u.email
      FROM sessions s JOIN users u ON s.user_id = u.id
      WHERE s.token = ${token} AND s.expires_at > NOW()
    `;
    const u = result.rows[0];
    if (!u) return respond({ authenticated: false });
    return respond({ authenticated: true, user: u, token });
  }

  return respond({ error: 'Unknown action' }, 400);
}

export async function POST(request) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || '';
  const input = await request.json().catch(() => ({}));

  if (action === 'register') {
    const name = (input.name || '').trim();
    const email = (input.email || '').toLowerCase().trim();
    const pass = input.password || '';
    if (!name || !email || !pass) return respond({ error: 'All fields required' }, 400);
    if (pass.length < 4) return respond({ error: 'Password too short' }, 400);
    const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
    if (existing.rows.length > 0) return respond({ error: 'Email already exists' }, 409);
    const hash = await bcrypt.hash(pass, 10);
    const uuid = generateUUID();
    const userResult = await sql`INSERT INTO users (uuid, email, password_hash, name) VALUES (${uuid}, ${email}, ${hash}, ${name}) RETURNING id`;
    const userId = userResult.rows[0].id;
    const token = generateToken();
    const exp = new Date(Date.now() + SESSION_LIFETIME_SECONDS * 1000).toISOString();
    await sql`INSERT INTO sessions (user_id, token, expires_at) VALUES (${userId}, ${token}, ${exp})`;
    return respond({ user: { id: Number(userId), uuid, name, email }, token }, 201);
  }

  if (action === 'login') {
    const email = (input.email || '').toLowerCase().trim();
    const pass = input.password || '';
    if (!email || !pass) return respond({ error: 'Email and password required' }, 400);
    const result = await sql`SELECT id, uuid, name, email, password_hash FROM users WHERE email = ${email} AND deleted_at IS NULL`;
    const u = result.rows[0];
    if (!u || !(await bcrypt.compare(pass, u.password_hash))) return respond({ error: 'Invalid credentials' }, 401);
    await sql`DELETE FROM sessions WHERE user_id = ${u.id} AND expires_at < NOW()`;
    const token = generateToken();
    const exp = new Date(Date.now() + SESSION_LIFETIME_SECONDS * 1000).toISOString();
    await sql`INSERT INTO sessions (user_id, token, expires_at) VALUES (${u.id}, ${token}, ${exp})`;
    await sql`UPDATE users SET last_login_at = NOW() WHERE id = ${u.id}`;
    return respond({ user: { id: Number(u.id), uuid: u.uuid, name: u.name, email: u.email }, token });
  }

  if (action === 'logout') {
    let token = '';
    const authHeader = request.headers.get('authorization') || '';
    if (authHeader.startsWith('Bearer ')) token = authHeader.slice(7);
    if (!token) {
      const cookie = request.headers.get('cookie') || '';
      const match = cookie.match(/prov_token=([^;]+)/);
      if (match) token = match[1];
    }
    if (token) await sql`DELETE FROM sessions WHERE token = ${token}`;
    return respond({ ok: true });
  }

  return respond({ error: 'Unknown action' }, 400);
}

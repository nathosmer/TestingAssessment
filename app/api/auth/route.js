import { sql } from '@vercel/postgres';
import bcrypt from 'bcryptjs';
import { generateUUID, generateToken, respond, setAuthCookie, clearAuthCookie } from '../../../lib/auth';
import { sendResetEmail } from '../../../lib/email';

const SESSION_LIFETIME_SECONDS = 60 * 60 * 24 * 30; // 30 days

// One-time migration flag — ensures columns exist on first request
let columnsVerified = false;
async function ensureColumns() {
  if (columnsVerified) return;
  try {
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS site_role VARCHAR(20) DEFAULT 'user'`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ DEFAULT NULL`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token VARCHAR(100) DEFAULT NULL`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ DEFAULT NULL`;
    columnsVerified = true;
  } catch (e) {
    // If ALTER fails (permissions), assume columns already exist
    console.warn('Column check skipped:', e.message);
    columnsVerified = true;
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 200 });
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || '';

  if (action === 'check') {
    try {
      let token = '';
      const authHeader = request.headers.get('authorization') || '';
      if (authHeader.startsWith('Bearer ')) token = authHeader.slice(7);
      if (!token) {
        const cookie = request.headers.get('cookie') || '';
        const match = cookie.match(/prov_token=([^;]+)/);
        if (match) token = match[1];
      }
      if (!token) return respond({ authenticated: false });

      // Try with site_role first, fall back to without it
      let u;
      try {
        const result = await sql`
          SELECT u.id, u.uuid, u.name, u.email, u.site_role
          FROM sessions s JOIN users u ON s.user_id = u.id
          WHERE s.token = ${token} AND s.expires_at > NOW()
        `;
        u = result.rows[0];
      } catch (e) {
        // site_role column may not exist yet
        const result = await sql`
          SELECT u.id, u.uuid, u.name, u.email
          FROM sessions s JOIN users u ON s.user_id = u.id
          WHERE s.token = ${token} AND s.expires_at > NOW()
        `;
        u = result.rows[0];
      }
      if (!u) return respond({ authenticated: false });
      if (!u.site_role) u.site_role = 'user';

      // Clean up expired sessions
      try {
        await sql`DELETE FROM sessions WHERE expires_at < NOW()`;
      } catch (e) {
        console.error('Session cleanup error:', e);
      }

      return respond({ authenticated: true, user: u, token });
    } catch (error) {
      console.error('Check auth error:', error);
      return respond({ error: 'Server error' }, 500);
    }
  }

  return respond({ error: 'Unknown action' }, 400);
}

export async function POST(request) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || '';
  const input = await request.json().catch(() => ({}));

  if (action === 'register') {
    try {
      const name = (input.name || '').trim();
      const email = (input.email || '').toLowerCase().trim();
      const pass = input.password || '';
      if (!name || !email || !pass) return respond({ error: 'All fields required' }, 400);
      if (pass.length < 8) return respond({ error: 'Password too short' }, 400);
      const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
      if (existing.rows.length > 0) return respond({ error: 'Email already exists' }, 409);
      const hash = await bcrypt.hash(pass, 10);
      const uuid = generateUUID();
      const userResult = await sql`INSERT INTO users (uuid, email, password_hash, name) VALUES (${uuid}, ${email}, ${hash}, ${name}) RETURNING id`;
      const userId = userResult.rows[0].id;
      const token = generateToken();
      const exp = new Date(Date.now() + SESSION_LIFETIME_SECONDS * 1000).toISOString();
      await sql`INSERT INTO sessions (user_id, token, expires_at) VALUES (${userId}, ${token}, ${exp})`;
      let resp = respond({ user: { id: Number(userId), uuid, name, email, site_role: 'user' }, token }, 201);
      resp = setAuthCookie(resp, token);
      return resp;
    } catch (error) {
      console.error('Register error:', error);
      return respond({ error: 'Server error' }, 500);
    }
  }

  if (action === 'login') {
    try {
      const email = (input.email || '').toLowerCase().trim();
      const pass = input.password || '';
      if (!email || !pass) return respond({ error: 'Email and password required' }, 400);

      // Try with new columns first, fall back to basic query
      let u;
      try {
        const result = await sql`SELECT id, uuid, name, email, password_hash, site_role FROM users WHERE email = ${email} AND deleted_at IS NULL`;
        u = result.rows[0];
      } catch (e) {
        // site_role or deleted_at column may not exist yet
        const result = await sql`SELECT id, uuid, name, email, password_hash FROM users WHERE email = ${email}`;
        u = result.rows[0];
      }

      if (!u || !(await bcrypt.compare(pass, u.password_hash))) return respond({ error: 'Invalid credentials' }, 401);
      await sql`DELETE FROM sessions WHERE user_id = ${u.id} AND expires_at < NOW()`;
      const token = generateToken();
      const exp = new Date(Date.now() + SESSION_LIFETIME_SECONDS * 1000).toISOString();
      await sql`INSERT INTO sessions (user_id, token, expires_at) VALUES (${u.id}, ${token}, ${exp})`;
      try { await sql`UPDATE users SET last_login_at = NOW() WHERE id = ${u.id}`; } catch (e) { /* column may not exist */ }
      let resp = respond({ user: { id: Number(u.id), uuid: u.uuid, name: u.name, email: u.email, site_role: u.site_role || 'user' }, token });
      resp = setAuthCookie(resp, token);

      // Run column migration in background after successful login
      ensureColumns().catch(() => {});

      return resp;
    } catch (error) {
      console.error('Login error:', error);
      return respond({ error: 'Server error' }, 500);
    }
  }

  if (action === 'logout') {
    try {
      let token = '';
      const authHeader = request.headers.get('authorization') || '';
      if (authHeader.startsWith('Bearer ')) token = authHeader.slice(7);
      if (!token) {
        const cookie = request.headers.get('cookie') || '';
        const match = cookie.match(/prov_token=([^;]+)/);
        if (match) token = match[1];
      }
      if (token) await sql`DELETE FROM sessions WHERE token = ${token}`;
      let resp = respond({ ok: true });
      resp = clearAuthCookie(resp);
      return resp;
    } catch (error) {
      console.error('Logout error:', error);
      return respond({ error: 'Server error' }, 500);
    }
  }

  if (action === 'forgot_password') {
    try {
      await ensureColumns();
      const email = (input.email || '').toLowerCase().trim();
      if (!email) return respond({ error: 'Email required' }, 400);

      let result;
      try {
        result = await sql`SELECT id, name FROM users WHERE email = ${email} AND deleted_at IS NULL`;
      } catch (e) {
        result = await sql`SELECT id, name FROM users WHERE email = ${email}`;
      }
      // Always return success to prevent email enumeration
      if (result.rows.length === 0) return respond({ ok: true, message: 'If that email exists, a reset link has been generated.' });
      const u = result.rows[0];
      const resetToken = generateToken().slice(0, 32);
      const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
      await sql`UPDATE users SET reset_token = ${resetToken}, reset_token_expires = ${expires} WHERE id = ${u.id}`;
      // Build reset URL
      const origin = request.headers.get('origin') || request.headers.get('referer')?.replace(/\/[^/]*$/, '') || process.env.APP_URL || '';
      const resetUrl = origin + '?reset=' + resetToken;
      // Send reset email (falls back gracefully if email not configured)
      await sendResetEmail(email, resetUrl, u.name);
      if (process.env.NODE_ENV !== 'production') {
        console.log('[PASSWORD RESET] URL: ' + resetUrl);
      }
      const respBody = { ok: true, message: 'If that email exists, a reset link has been sent.' };
      if (process.env.NODE_ENV !== 'production') respBody._dev_reset_url = resetUrl;
      return respond(respBody);
    } catch (error) {
      console.error('Forgot password error:', error);
      return respond({ error: 'Server error' }, 500);
    }
  }

  if (action === 'reset_password') {
    try {
      await ensureColumns();
      const resetToken = (input.token || '').trim();
      const newPass = input.password || '';
      if (!resetToken) return respond({ error: 'Reset token required' }, 400);
      if (!newPass || newPass.length < 8) return respond({ error: 'Password must be at least 8 characters' }, 400);

      let result;
      try {
        result = await sql`SELECT id, email FROM users WHERE reset_token = ${resetToken} AND reset_token_expires > NOW() AND deleted_at IS NULL`;
      } catch (e) {
        result = await sql`SELECT id, email FROM users WHERE reset_token = ${resetToken} AND reset_token_expires > NOW()`;
      }
      if (result.rows.length === 0) return respond({ error: 'Invalid or expired reset link. Please request a new one.' }, 400);
      const u = result.rows[0];
      const hash = await bcrypt.hash(newPass, 10);
      await sql`UPDATE users SET password_hash = ${hash}, reset_token = NULL, reset_token_expires = NULL WHERE id = ${u.id}`;
      await sql`DELETE FROM sessions WHERE user_id = ${u.id}`;
      return respond({ ok: true, message: 'Password updated. You can now sign in.' });
    } catch (error) {
      console.error('Reset password error:', error);
      return respond({ error: 'Server error' }, 500);
    }
  }

  return respond({ error: 'Unknown action' }, 400);
}

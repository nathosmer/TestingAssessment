import { sql } from '@vercel/postgres';
import { requireAuth, respond } from '../../../lib/auth';

// Super admin emails that can run migrations
const SUPER_ADMINS = ['stephen@providentadvisors.com', 'nathaniel@hosmer.org'];

export async function OPTIONS() {
  return new Response(null, { status: 200 });
}

export async function POST(request) {
  const user = await requireAuth(request);
  if (!user) return respond({ error: 'Not authenticated' }, 401);
  if (!SUPER_ADMINS.includes(user.email)) return respond({ error: 'Forbidden' }, 403);

  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || '';
  const results = [];

  if (action === 'rbac') {
    try {
      // 1. Add site_role to users
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS site_role VARCHAR(20) DEFAULT 'user'`;
      results.push('Added site_role column to users');

      // 2. Seed super admins
      await sql`UPDATE users SET site_role = 'super_admin' WHERE email IN ('stephen@providentadvisors.com', 'nathaniel@hosmer.org')`;
      results.push('Seeded super admins');

      // 3. Create org_members table
      await sql`CREATE TABLE IF NOT EXISTS org_members (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        org_id INTEGER NOT NULL REFERENCES organizations(id),
        role VARCHAR(20) NOT NULL DEFAULT 'respondent',
        invited_by INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, org_id)
      )`;
      results.push('Created org_members table');

      // 4. Migrate owners to admin members
      const owners = await sql`INSERT INTO org_members (user_id, org_id, role, created_at)
        SELECT owner_id, id, 'admin', created_at FROM organizations WHERE deleted_at IS NULL
        ON CONFLICT (user_id, org_id) DO NOTHING`;
      results.push('Migrated org owners: ' + (owners.rowCount || 0) + ' rows');

      // 5. Migrate respondents
      const resps = await sql`INSERT INTO org_members (user_id, org_id, role, invited_by, created_at)
        SELECT DISTINCT r.user_id, r.org_id, 'respondent', a.initiated_by, r.created_at
        FROM respondents r JOIN assessments a ON r.assessment_id = a.id
        WHERE r.user_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM org_members om WHERE om.user_id = r.user_id AND om.org_id = r.org_id)
        ON CONFLICT (user_id, org_id) DO NOTHING`;
      results.push('Migrated respondents: ' + (resps.rowCount || 0) + ' rows');

      // 6. Indexes
      await sql`CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_org_members_org ON org_members(org_id)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_org_members_org_role ON org_members(org_id, role)`;
      results.push('Created indexes');

      return respond({ ok: true, results });
    } catch (error) {
      console.error('Migration error:', error);
      return respond({ error: 'Migration failed', detail: error.message, results }, 500);
    }
  }

  return respond({ error: 'Unknown migration action. Use ?action=rbac' }, 400);
}

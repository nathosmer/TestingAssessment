-- RBAC Migration: Role-Based Access Control
-- Adds site-level roles, org membership with roles

-- 1. Add site_role to users table (super_admin can manage entire platform)
ALTER TABLE users ADD COLUMN IF NOT EXISTS site_role VARCHAR(20) DEFAULT 'user';

-- 2. Seed super admins (Stephen and Nathaniel)
UPDATE users SET site_role = 'super_admin' WHERE email IN ('stephen@providentadvisors.com', 'nathaniel@hosmer.org');

-- 3. Create org_members table for org-level role assignments
CREATE TABLE IF NOT EXISTS org_members (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  role VARCHAR(20) NOT NULL DEFAULT 'respondent',  -- 'admin', 'respondent', 'viewer'
  invited_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, org_id)
);

-- 4. Migrate existing data: org owners become 'admin' members
INSERT INTO org_members (user_id, org_id, role, created_at)
SELECT owner_id, id, 'admin', created_at
FROM organizations
WHERE deleted_at IS NULL
ON CONFLICT (user_id, org_id) DO NOTHING;

-- 5. Migrate existing invite-accepted users as 'respondent' members
INSERT INTO org_members (user_id, org_id, role, invited_by, created_at)
SELECT DISTINCT r.user_id, r.org_id, 'respondent', a.initiated_by, r.created_at
FROM respondents r
JOIN assessments a ON r.assessment_id = a.id
WHERE r.user_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM org_members om WHERE om.user_id = r.user_id AND om.org_id = r.org_id)
ON CONFLICT (user_id, org_id) DO NOTHING;

-- 6. Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_org ON org_members(org_id);
CREATE INDEX IF NOT EXISTS idx_org_members_org_role ON org_members(org_id, role);

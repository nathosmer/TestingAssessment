-- Provident Assessment Platform — PostgreSQL Schema

CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    uuid VARCHAR(36) NOT NULL UNIQUE,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'owner',
    site_role VARCHAR(20) DEFAULT 'user',
    reset_token VARCHAR(100) DEFAULT NULL,
    reset_token_expires TIMESTAMPTZ DEFAULT NULL,
    last_login_at TIMESTAMPTZ DEFAULT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(128) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS questions (
    id BIGSERIAL PRIMARY KEY,
    code VARCHAR(20) NOT NULL,
    part VARCHAR(1) NOT NULL,
    section_number SMALLINT NOT NULL DEFAULT 0,
    question_text TEXT NOT NULL,
    question_type VARCHAR(20) NOT NULL,
    response_options JSONB DEFAULT NULL,
    display_order SMALLINT NOT NULL DEFAULT 0,
    is_scorable BOOLEAN NOT NULL DEFAULT false,
    benchmark_value VARCHAR(255) DEFAULT NULL,
    is_critical BOOLEAN NOT NULL DEFAULT false,
    critical_condition VARCHAR(255) DEFAULT NULL,
    assessment_track VARCHAR(20) NOT NULL DEFAULT 'nonprofit',
    version_added VARCHAR(10) NOT NULL DEFAULT 'v4.1',
    version_retired VARCHAR(10) DEFAULT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(code, assessment_track)
);
CREATE INDEX IF NOT EXISTS idx_questions_section ON questions(section_number);
CREATE INDEX IF NOT EXISTS idx_questions_track ON questions(assessment_track);

CREATE TABLE IF NOT EXISTS organizations (
    id BIGSERIAL PRIMARY KEY,
    uuid VARCHAR(36) NOT NULL UNIQUE,
    owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    assessment_track VARCHAR(20) NOT NULL DEFAULT 'nonprofit',
    org_type VARCHAR(100) DEFAULT NULL,
    annual_budget VARCHAR(30) DEFAULT NULL,
    employees_ft SMALLINT DEFAULT 0,
    employees_pt SMALLINT DEFAULT 0,
    contractors SMALLINT DEFAULT 0,
    volunteers VARCHAR(20) DEFAULT NULL,
    locations VARCHAR(10) DEFAULT NULL,
    address_street VARCHAR(255) DEFAULT NULL,
    address_city VARCHAR(100) DEFAULT NULL,
    address_state VARCHAR(2) DEFAULT NULL,
    address_zip VARCHAR(10) DEFAULT NULL,
    year_founded SMALLINT DEFAULT NULL,
    irs_classification VARCHAR(20) DEFAULT NULL,
    denomination VARCHAR(255) DEFAULT NULL,
    payroll_method VARCHAR(100) DEFAULT NULL,
    last_audit VARCHAR(50) DEFAULT NULL,
    federal_funding VARCHAR(50) DEFAULT NULL,
    endowment VARCHAR(50) DEFAULT NULL,
    governing_body_type VARCHAR(100) DEFAULT NULL,
    board_members_current SMALLINT DEFAULT NULL,
    board_members_min SMALLINT DEFAULT NULL,
    board_members_max SMALLINT DEFAULT NULL,
    finance_committee VARCHAR(50) DEFAULT NULL,
    finance_person_type VARCHAR(100) DEFAULT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_orgs_owner ON organizations(owner_id);

CREATE TABLE IF NOT EXISTS org_members (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL DEFAULT 'respondent',
    invited_by BIGINT DEFAULT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, org_id)
);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_org ON org_members(org_id);
CREATE INDEX IF NOT EXISTS idx_org_members_org_role ON org_members(org_id, role);

CREATE TABLE IF NOT EXISTS assessments (
    id BIGSERIAL PRIMARY KEY,
    uuid VARCHAR(36) NOT NULL UNIQUE,
    org_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    assessment_version VARCHAR(10) NOT NULL DEFAULT 'v4.1',
    initiated_by BIGINT NOT NULL REFERENCES users(id),
    status VARCHAR(20) DEFAULT 'draft',
    respondent_completed SMALLINT DEFAULT 0,
    overall_score NUMERIC(3,1) DEFAULT NULL,
    risk_level VARCHAR(20) DEFAULT NULL,
    completed_at TIMESTAMPTZ DEFAULT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_assessments_org ON assessments(org_id);

CREATE TABLE IF NOT EXISTS respondents (
    id BIGSERIAL PRIMARY KEY,
    uuid VARCHAR(36) NOT NULL UNIQUE,
    assessment_id BIGINT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
    org_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id BIGINT DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    invite_id BIGINT DEFAULT NULL,
    respondent_name VARCHAR(255) DEFAULT NULL,
    role VARCHAR(100) DEFAULT NULL,
    role_category VARCHAR(20) DEFAULT NULL,
    years_involved SMALLINT DEFAULT NULL,
    paid_volunteer VARCHAR(50) DEFAULT NULL,
    finance_involvement VARCHAR(100) DEFAULT NULL,
    finance_proximity VARCHAR(10) DEFAULT NULL,
    mission_description TEXT DEFAULT NULL,
    recent_highlight TEXT DEFAULT NULL,
    mission_alignment SMALLINT DEFAULT NULL,
    financial_health_rating VARCHAR(50) DEFAULT NULL,
    financial_health_numeric SMALLINT DEFAULT NULL,
    concerns_text TEXT DEFAULT NULL,
    experience_rating VARCHAR(30) DEFAULT NULL,
    consent_given_at TIMESTAMPTZ DEFAULT NULL,
    status VARCHAR(20) DEFAULT 'invited',
    current_section SMALLINT DEFAULT 0,
    progress_pct SMALLINT DEFAULT 0,
    started_at TIMESTAMPTZ DEFAULT NULL,
    completed_at TIMESTAMPTZ DEFAULT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_respondents_assessment ON respondents(assessment_id);
CREATE INDEX IF NOT EXISTS idx_respondents_org ON respondents(org_id);
CREATE INDEX IF NOT EXISTS idx_respondents_user ON respondents(user_id);

CREATE TABLE IF NOT EXISTS invites (
    id BIGSERIAL PRIMARY KEY,
    uuid VARCHAR(36) NOT NULL UNIQUE,
    org_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    assessment_id BIGINT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
    invited_by BIGINT NOT NULL REFERENCES users(id),
    email VARCHAR(255) NOT NULL,
    token VARCHAR(128) NOT NULL UNIQUE,
    status VARCHAR(20) DEFAULT 'pending',
    accepted_at TIMESTAMPTZ DEFAULT NULL,
    expires_at TIMESTAMPTZ DEFAULT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_invites_org ON invites(org_id);
CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(email);

CREATE TABLE IF NOT EXISTS responses (
    id BIGSERIAL PRIMARY KEY,
    respondent_id BIGINT NOT NULL REFERENCES respondents(id) ON DELETE CASCADE,
    assessment_id BIGINT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
    org_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    question_id BIGINT NOT NULL REFERENCES questions(id),
    question_code VARCHAR(20) NOT NULL,
    section_number SMALLINT NOT NULL,
    question_type VARCHAR(20) NOT NULL,
    answer_raw TEXT NOT NULL,
    answer_normalized VARCHAR(255) DEFAULT NULL,
    answer_matches_benchmark BOOLEAN DEFAULT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(respondent_id, question_code)
);
CREATE INDEX IF NOT EXISTS idx_responses_assessment_section ON responses(assessment_id, section_number);

CREATE TABLE IF NOT EXISTS response_selections (
    id BIGSERIAL PRIMARY KEY,
    response_id BIGINT NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
    selection_value VARCHAR(255) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_response_selections_response ON response_selections(response_id);

CREATE TABLE IF NOT EXISTS emotional_pulses (
    id BIGSERIAL PRIMARY KEY,
    respondent_id BIGINT NOT NULL REFERENCES respondents(id) ON DELETE CASCADE,
    assessment_id BIGINT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
    org_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    pulse_point VARCHAR(30) NOT NULL,
    section_number SMALLINT DEFAULT NULL,
    word_confident BOOLEAN DEFAULT false,
    word_concerned BOOLEAN DEFAULT false,
    word_overwhelmed BOOLEAN DEFAULT false,
    word_hopeful BOOLEAN DEFAULT false,
    word_uncertain BOOLEAN DEFAULT false,
    word_frustrated BOOLEAN DEFAULT false,
    word_encouraged BOOLEAN DEFAULT false,
    word_afraid BOOLEAN DEFAULT false,
    word_empowered BOOLEAN DEFAULT false,
    word_lost BOOLEAN DEFAULT false,
    words_selected SMALLINT DEFAULT 0,
    valence_score NUMERIC(4,2) DEFAULT NULL,
    arousal_score NUMERIC(4,2) DEFAULT NULL,
    why_text TEXT DEFAULT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(respondent_id, pulse_point)
);
CREATE INDEX IF NOT EXISTS idx_emotional_pulses_assessment ON emotional_pulses(assessment_id, section_number);

CREATE TABLE IF NOT EXISTS section_scores (
    id BIGSERIAL PRIMARY KEY,
    assessment_id BIGINT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
    org_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    section_number SMALLINT NOT NULL,
    section_name VARCHAR(100) NOT NULL,
    score NUMERIC(3,1) NOT NULL,
    priority VARCHAR(10) NOT NULL,
    questions_total SMALLINT NOT NULL,
    questions_matching SMALLINT NOT NULL,
    respondent_agreement_pct SMALLINT DEFAULT NULL,
    has_critical_finding BOOLEAN DEFAULT false,
    critical_finding_code VARCHAR(20) DEFAULT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(assessment_id, section_number)
);

CREATE TABLE IF NOT EXISTS reports (
    id BIGSERIAL PRIMARY KEY,
    uuid VARCHAR(36) NOT NULL UNIQUE,
    assessment_id BIGINT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
    org_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    report_json TEXT NOT NULL,
    ai_model VARCHAR(50) DEFAULT NULL,
    ai_tokens_used INT DEFAULT NULL,
    respondent_count SMALLINT NOT NULL,
    overall_score NUMERIC(3,1) DEFAULT NULL,
    risk_level VARCHAR(20) DEFAULT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reports_assessment ON reports(assessment_id);
CREATE INDEX IF NOT EXISTS idx_reports_org ON reports(org_id);

-- Billing / Purchases (monetization infrastructure)
CREATE TABLE IF NOT EXISTS purchases (
    id BIGSERIAL PRIMARY KEY,
    uuid VARCHAR(36) NOT NULL UNIQUE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id BIGINT DEFAULT NULL REFERENCES organizations(id) ON DELETE SET NULL,
    product_id VARCHAR(50) NOT NULL,
    amount_cents INT NOT NULL DEFAULT 0,
    currency VARCHAR(3) NOT NULL DEFAULT 'usd',
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    payment_method VARCHAR(20) DEFAULT 'contact',
    payment_ref VARCHAR(255) DEFAULT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_purchases_org ON purchases(org_id);
CREATE INDEX IF NOT EXISTS idx_purchases_product ON purchases(product_id);

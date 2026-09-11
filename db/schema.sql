-- ===== Existing Successwa tax-tracker tables (unchanged) =====
CREATE TABLE IF NOT EXISTS customer_data (
  account      TEXT NOT NULL,
  app          TEXT NOT NULL,
  data         JSONB NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account, app)
);

CREATE TABLE IF NOT EXISTS users (
  email        TEXT PRIMARY KEY,
  name         TEXT,
  pass_hash    TEXT NOT NULL,
  pass_salt    TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Elite Client Hub: role + active flag on users
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'client';
ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
-- Multi-factor auth (added post-launch; safe to re-run)
--   mfa_method: 'email' | 'totp' | NULL(off);  mfa_enabled: on/off
--   mfa_secret: TOTP base32 secret (only for method='totp')
--   mfa_pending_secret: TOTP secret staged during setup, before the user confirms
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_method TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_pending_secret TEXT;

-- Short-lived MFA challenges: login step-2 and email-OTP enable flow.
-- Stored in DB (not memory) so it works under the PM2 cluster on the VPS.
CREATE TABLE IF NOT EXISTS mfa_challenges (
  id          TEXT PRIMARY KEY,        -- random challenge id handed to the client
  email       TEXT NOT NULL,
  purpose     TEXT NOT NULL,           -- 'login' | 'enable_email'
  method      TEXT NOT NULL,           -- 'email' | 'totp'
  code_hash   TEXT,                    -- hashed email OTP (NULL for totp login)
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mfa_challenges_email ON mfa_challenges(email);

-- Password reset tokens: forgot-password + admin-triggered reset.
-- Token is stored hashed; single-use (consumed on success); short TTL.
CREATE TABLE IF NOT EXISTS password_resets (
  id          TEXT PRIMARY KEY,        -- random reset id (part of the link)
  email       TEXT NOT NULL,
  token_hash  TEXT NOT NULL,           -- hashed secret token
  used        BOOLEAN NOT NULL DEFAULT false,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_resets_email ON password_resets(email);

CREATE TABLE IF NOT EXISTS transactions (
  id           TEXT PRIMARY KEY,
  account      TEXT NOT NULL,
  app          TEXT NOT NULL,
  type         TEXT,
  date         DATE,
  category     TEXT,
  description  TEXT,
  party        TEXT,
  amount       NUMERIC(14,2),
  gst          NUMERIC(14,2),
  notes        TEXT,
  raw          JSONB,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tx_account_app ON transactions(account, app);

-- ===== Elite Client Hub (Phase 1) =====

-- Session tokens for trusted, role-based API auth
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_email ON sessions(email);

-- Clients (unique Client ID like CL-0001)
CREATE TABLE IF NOT EXISTS clients (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  email        TEXT,
  phone        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Google Drive: shareable link to the client's backup folder (added post-launch; safe to re-run)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS drive_folder_id TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS drive_folder_link TEXT;

-- Entities belonging to a client (unique Entity ID like EN-0001)
CREATE TABLE IF NOT EXISTS entities (
  id           TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  entity_name  TEXT NOT NULL,
  entity_type  TEXT NOT NULL, -- individual | company | trust | smsf
  abn          TEXT,
  tfn          TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_entities_client ON entities(client_id);

-- Jobs (unique Job ID like JB-0001)
CREATE TABLE IF NOT EXISTS jobs (
  id               TEXT PRIMARY KEY,
  client_id        TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  entity_id        TEXT REFERENCES entities(id) ON DELETE SET NULL,
  job_type         TEXT,
  financial_year   TEXT,
  accountant_email TEXT,
  supervisor_email TEXT,
  stage            TEXT NOT NULL DEFAULT '01_created',
  on_hold          BOOLEAN NOT NULL DEFAULT false,
  action_required  BOOLEAN NOT NULL DEFAULT false,
  stage_since      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jobs_accountant ON jobs(accountant_email);
CREATE INDEX IF NOT EXISTS idx_jobs_supervisor ON jobs(supervisor_email);
CREATE INDEX IF NOT EXISTS idx_jobs_stage ON jobs(stage);
-- Client e-signature tracking (added post-launch; safe to re-run)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS signed_by TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ;
-- Job deadline (added post-launch; safe to re-run)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS due_date DATE;

-- Stage change history (audit of workflow transitions)
CREATE TABLE IF NOT EXISTS job_status_history (
  id          SERIAL PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  from_stage  TEXT,
  to_stage    TEXT NOT NULL,
  changed_by  TEXT,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jsh_job ON job_status_history(job_id);

-- Uploaded documents (metadata; file bytes stored on disk under uploads/)
CREATE TABLE IF NOT EXISTS documents (
  id          SERIAL PRIMARY KEY,
  job_id      TEXT REFERENCES jobs(id) ON DELETE CASCADE,
  client_id   TEXT REFERENCES clients(id) ON DELETE CASCADE,
  entity_id   TEXT REFERENCES entities(id) ON DELETE SET NULL,
  category    TEXT NOT NULL,
  filename    TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  mime        TEXT,
  size        BIGINT,
  uploaded_by TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_docs_job ON documents(job_id);
-- Google Drive backup: id of the mirrored file on Drive (added post-launch; safe to re-run)
ALTER TABLE documents ADD COLUMN IF NOT EXISTS drive_file_id TEXT;
-- Document verification (added post-launch; safe to re-run)
--   status: 'received' (default) | 'verified' | 'incorrect' | 'info_required'
ALTER TABLE documents ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'received';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS verified_by TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS review_note TEXT;

-- Outstanding document requests
CREATE TABLE IF NOT EXISTS doc_requests (
  id          SERIAL PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  category    TEXT,
  description TEXT NOT NULL,
  due_date    DATE,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | received
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_docreq_job ON doc_requests(job_id);

-- Email templates (admin editable)
CREATE TABLE IF NOT EXISTS notification_templates (
  key         TEXT PRIMARY KEY,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Notification log
CREATE TABLE IF NOT EXISTS notifications (
  id           SERIAL PRIMARY KEY,
  job_id       TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  to_email     TEXT NOT NULL,
  template_key TEXT,
  subject      TEXT,
  body         TEXT,
  channel      TEXT NOT NULL DEFAULT 'email', -- email | sms (future)
  status       TEXT NOT NULL DEFAULT 'sent', -- sent | failed | resent
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notif_job ON notifications(job_id);
-- Unread tracking for the in-app notification bell (added post-launch; safe to re-run)
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_notif_to ON notifications(to_email);

-- Global audit trail
CREATE TABLE IF NOT EXISTS audit_log (
  id           SERIAL PRIMARY KEY,
  actor_email  TEXT,
  action       TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    TEXT,
  detail       JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

-- Simple counter table for generating sequential human IDs (CL-, EN-, JB-)
CREATE TABLE IF NOT EXISTS id_counters (
  name    TEXT PRIMARY KEY,
  value   BIGINT NOT NULL DEFAULT 0
);

-- Generic app settings (key/value). Used for Google Drive OAuth refresh token,
-- connected account email, cached Drive root folder id, etc.
CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

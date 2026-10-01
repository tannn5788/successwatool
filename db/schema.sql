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
-- Client self-service profile fields (Syraxx Phase 1). Basic contact info only —
-- never TFN/bank/sensitive data here. Editable by the client from the Profile page.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS mobile TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS preferred_contact TEXT; -- 'email' | 'mobile' | 'phone'
ALTER TABLE clients ADD COLUMN IF NOT EXISTS dob DATE; -- date of birth (collected at client onboarding)
-- Prevent duplicate client rows for the same email (case-insensitive). Partial so
-- multiple NULL-email clients are still allowed.
CREATE UNIQUE INDEX IF NOT EXISTS clients_email_lower_uidx ON clients (lower(email)) WHERE email IS NOT NULL;

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
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS signed_ip TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS signed_user_agent TEXT;
-- Job deadline (added post-launch; safe to re-run)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS due_date DATE;
-- Job priority (added post-launch; safe to re-run): high | normal | low
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal';

-- Per-job work checklist items (seeded from a template based on job_type when the job is created).
-- Offshore staff tick these off; required items must be complete before a job can go to supervisor review.
CREATE TABLE IF NOT EXISTS job_checklist_items (
  id          SERIAL PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  required    BOOLEAN NOT NULL DEFAULT true,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  checked     BOOLEAN NOT NULL DEFAULT false,
  checked_by  TEXT,
  checked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_checklist_job ON job_checklist_items(job_id);

-- Reminder de-duplication lock (added post-launch; safe to re-run).
-- The scheduler claims a row here before sending a reminder so that, under the PM2
-- cluster (multiple processes), each reminder is sent exactly once.
CREATE TABLE IF NOT EXISTS job_reminders (
  id          SERIAL PRIMARY KEY,
  ref_type    TEXT NOT NULL,   -- 'doc_request' | 'job'
  ref_id      TEXT NOT NULL,   -- doc_request id or job id
  kind        TEXT NOT NULL,   -- 'client_3d' | 'client_7d' | 'due_tomorrow' | 'overdue' | 'review_stale'
  sent_to     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ref_type, ref_id, kind)
);

-- Recurring job schedules (added post-launch; safe to re-run). The scheduler generates
-- a fresh job (with checklist) when next_run_date - lead_days is reached.
CREATE TABLE IF NOT EXISTS recurring_jobs (
  id               TEXT PRIMARY KEY,        -- RC-0001
  client_id        TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  entity_id        TEXT REFERENCES entities(id) ON DELETE SET NULL,
  job_type         TEXT,
  accountant_email TEXT,
  supervisor_email TEXT,
  priority         TEXT NOT NULL DEFAULT 'normal',
  frequency        TEXT NOT NULL,           -- monthly | quarterly | annually
  next_run_date    DATE NOT NULL,           -- date the next generated job is DUE
  lead_days        INTEGER NOT NULL DEFAULT 14,
  financial_year   TEXT,
  active           BOOLEAN NOT NULL DEFAULT true,
  last_job_id      TEXT,
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recurring_client ON recurring_jobs(client_id);

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

-- Internal staff-only notes on a job (never shown to the client).
CREATE TABLE IF NOT EXISTS job_notes (
  id          SERIAL PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  author      TEXT NOT NULL,
  note        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_job_notes_job ON job_notes(job_id);
-- @mention support (Phase 2): emails of staff mentioned in the note, notified via the in-app bell.
ALTER TABLE job_notes ADD COLUMN IF NOT EXISTS mentions TEXT[] NOT NULL DEFAULT '{}';

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
-- Client-visibility flag (Syraxx Phase 1, Stage 5). Staff-uploaded deliverables
-- (final returns, notices of assessment, etc.) are hidden from the client until a
-- staff member explicitly flags them visible. A client's OWN uploads are always
-- visible to that client regardless of this flag.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS client_visible BOOLEAN NOT NULL DEFAULT false;

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

-- Controlled document folder tree (Syraxx Phase 1, Stage 4).
-- A per-client tree, organised by financial year. `system` folders are the
-- standard controlled categories seeded automatically and cannot be renamed or
-- deleted by the client; non-system folders are client-created (within limits).
CREATE TABLE IF NOT EXISTS doc_folders (
  id          SERIAL PRIMARY KEY,
  client_id   TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  parent_id   INTEGER REFERENCES doc_folders(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  year        TEXT,                    -- e.g. '2026 Tax' (financial-year grouping)
  is_system   BOOLEAN NOT NULL DEFAULT false,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_docfolders_client ON doc_folders(client_id);
CREATE INDEX IF NOT EXISTS idx_docfolders_parent ON doc_folders(parent_id);
-- Link an uploaded document to a folder (optional; NULL = unfiled).
ALTER TABLE documents ADD COLUMN IF NOT EXISTS folder_id INTEGER REFERENCES doc_folders(id) ON DELETE SET NULL;


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

-- Two-way secure messaging between a client and the firm (Syraxx Phase 1, Stage 6).
-- direction: 'in'  = from client to firm; 'out' = from firm to client.
-- sender_email is the actual author; the client UI never shows staff names, only "Syraxx".
CREATE TABLE IF NOT EXISTS client_messages (
  id           SERIAL PRIMARY KEY,
  client_id    TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  job_id       TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  direction    TEXT NOT NULL,                 -- 'in' | 'out'
  sender_email TEXT,
  body         TEXT NOT NULL,
  read_by_client BOOLEAN NOT NULL DEFAULT false,
  read_by_staff  BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cmsg_client ON client_messages(client_id);
CREATE INDEX IF NOT EXISTS idx_cmsg_created ON client_messages(created_at);

-- Appointments booked via Setmore (Syraxx Phase 1, Stage 7). We keep a local copy
-- so the portal can show a client's upcoming/past bookings without re-querying
-- Setmore on every page load. setmore_appt_key links back to the Setmore record.
CREATE TABLE IF NOT EXISTS appointments (
  id               SERIAL PRIMARY KEY,
  client_id        TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  setmore_appt_key TEXT,
  service_key      TEXT,
  service_name     TEXT,
  staff_key        TEXT,
  staff_name       TEXT,
  start_time       TIMESTAMPTZ NOT NULL,
  end_time         TIMESTAMPTZ,
  status           TEXT NOT NULL DEFAULT 'booked',  -- booked | cancelled
  booked_by        TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_appt_client ON appointments(client_id);
CREATE INDEX IF NOT EXISTS idx_appt_start ON appointments(start_time);

-- Admin-defined stage automations (Phase 2). When a job ENTERS `stage`, run `action`.
-- action: 'notify_client' (send an email template) | 'set_action_required' | 'clear_action_required'
--       | 'add_note' (internal note) | 'notify_staff' (bell to a staff email)
-- config JSON carries action params (e.g. templateKey, note text, staff email).
-- stage_time_limit_days: if >0, a job sitting in `stage` longer than this is flagged overdue in the UI.
CREATE TABLE IF NOT EXISTS stage_automations (
  id            SERIAL PRIMARY KEY,
  stage         TEXT NOT NULL,
  action        TEXT NOT NULL,
  config        JSONB NOT NULL DEFAULT '{}',
  enabled       BOOLEAN NOT NULL DEFAULT true,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stage_autom_stage ON stage_automations(stage);
-- Multi-trigger support (added post-launch; safe to re-run). trigger_type is the event that fires
-- the rule (stage_enter | job_created | job_assigned | client_created | document_uploaded).
-- trigger_key narrows it: the stage for stage_enter, an optional job_type for job_created, else NULL.
ALTER TABLE stage_automations ADD COLUMN IF NOT EXISTS trigger_type TEXT NOT NULL DEFAULT 'stage_enter';
ALTER TABLE stage_automations ADD COLUMN IF NOT EXISTS trigger_key  TEXT;
-- Backfill existing rules: they were all stage-enter rules keyed by their stage column.
UPDATE stage_automations SET trigger_key = stage WHERE trigger_key IS NULL AND trigger_type = 'stage_enter';
CREATE INDEX IF NOT EXISTS idx_stage_autom_trigger ON stage_automations(trigger_type, trigger_key);


-- Per-stage time limits (SLA). Kept separate so a stage can have a limit without any action rules.
CREATE TABLE IF NOT EXISTS stage_limits (
  stage       TEXT PRIMARY KEY,
  limit_days  INTEGER NOT NULL DEFAULT 0,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-account UI preferences (Phase 2). Stores non-sensitive layout config only
-- (which dashboard widgets are shown, their order, chosen chart types). Keyed by
-- (email, scope) so each page/feature keeps its own prefs blob. Never holds
-- business data — purely presentation choices for the logged-in user.
CREATE TABLE IF NOT EXISTS user_prefs (
  email      TEXT NOT NULL,
  scope      TEXT NOT NULL,          -- e.g. 'insights'
  prefs      JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (email, scope)
);

-- Client invoices / payment status (Phase 1 #13/#15, record-only). Staff raise an
-- invoice (amount + due date); the client sees the amount + status and a (placeholder)
-- Pay Now button; staff mark it paid manually. Money is stored as integer cents to
-- avoid floating-point rounding. A real payment gateway (Stripe) can later fill
-- paid_method/paid_ref and flip status via webhook.
CREATE TABLE IF NOT EXISTS invoices (
  id            TEXT PRIMARY KEY,                 -- INV-0001
  client_id     TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  job_id        TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  description   TEXT,
  amount_cents  BIGINT NOT NULL CHECK (amount_cents >= 0),
  currency      TEXT NOT NULL DEFAULT 'AUD',
  status        TEXT NOT NULL DEFAULT 'unpaid',   -- unpaid | paid | void
  due_date      DATE,
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at       TIMESTAMPTZ,
  paid_method   TEXT,                             -- e.g. 'manual' | 'stripe'
  paid_ref      TEXT,                             -- gateway reference (future)
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoices_client ON invoices(client_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);

# CODEBASE_MAP — Syraxx Client Hub (d:\Successwa)

> Graft-style codebase map. **The agent reads this file at the START of every session so it never re-explores blind.**
> Keep it fresh: whenever you add/rename an endpoint, table, page, or feature, update the matching row here.
> Last synced: 2026-09-18 (against server.js 167KB, db/schema.sql 24 tables).

---

## 0. What this project is
Australian tax / accounting web app. **Vanilla JS front-end + Express 5 + Neon Postgres.** No framework, no bundler.
Files are **FLAT in the repo root** (no `public/` dir). Server serves them statically.
- Firm brand shown to clients = **"Syraxx"** (real internal name "Elite Tax & Wealth Advisory" — never leak to clients).
- Roles: `administrator`, `supervisor`, `accountant` (= offshore), `reception`, `client`.
- Phase 1 focus = **CLIENT PORTAL**. Never leak internal data (staff names, offshore, internal notes, TFN, bank) to clients.
- Deployed at https://demo.kaiizen.ai (VPS + PM2) but **NOT auto-deployed** — all work is LOCAL & uncommitted unless user says push/deploy.
- Do NOT build Payment (Stage 8). Do NOT touch AWS.

## 1. Run / environment cheatsheet
- Start server: `node server.js` from `d:\Successwa` (Cwd param; IsDaemon true; Wait ~6000ms). Port **8000**.
- Health check: `Invoke-WebRequest http://127.0.0.1:8000/login.html` → expect 200.
- Browser testing: tell user **localhost** (Google OAuth redirect only allows localhost/127.0.0.1).
- **Server restarts frequently** (env restarts kill all bg tasks/subagents → must restart server).
- Node v24.19.0 (global `fetch`). PowerShell 5.1: **never `cd`** (use Cwd), **never `npm`** (use `npm.cmd`).
- `.env` has DATABASE_URL (connect with `ssl:{rejectUnauthorized:false}`), GOOGLE_CLIENT_ID/SECRET, SETMORE_REFRESH_TOKEN, FACEBOOK creds.
- pg-using node scripts MUST live inside `d:\Successwa` (e.g. `qa/*.js`); scratch dir can't resolve `pg`.

## 2. Write-files safety rules (LEARNED THE HARD WAY)
- **NEVER `open(f,'w')` / truncate before reading** — once wiped all 21 HTML files to 0 bytes. ALWAYS read first.
- Write UTF-8 no BOM in PowerShell: `$enc=New-Object System.Text.UTF8Encoding($false);[System.IO.File]::WriteAllText($path,$content,$enc)`. Never Set-Content/Add-Content (corrupts em-dashes).
- `grep_search_ide` often returns "No results" on server.js → use PowerShell `Select-String -Path server.js -Pattern "..."`.
- After editing a client `.js`, bump its `?v=` in every referencing HTML (HTML is no-cache; other assets hard-cached).
- `node --check <file>` before relying on any JS. Restart server if server.js changed.

## 3. Front-end pages (root, flat). Each `X.html` loads `X.js` (+ nav.js, hub-common.js).
### Client portal (Phase 1)
| Page | JS | Purpose |
|---|---|---|
| home.html | home.js | Client dashboard — reads `/api/portal/summary` (current work, actions, messages, next appt). |
| portal.html | portal.js | "My Work" — job list + job detail, documents. |
| documents.html | documents.js | Client documents / folders. |
| appointments.html | appointments.js | Setmore booking UI (service/staff cards, month calendar, time pills). |
| messages.html | messages.js | Two-way messaging with firm (firm shown as "Syraxx", staff names hidden). |
| previous.html | previous.js | Previous Work = completed jobs. |
| profile.html | profile.js | Client profile view/edit. |
| complete-profile.html | complete-profile.js | Mandatory onboarding step 1 (name/DOB/mobile/address/contact). |
| secure-setup.html | secure-setup.js | Mandatory onboarding step 2 (enable 2FA). |
### Staff / internal
| Page | JS | Purpose |
|---|---|---|
| dashboard.html | dashboard.js | Staff dashboard. |
| pipeline.html | pipeline.js | **Pipeline Kanban board (Phase 2)** — jobs grouped by 9 stages; drag-drop card → `POST /api/jobs/:id/stage`; overdue cards (past stage_limits) outlined red. Reads `/api/pipeline`. |
| insights.html | insights.js | **Insights dashboard (Phase 2, admin/supervisor)** — stat tiles + inline bar charts from `/api/insights/summary`. |
| clients.html | clients.js | Client CRUD (staff). |
| job.html | job.js | Job detail for staff (stages, checklist, internal notes, client messages). |
| review.html | review.js | Supervisor review queue. |
| recurring.html | recurring.js / recurring-page.js | Recurring jobs. |
| admin.html | admin.js | Admin (users, templates). |
| settings.html | settings.js | Settings. |
| help.html / privacy.html | — | Static. |
### Auth / standalone
| login.html, reset.html | Login, MFA, Google/Facebook, password reset. |
| personal.html | personal.js | Standalone personal tax tracker (customer_data, auth-gated). |
| business.html | business.js | Standalone business tax tracker (customer_data, auth-gated). |

### Shared front-end modules
- **nav.js** — exports `getAuth/setAuth/clearAuth`, `api(path,{method,body})`, `guard(roles)`, `renderNav(active)`, `homeFor(role)`, `STAFF`, `esc`. Client menu: home/portal/documents/appointments/messages/previous/profile/help. `guard()` calls `GET /api/portal/status` → redirects: profileComplete? no→complete-profile; then mfaEnabled? no→secure-setup. localStorage key `successwa.auth` = {token,email,role,name}.
- **hub-common.js** — `modal(title,html)`, `toast`, `busy(btn,promise)`, `guide(pageKey,role,byRole)`, `fmtDate`, `fmtDateTime`, `STAGES`, `STAGE_LABEL`, `pillClass`.
- **workflow.js** — 9-stage Client Work Tracker definitions.
- **mfa.js, google-auth.js, facebook-auth.js, google-drive.js, setmore.js** — integration clients.
- **assistant.js / assistant-kb.js** — in-app assistant.
- **checklists.js, reminders.js, notify.js, recurring.js** — server-side helpers.

## 4. server.js (~167KB, monolith) — key helpers & middleware
- `requireAuth` (~L190): Bearer token → sessions table → `req.user{email,role,name}`.
- `requireRole(...roles)` (~L216). `STAFF=['administrator','supervisor','accountant','reception']` (~L225).
- `enforceAccountAccess` (~L227): account param must == req.user.email unless STAFF.
- `normAccount(a)` (~L116) lowercase-trim. `nextId(client,name,prefix)` (~L129) for CL-/JB- ids.
- `ensureClientForUser(email,name)` (~L147): INSERT clients ON CONFLICT (lower(email)) DO NOTHING — called at register/Google/Facebook.
- `audit(runner,actor,action,entityType,entityId,detail)`.

## 5. API endpoints (server.js) — grouped
**Auth:** POST /api/register (251) · /api/login (271) · /api/login/verify (311) · GET /api/auth/google/start (360) /callback (374) · /api/auth/facebook/start (426) /callback (440) · POST /api/forgot-password (526) · /api/reset-password (540) · /api/logout (568) · GET /api/me (576) · /api/mfa/status (580) · POST /api/mfa/setup (591) /enable (616) /disable (648).
**Clients/entities (STAFF):** GET/POST /api/clients (661/673) · PATCH /api/clients/:id (697) · GET/POST /api/entities (721/733).
**Jobs (STAFF):** GET /api/jobs (759) · GET /api/jobs/:id (802) · POST /api/jobs (833) · POST /api/jobs/:id/stage (901) · /flags (931) · /checklist/:itemId (950) · PATCH /priority (974) · DELETE /api/jobs/:id (988, admin) · GET /api/staff (1025).
**Job notes (STAFF, internal):** POST /api/jobs/:id/notes (1270) · DELETE /api/jobs/:id/notes/:noteId (1289).  ← internal team notes live here (job_notes table).
**Review (supervisor):** GET /api/review/queue (1318) /count (1338) · POST /:id/approve (1345) /return (1360) /request-info (1392).
**Docs:** GET /api/doc-categories (1458) · POST /api/documents/upload (1669) · GET /api/documents/:id/download (1775) · DELETE /api/documents/:id (1808) · POST /api/doc-requests (1821) /:id/received (1844) · DELETE /api/doc-requests/:id (1861).
**Portal folders (client):** GET/POST /api/portal/folders (1510/1525) · DELETE /:id (1567) · GET /:id/documents (1581) · POST /:id/upload (1596).
**Google Drive (admin):** GET /api/google/status (1621) /auth-url (1627) /callback (1641) · POST /api/google/disconnect (1659).
**Notifications:** POST /api/notifications/:id/resend (1879) · GET /api/notifications (1890) · GET /api/my-notifications/count (1899) /my-notifications (1909) · POST /read (1919) /clear (1929).
**Admin:** GET/POST /api/admin/users (1937/1944) · PATCH/DELETE /:email (1964/1982) · POST /:email/reset (1999) · GET/PUT /api/admin/templates (2010/2015) · GET /api/admin/audit (2031) · **GET/PUT /api/admin/announcement (~2115/2124 — client-Home banner, app_settings `portal_announcement`)** · POST /api/admin/run-reminders.
**Admin Automations — multi-trigger event engine (Phase 2, expanded 2026-09-19):** GET /api/admin/automations (returns `triggers[]` metadata) · POST /api/admin/automations {triggerType,triggerKey,action,config} · PATCH/DELETE /api/admin/automations/:id · PUT /api/admin/stage-limits/:stage. Rules fire via generic **`runAutomations(runner,eventType,ctx,actor,eventKey)`** (server.js ~L938; replaces old `runStageAutomations`). **5 triggers:** `stage_enter` (key=stage, fired in changeStage), `job_created` (optional key=job_type, fired POST /api/jobs), `job_assigned` (POST /api/jobs when acc/sup set + POST /api/jobs/:id/assign on reassign), `client_created` (POST /api/clients), `document_uploaded` (POST /api/documents/upload when uploader is client). Rules selected `WHERE trigger_type=$1 AND enabled AND (trigger_key IS NULL/'' OR =$2)`. **Actions:** notify_client (record-only, email pending), set_action_required/clear_action_required/add_note (job-only — rejected 400 on non-job triggers), notify_staff (in-app bell). Tables: **stage_automations** (now + `trigger_type`,`trigger_key` cols; legacy `stage` kept in sync for back-compat), **stage_limits**.
**Staff Pipeline/Insights (Phase 2):** GET /api/pipeline (jobs grouped by stage + overdue flag from stage_limits) · GET /api/insights/summary (~L2356 — accepts filters `?fy=&type=&priority=&staff=&months=3|6|12`; returns filterOptions{years,types,priorities,staff}, groupings[{key,label}] (staff key firm-wide only) + byStage/byType/byPriority/byYear/overdue/active/completed/onHold/highPriority/newThisWeek/completedThisWeek/apptsThisWeek/avgStageAge/completionRate/throughput/intake/workload/docsByStatus/docsToReview/outstandingDocs/clients/upcomingAppts; **+ Insights 2.0 fields: deltas{created,completed} (30d vs prev 30d), stageByPriority, avgStageDuration, cycleBox (5-num summary per type), ageHist (width_bucket), activity (month×weekday), workloadByStage + staffBubble (firm-wide only), apptsByService, outstandingByStage, stageOrder**; accountant scoped to own, staff filter+grouping firm-wide only) · GET /api/staff/mentionable (@mention autocomplete). **Insights UI = Insights 2.0: 5-tab dense dashboard (Overview / Trends / Cycle time / Workload / Documents) in insights.js, all hand-built SVG (funnel, stacked bar, histogram, box plot, heatmap, lollipop, bubble, area line, KPI-delta strips) in the editorial palette; shared filter bar persists across tabs; active tab saved in localStorage. The old per-account customize/drag/add-widget board was replaced by the fixed tabbed layout.**
**Per-account UI prefs:** GET /api/me/prefs/:scope (~L584) · PUT /api/me/prefs/:scope {prefs} — scope allow-listed (`PREF_SCOPES=['insights']`), bound to req.user.email (user reads/writes ONLY own), prefs JSONB capped 8KB. Table **user_prefs** (email,scope PK, prefs JSONB). Insights stores {order:[],hidden:{},shown:{},types:{},custom:[{id,title,groupBy,chart}]} — Customize panel (drag reorder + show/hide + opt-in KPIs + chart-type switch + remove custom + Reset) + Add-widget builder in insights.js.
**Portal (client):** GET /api/portal/jobs (2050) · /jobs/:id (2082) · **/summary (2117 — active jobs in `jobs[]`; last 5 completed in `completedJobs[]`; `announcement` from app_settings)** · /profile (2192) · /status (2207) · POST /profile/complete (2220) /profile (2246) · DELETE /documents/:id (2268) · POST /jobs/:id/sign (2288, requires typed name + `consent:true`; stores signed_by/at + signed_ip + signed_user_agent audit trail) · GET /previous (2313) · GET /messages (2348) /messages/count (2361) · POST /messages (2371).
**Client messages (STAFF side):** GET/POST /api/clients/:id/messages (2393/2410).
**Client email + email log (STAFF side, Wave 4A):** GET /api/clients/:id/emails (list direct emails, template_key='client_email', accountant scoped) · POST /api/clients/:id/email {subject,body} (send via sendNotification + log). Real SMTP send via Resend is configured in `.env` (SMTP_*); note Resend sandbox only delivers to the account owner `ai1@successwa.com` until a domain is verified — other recipients log status='failed' with the 550 reason.
**Appointments:** GET /api/appointments/services (2443) /slots (2452) · POST /api/portal/appointments (2470) · GET /api/portal/appointments (2508, now returns service_key+staff_key) · **POST /api/portal/appointments/:id/cancel** (client cancels own upcoming; DB status='cancelled', best-effort Setmore label→'CANCELLED') · **POST /api/portal/appointments/:id/reschedule** {date,slot} (create-new slot then label the OLD Setmore booking 'CANCELLED - rescheduled', same service+staff). **NOTE: Setmore's public API has NO cancel/delete or reschedule endpoint** — only `PUT /bookingapi/appointments/{key}/label?label=` (documented). setmore.js exposes `labelAppointment(key,label)`; the authoritative cancel/reschedule state is our own DB.
**Tax tracker data (auth+account):** POST /api/save (2554) · GET /api/load (2587) /list (2599) · POST /api/merge (2608) · GET /api/export (2648).
**Assistant:** POST /api/assistant (2890) — NOTE: currently UNAUTH (deferred security item L2).

## 6. Database (Neon Postgres) — db/schema.sql, 24 tables
`customer_data` (legacy tax tracker, keyed account=email + app='personal'|'business') · `users` (login only: email,name,pass_hash,pass_salt,role,mfa_enabled,mfa_method,mfa_secret,active) · `mfa_challenges` · `password_resets` · `transactions` · `sessions` (Bearer tokens) · **`clients`** (CL-xxxx PK; name,email,phone,address,mobile,preferred_contact,dob,drive_folder_id/link; unique index lower(email); **THIS holds client profile data, not users**) · `entities` · `jobs` (JB-xxxx; stage e.g. 09_completed; client_id FK) · `job_checklist_items` · `job_reminders` · `recurring_jobs` · `job_status_history` · **`job_notes`** (internal staff notes on jobs) · `documents` · `doc_requests` · `doc_folders` · `notification_templates` · `notifications` · `audit_log` · `id_counters` · `app_settings` · `client_messages` (client↔firm) · `appointments`.
- Tables with `client_id` FK REFERENCES clients(id) ON DELETE CASCADE: entities, jobs, recurring_jobs, documents, doc_folders, client_messages, appointments.
- `node db/init.js` applies schema.sql (idempotent).
- **Phase 2 tables:** `stage_automations` (per-stage rules: action + config JSONB + enabled), `stage_limits` (stage PK + limit_days SLA). `job_notes.mentions TEXT[]` added for @mention. `app_settings` key `portal_announcement` holds the Home banner JSON.

## 7. Test accounts (all @successwa.com)
admin/admin123 · supervisor/super123 · accountant/acct123 · reception/recep123 · demo/demo123 (CLIENT, **has MFA → API login returns {mfaRequired:true}**, for client API tests REGISTER a fresh unique email) · offshore1-3/offshore123. demo client = CL-0001. Jobs: JB-0015, JB-0014, JB-0008(→09_completed).

## 8. Status / roadmap
- **DONE & tested:** Stages 0–7c (rebrand→Syraxx; mandatory MFA + onboarding; 9-stage tracker; requested docs; controlled folders; client-visible flag + Previous Work; two-way messaging; Setmore appointments + booking UI; mandatory onboarding profile→2FA→portal).
- **QA:** qa/e2e_test.js = 81/81 pass. Security "Group A" fixed (auth on /api/save,load,list,merge,export; unique client email; staff-email leak fixes; job-scoped doc download).
- **DEFERRED "Group B":** M1 social login bypasses 2FA · M2 Facebook trusts unverified email · M5 real staff names shown via appointments · M3 gate client-side only · L1 review_note verbatim · L2 /api/assistant unauth · L3 inline preview · N1 dead ternary.
- **Phase 2 Wave 1 DONE (2026-09-18):** client Home now shows **Recently Completed** jobs (summary returns `completedJobs[]`) + **Quick links** card + **Announcement** banner (admin-editable at Admin → Announcement tab, `GET/PUT /api/admin/announcement`). home.js v4, admin.js v15. Verified: 81/81 e2e still green + announcement API round-trip.
- **Phase 2 Wave 2 DONE (2026-09-18):** internal **@mention** on job notes (team-only). `job_notes.mentions TEXT[]`; `POST /api/jobs/:id/notes` validates mentions vs active staff + drops in-app bell notification per mentioned colleague; job.js v52 adds @autocomplete + mention chips + "mentioned you" highlight. Verified: bell count 14→15, note stores mentions, 81/81 e2e.
- **Phase 2 Wave 3 DONE (2026-09-18):** **Pipeline Kanban** (pipeline.html/js v1, drag-drop stage change, overdue via stage_limits) + **Insights dashboard** (insights.html/js v1, admin/supervisor) + **Admin Automations** (Admin → Automations tab: per-stage rules fire on stage entry + stage time limits). nav.js v29 (Pipeline all staff, Insights admin/supervisor), admin.js v16. New tables stage_automations, stage_limits. Verified: pipeline 9 jobs/12 stages, insights aggregates, automation add_note fired on stage move, 81/81 e2e.
- **Phase 2 Wave 4A DONE (2026-09-18):** **Email this client** + email log. Staff "Email" button on each client card (clients.js v43) opens a compose modal (subject+body) that sends a real email (Resend SMTP, configured in `.env`) and shows the email history. Endpoints `GET /api/clients/:id/emails` + `POST /api/clients/:id/email` (accountant scoped to own clients; client role blocked 403). Verified: 11/11 targeted email tests + 81/81 e2e. NOTE: Resend sandbox currently only delivers to `ai1@successwa.com` until a domain is verified — other recipients are logged with status='failed' (expected).
- **Requirement-gap fixes DONE (2026-09-19):** vs the original brief — (1) **Appointment Reschedule + Cancel** now supported (portal endpoints + appointments.js v4 UI). **Setmore's public API has NO cancel/reschedule endpoint** (verified against apiary docs 2026-09-19) — the only appointment mutation is `PUT .../label`, so cancel/reschedule are authoritative in our DB and best-effort flag the Setmore booking label via `setmore.labelAppointment`; (3) **Help/Support** page now has the 4 client actions (Send message / Call office / Request callback / Book appointment) and Help is now in the client nav (nav.js **v30** across all HTML); (4) Setmore adviser name confirmed client-facing-only (documented in code, not internal/offshore); (6) **E-signature hardened** — sign now requires typed name + explicit consent and records signed_ip + signed_user_agent (new `jobs.signed_ip`/`signed_user_agent` columns), portal.js v55. Verified: 10/10 targeted appt/sign tests (2 "fails" were 404-before-consent, correct ownership order) + 81/81 e2e. Gaps 2 (social-login MFA) & 5 (assistant auth) NOT done (security, deferred). Payment (#13/#15) deferred by user.
- **Automation multi-trigger engine DONE (2026-09-19):** old single stage-enter automation generalized into a real event engine — `runStageAutomations`→`runAutomations(runner,eventType,ctx,actor,eventKey)` (server.js ~L938). 5 triggers wired (stage_enter, job_created +optional job_type key, job_assigned, client_created, document_uploaded). New cols `stage_automations.trigger_type`/`trigger_key` (`node db/init.js` applied). Admin API returns `triggers[]`, validates triggerType allow-list + rejects job-only actions on non-job triggers (400). admin.js **v17** (Trigger select + adaptive key field + Trigger column + warning). Verified: **qa/automation_test.js 12/12 pass** (rules really fire with side-effects: add_note/bell/action_required; trigger_key filter + disabled rule + 400 guards all proven) + **81/81 e2e** still green. notify_client stays record-only (email pending — user deferred SMTP wiring).
- **Insights 2.0 DONE (2026-09-22):** Insights rebuilt from a single customizable board into a **5-tab dense analytics dashboard** (Overview / Trends / Cycle time / Workload / Documents) modeled on a Power BI reference, kept in the editorial palette. New hand-built SVG primitives: funnel, stacked bar, histogram, box plot, heatmap, lollipop, bubble, area line, KPI-delta strips. `/api/insights/summary` gained deltas/stageByPriority/avgStageDuration/cycleBox/ageHist/activity/workloadByStage/staffBubble/apptsByService/outstandingByStage/stageOrder (all filter-aware + accountant-scoped). insights.js **v12**, styles.css **v81**, container widened to 1280px. Verified: qa/insights2_test.js 11/11 fields + accountant scoping (workloadByStage/staffBubble empty, no leak) + e2e still green.
- **Insights perf + visual polish (2026-09-22):** `/api/insights/summary` was ~9.6s → now ~0.8-1.2s warm. Root cause: ~37 SQL queries fired sequentially (~255ms Neon RTT each) + a stale sequential server holding port 8000. Fix: all ~34 aggregation queries now fire un-awaited then resolve via one `Promise.all([...])` (server.js ~L2356); pool pre-warming added (server.js ~L61: `warmPool()` fires PREWARM×`SELECT 1` on boot + every 25s). Visual: switched to **blue monochrome BI palette** (PAL blues, INK #2563eb), bigger SVG/bar fonts, on-chart value labels + funnel/donut %, equal-height flex chart cards.
- **NEW feature requests remaining (Wave 4B in implementation_plan.md):** true two-way **Gmail sync** — needs expanded Google OAuth scopes (gmail.readonly/gmail.send) + Google verification; DEFERRED pending user approval.

## 9. Artifacts (planning/QA docs)
Artifacts dir: `C:\Users\Admin\.gemini\antigravity\brain\cf14893c-3cd3-4acb-8e6a-4aa4fb7fdfcc\` — walkthrough.md, implementation_plan.md, qa_summary.md, qa_test_results.md, code_review_findings.md, test_checklist.md, syraxx_requirements_analysis.md.

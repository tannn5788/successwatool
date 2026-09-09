// assistant-kb.js — knowledge base for the in-app AI help assistant.
// A plain-text "handbook" describing what each page/feature does. The server
// injects this into the Gemini system prompt so answers are grounded in how
// THIS app actually works (not generic guesses). Keep it concise and factual.

const APP_KB = `
SUCCESSWA / ELITE CLIENT HUB — PRODUCT HANDBOOK

OVERVIEW
Successwa is an Australian tax record-keeping web app for an accounting firm
(Elite Tax & Wealth Advisory). It has two halves:
1) TAX TRACKER — self-serve tools for individuals/sole traders to record income,
   expenses and deductions and see an estimated tax position. Pages: Personal, Business.
2) ELITE CLIENT HUB — the firm's internal workflow + client portal, organised by role.

ROLES
- client: the firm's customer. Sees only their own jobs via the Portal.
- reception: adds clients/entities, creates jobs, reassigns staff, watches the dashboard.
- accountant: works jobs assigned to them; requests documents; moves jobs forward.
- supervisor: reviews jobs in a Review Queue; approves or returns to accountant.
- administrator: manages users, email/notification templates, and audit log.

PAGES (path -> what it is)
- /login : Sign in. Clients can self-register (creates a 'client' account).
- /dashboard : Staff home. Lists active jobs and their status. Accountants see only
  jobs assigned to them; reception/supervisor/admin see all.
- /clients : Manage clients and entities (individuals, companies, trusts). Each
  client's email is their portal login and must be unique. Create a job from an entity
  with "+ Job", choosing an Accountant and Supervisor from dropdowns.
- /job : A single job's detail. Shows stage/workflow, document requests, uploaded
  documents, staff assignment, and actions (request documents, move stage, reassign,
  send to supervisor review).
- /review : Supervisor-only Review Queue of jobs awaiting review; approve or return
  to accountant (a reason is required when returning).
- /admin : Administrator area. Tabs: Users (create/enable/disable accounts, set roles),
  Email Templates (edit notification/email text), Audit Log (activity trail).
- /portal : Client portal. "My Jobs" shows each job in plain language
  ("Waiting for your documents", "In review", "Ready to sign"). Clients upload
  requested documents and Review & Sign when a job is ready.
- /personal : Personal Tax Tracker — record income and deduction entries, with vehicle
  and home-office calculators, an Entries list, a Tax Report, and an estimated tax position.
- /business : Business Tax Tracker — sole trader revenue, expense & GST tracking, with a
  BAS Summary, Tax Report, and estimated GST position + net profit.
- /help : Role-based help centre.

JOB WORKFLOW (how a job moves)
Created (reception) -> Accountant requests documents -> Client uploads documents ->
Accountant processes and sends to Supervisor review -> Supervisor approves ->
Awaiting signature (client Reviews & Signs) -> Lodged/complete.
When an accountant adds a document request, the job is flagged "Action Required" for
the client until everything requested is received.

TAX TRACKER — SAVE/LOAD
- Data can be saved to the cloud per account+app. The top bar has a Save/Load control,
  a financial-year (FY) selector, and a storage indicator.
- Safety rule: the server refuses to overwrite existing records with an EMPTY save
  (error: "would overwrite N existing records with an empty save"). This prevents
  wiping data when the page saved before data finished loading. Fix: reload the page so
  data loads first; do NOT force an empty save.
- Tax Tracker always opens in LIGHT theme by default.

NOTIFICATIONS
- A bell in the top bar shows requests and status changes. Clicking a notification opens
  the related job.

TIPS FOR GUIDING USERS
- If a user is stuck on a step, explain the specific action for the page/tab they are on.
- Respect roles: never tell a client to do staff-only actions, and vice versa.
- For tax questions, give general educational guidance, not personal financial/legal advice;
  suggest confirming with their accountant for their specific situation.
`;

module.exports = { APP_KB };

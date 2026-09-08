// Successwa + Elite Client Hub backend.
// Serves static files + tax-tracker cloud API + Elite Client Hub (roles, jobs,
// workflow, documents, notifications, audit) API.
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const compression = require('compression');
const { Pool } = require('pg');
const wf = require('./workflow');
const { sendNotification } = require('./notify');

// Fire-and-forget notification: never blocks the HTTP response. The row is still
// written to the notifications table inside sendNotification; we just don't await it.
function notifyBg(opts) {
  Promise.resolve().then(() => sendNotification(pool, opts))
    .catch((e) => console.error('[notify]', (e && e.message) || e));
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX || 20),   // cap concurrent DB connections
  idleTimeoutMillis: 30000,                      // release idle clients
  connectionTimeoutMillis: 10000,                // fail fast if pool exhausted
  keepAlive: true,                               // avoid Neon dropping idle sockets
});
pool.on('error', (err) => { console.error('[pg pool error]', err.message); });

// ---- Password hashing (scrypt, async so it never blocks the event loop) ----
function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), s, 64, (err, derived) => {
      if (err) return reject(err);
      resolve({ salt: s, hash: derived.toString('hex') });
    });
  });
}
function verifyPassword(password, salt, expectedHash) {
  return new Promise((resolve) => {
    crypto.scrypt(String(password), salt, 64, (err, derived) => {
      if (err) return resolve(false);
      try { resolve(crypto.timingSafeEqual(derived, Buffer.from(expectedHash, 'hex'))); }
      catch (e) { resolve(false); }
    });
  });
}

const app = express();
app.use(compression()); // gzip HTML/JS/CSS/JSON responses
app.use(express.json({ limit: '20mb' }));

// Pretty URLs: redirect /foo.html -> /foo (keep the query string), so the
// address bar never shows the .html extension. Internal links still use .html
// and simply get redirected here.
app.use(function (req, res, next) {
  if (req.method === 'GET' && /\.html$/i.test(req.path)) {
    var clean = req.path.replace(/\.html$/i, '');
    var qs = req.originalUrl.slice(req.path.length); // preserves ?job=... etc.
    return res.redirect(302, clean + qs);
  }
  next();
});
// Root -> login (there is no index.html; avoid Express "Cannot GET /").
app.get('/', function (req, res) { res.redirect(302, '/login'); });
app.use(express.static(__dirname, {
  etag: true,
  extensions: ['html'], // /dashboard -> dashboard.html
  setHeaders: function (res, filePath) {
    // HTML must always revalidate (so ?v= bumps + content changes show immediately).
    // Other assets (js/css/png) are cache-busted via ?v= query, so cache them hard.
    if (/\.html$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=31536000');
  },
})); // serve *.html, *.js, *.css, logo.png

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const APPS = ['personal', 'business'];
function validApp(a) { return APPS.indexOf(a) !== -1; }
function normAccount(a) { return String(a || '').trim().toLowerCase(); }

// ---- Human-readable sequential IDs (CL-0001, EN-0001, JB-0001) ----
async function nextId(client, name, prefix) {
  const r = await client.query(
    `INSERT INTO id_counters (name, value) VALUES ($1, 1)
     ON CONFLICT (name) DO UPDATE SET value = id_counters.value + 1
     RETURNING value`, [name]);
  const n = r.rows[0].value;
  return prefix + String(n).padStart(4, '0');
}

// ---- Audit helper ----
async function audit(runner, actor, action, entityType, entityId, detail) {
  await runner.query(
    'INSERT INTO audit_log (actor_email, action, entity_type, entity_id, detail) VALUES ($1,$2,$3,$4,$5)',
    [actor || null, action, entityType || null, entityId || null, detail || null]);
}

// ================= AUTH =================
function newToken() { return crypto.randomBytes(32).toString('hex'); }

async function createSession(email, role) {
  const token = newToken();
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 14); // 14 days
  await pool.query(
    'INSERT INTO sessions (token, email, role, expires_at) VALUES ($1,$2,$3,$4)',
    [token, email, role, expires]);
  return token;
}

// In-memory session cache to avoid hitting the DB on every single request.
// Small TTL keeps it fresh enough while removing one DB round-trip per call.
const sessionCache = new Map(); // token -> { user, expiresAt (cache), sessionExp }
const SESSION_CACHE_MS = 60 * 1000;
function invalidateSession(token) { sessionCache.delete(token); }

// Middleware: attach req.user from Authorization: Bearer <token>
async function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.indexOf('Bearer ') === 0 ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'not authenticated' });

  const cached = sessionCache.get(token);
  if (cached && cached.cacheExp > Date.now()) {
    if (cached.sessionExp < Date.now()) { invalidateSession(token); return res.status(401).json({ error: 'session expired' }); }
    req.user = cached.user;
    return next();
  }

  try {
    const r = await pool.query(
      'SELECT s.email, s.role, s.expires_at, u.active, u.name FROM sessions s JOIN users u ON u.email=s.email WHERE s.token=$1',
      [token]);
    if (!r.rows.length) return res.status(401).json({ error: 'invalid session' });
    const s = r.rows[0];
    if (new Date(s.expires_at) < new Date()) return res.status(401).json({ error: 'session expired' });
    if (!s.active) return res.status(403).json({ error: 'account disabled' });
    const user = { email: s.email, role: s.role, name: s.name };
    sessionCache.set(token, { user: user, cacheExp: Date.now() + SESSION_CACHE_MS, sessionExp: new Date(s.expires_at).getTime() });
    req.user = user;
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}
function requireRole() {
  const roles = Array.prototype.slice.call(arguments);
  return function (req, res, next) {
    if (!req.user || roles.indexOf(req.user.role) === -1) {
      return res.status(403).json({ error: 'insufficient permissions' });
    }
    next();
  };
}
const STAFF = ['administrator', 'supervisor', 'accountant', 'reception'];

// POST /api/register { email, name, password }  (public self-registration = client role)
app.post('/api/register', async (req, res) => {
  const email = normAccount(req.body.email);
  const name = String(req.body.name || '').trim();
  const password = String(req.body.password || '');
  if (!email || email.indexOf('@') === -1) return res.status(400).json({ error: 'valid email required' });
  if (password.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
  try {
    const ex = await pool.query('SELECT email FROM users WHERE email=$1', [email]);
    if (ex.rows.length) return res.status(409).json({ error: 'an account with this email already exists' });
    const { salt, hash } = await hashPassword(password);
    await pool.query(
      "INSERT INTO users (email, name, pass_hash, pass_salt, role) VALUES ($1,$2,$3,$4,'client')",
      [email, name || null, hash, salt]);
    const token = await createSession(email, 'client');
    res.json({ ok: true, email, name, role: 'client', token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/login { email, password }
app.post('/api/login', async (req, res) => {
  const email = normAccount(req.body.email);
  const password = String(req.body.password || '');
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  try {
    const r = await pool.query('SELECT email, name, role, active, pass_hash, pass_salt FROM users WHERE email=$1', [email]);
    if (!r.rows.length) return res.status(401).json({ error: 'incorrect email or password' });
    const u = r.rows[0];
    if (!(await verifyPassword(password, u.pass_salt, u.pass_hash))) {
      return res.status(401).json({ error: 'incorrect email or password' });
    }
    if (!u.active) return res.status(403).json({ error: 'this account has been disabled' });
    const token = await createSession(u.email, u.role);
    res.json({ ok: true, email: u.email, name: u.name, role: u.role, token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/logout
app.post('/api/logout', requireAuth, async (req, res) => {
  const h = req.headers.authorization || '';
  const token = h.slice(7);
  try { invalidateSession(token); await pool.query('DELETE FROM sessions WHERE token=$1', [token]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/me
app.get('/api/me', requireAuth, (req, res) => res.json({ ok: true, user: req.user }));

// ================= CLIENTS & ENTITIES (staff) =================
app.get('/api/clients', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    let sql = 'SELECT * FROM clients';
    const params = [];
    if (q) { sql += ' WHERE lower(name) LIKE $1 OR lower(email) LIKE $1 OR lower(id) LIKE $1'; params.push('%' + q + '%'); }
    sql += ' ORDER BY id';
    const r = await pool.query(sql, params);
    res.json({ ok: true, clients: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clients', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = normAccount(req.body.email);
  const phone = String(req.body.phone || '').trim();
  if (!name) return res.status(400).json({ error: 'client name required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Guard against two clients sharing the same email (notifications route by client email).
    if (email) {
      const dup = await client.query('SELECT id FROM clients WHERE lower(email)=$1', [email]);
      if (dup.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'A client with this email already exists (' + dup.rows[0].id + ')' }); }
    }
    const id = await nextId(client, 'client', 'CL-');
    await client.query('INSERT INTO clients (id, name, email, phone) VALUES ($1,$2,$3,$4)',
      [id, name, email || null, phone || null]);
    await audit(client, req.user.email, 'client.create', 'client', id, { name, email });
    await client.query('COMMIT');
    res.json({ ok: true, id });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// PATCH /api/clients/:id — update a client's name/email/phone (with duplicate-email guard).
app.patch('/api/clients/:id', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  const id = String(req.params.id || '').trim();
  const name = String(req.body.name || '').trim();
  const email = normAccount(req.body.email);
  const phone = String(req.body.phone || '').trim();
  if (!name) return res.status(400).json({ error: 'client name required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ex = await client.query('SELECT id FROM clients WHERE id=$1', [id]);
    if (!ex.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'client not found' }); }
    if (email) {
      const dup = await client.query('SELECT id FROM clients WHERE lower(email)=$1 AND id<>$2', [email, id]);
      if (dup.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Another client already uses this email (' + dup.rows[0].id + ')' }); }
    }
    await client.query('UPDATE clients SET name=$1, email=$2, phone=$3 WHERE id=$4',
      [name, email || null, phone || null, id]);
    await audit(client, req.user.email, 'client.update', 'client', id, { name, email });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

app.get('/api/entities', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  try {
    const clientId = req.query.clientId;
    let sql = 'SELECT * FROM entities';
    const params = [];
    if (clientId) { sql += ' WHERE client_id=$1'; params.push(clientId); }
    sql += ' ORDER BY id';
    const r = await pool.query(sql, params);
    res.json({ ok: true, entities: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/entities', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  const clientId = String(req.body.clientId || '').trim();
  const entityName = String(req.body.entityName || '').trim();
  const entityType = String(req.body.entityType || '').trim().toLowerCase();
  const abn = String(req.body.abn || '').trim();
  const tfn = String(req.body.tfn || '').trim();
  const valid = ['individual', 'company', 'trust', 'smsf'];
  if (!clientId || !entityName) return res.status(400).json({ error: 'clientId and entityName required' });
  if (valid.indexOf(entityType) === -1) return res.status(400).json({ error: 'invalid entity type' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ex = await client.query('SELECT id FROM clients WHERE id=$1', [clientId]);
    if (!ex.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'client not found' }); }
    const id = await nextId(client, 'entity', 'EN-');
    await client.query('INSERT INTO entities (id, client_id, entity_name, entity_type, abn, tfn) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, clientId, entityName, entityType, abn || null, tfn || null]);
    await audit(client, req.user.email, 'entity.create', 'entity', id, { clientId, entityName, entityType });
    await client.query('COMMIT');
    res.json({ ok: true, id });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// ================= JOBS =================
// GET /api/jobs  (filters: accountant, supervisor, stage, clientId, q)
app.get('/api/jobs', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  try {
    const where = [];
    const params = [];
    function add(cond, val) { params.push(val); where.push(cond.replace('?', '$' + params.length)); }
    // Accountants can only see their OWN jobs — enforced server-side regardless of query params.
    if (req.user.role === 'accountant') add('j.accountant_email = ?', normAccount(req.user.email));
    if (req.query.accountant) add('j.accountant_email = ?', normAccount(req.query.accountant));
    if (req.query.supervisor) add('j.supervisor_email = ?', normAccount(req.query.supervisor));
    if (req.query.stage) add('j.stage = ?', req.query.stage);
    if (req.query.clientId) add('j.client_id = ?', req.query.clientId);
    if (req.query.q) {
      params.push('%' + req.query.q.toLowerCase() + '%');
      const p = '$' + params.length;
      where.push('(lower(c.name) LIKE ' + p + ' OR lower(j.id) LIKE ' + p + ' OR lower(c.id) LIKE ' + p + ')');
    }
    let sql =
      `SELECT j.*, c.name AS client_name, e.entity_name,
              ua.name AS accountant_name, us.name AS supervisor_name
       FROM jobs j
       JOIN clients c ON c.id = j.client_id
       LEFT JOIN entities e ON e.id = j.entity_id
       LEFT JOIN users ua ON lower(ua.email) = lower(j.accountant_email)
       LEFT JOIN users us ON lower(us.email) = lower(j.supervisor_email)`;
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY j.updated_at DESC';
    const r = await pool.query(sql, params);
    const jobs = r.rows.map((j) => {
      const daysInStage = Math.floor((Date.now() - new Date(j.stage_since).getTime()) / 86400000);
      const m = wf.STAGE_MAP[j.stage] || {};
      return Object.assign({}, j, {
        stage_label: m.internalLabel || j.stage,
        next_action: wf.NEXT_ACTION[j.stage] || '',
        days_in_stage: daysInStage,
      });
    });
    res.json({ ok: true, jobs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/jobs/:id  (full detail for staff)
app.get('/api/jobs/:id', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  try {
    const [jr, hist, docs, reqs, notif] = await Promise.all([
      pool.query(
        `SELECT j.*, c.name AS client_name, c.email AS client_email, e.entity_name, e.entity_type,
                ua.name AS accountant_name, us.name AS supervisor_name
         FROM jobs j JOIN clients c ON c.id=j.client_id
         LEFT JOIN entities e ON e.id=j.entity_id
         LEFT JOIN users ua ON lower(ua.email) = lower(j.accountant_email)
         LEFT JOIN users us ON lower(us.email) = lower(j.supervisor_email) WHERE j.id=$1`, [req.params.id]),
      pool.query('SELECT * FROM job_status_history WHERE job_id=$1 ORDER BY created_at', [req.params.id]),
      pool.query('SELECT * FROM documents WHERE job_id=$1 ORDER BY created_at DESC', [req.params.id]),
      pool.query('SELECT * FROM doc_requests WHERE job_id=$1 ORDER BY created_at DESC', [req.params.id]),
      pool.query('SELECT * FROM notifications WHERE job_id=$1 ORDER BY created_at DESC', [req.params.id]),
    ]);
    if (!jr.rows.length) return res.status(404).json({ error: 'job not found' });
    const job = jr.rows[0];
    // Accountants may only open their own jobs.
    if (req.user.role === 'accountant' && normAccount(job.accountant_email) !== normAccount(req.user.email)) {
      return res.status(403).json({ error: 'You can only view jobs assigned to you' });
    }
    job.stage_label = (wf.STAGE_MAP[job.stage] || {}).internalLabel || job.stage;
    job.next_action = wf.NEXT_ACTION[job.stage] || '';
    res.json({ ok: true, job, history: hist.rows, documents: docs.rows, docRequests: reqs.rows, notifications: notif.rows, stages: wf.STAGES, stageMap: wf.STAGE_MAP });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/jobs  create job
app.post('/api/jobs', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  const clientId = String(req.body.clientId || '').trim();
  const entityId = String(req.body.entityId || '').trim();
  const jobType = String(req.body.jobType || '').trim();
  const fy = String(req.body.financialYear || '').trim();
  const accountant = normAccount(req.body.accountant);
  const supervisor = normAccount(req.body.supervisor);
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  const roleErr = await validateAssignment(accountant, supervisor);
  if (roleErr) return res.status(400).json({ error: roleErr });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ex = await client.query('SELECT id FROM clients WHERE id=$1', [clientId]);
    if (!ex.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'client not found' }); }
    const id = await nextId(client, 'job', 'JB-');
    await client.query(
      `INSERT INTO jobs (id, client_id, entity_id, job_type, financial_year, accountant_email, supervisor_email, stage)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'01_created')`,
      [id, clientId, entityId || null, jobType || null, fy || null, accountant || null, supervisor || null]);
    await client.query('INSERT INTO job_status_history (job_id, from_stage, to_stage, changed_by, reason) VALUES ($1,$2,$3,$4,$5)',
      [id, null, '01_created', req.user.email, 'Job created']);
    await audit(client, req.user.email, 'job.create', 'job', id, { clientId, entityId, jobType, accountant, supervisor });
    await client.query('COMMIT');
    // Notify assigned staff that a new job has landed on their plate (background).
    const jobLabel = (jobType || 'Tax job') + (fy ? ' (' + fy + ')' : '');
    if (accountant) {
      notifyBg({
        jobId: id, toEmail: accountant,
        rawSubject: 'New job assigned: ' + id,
        rawBody: 'You have been assigned a new job ' + id + ' — ' + jobLabel +
          ' for client ' + ex.rows[0].id + '.\n\nAssigned by ' + req.user.email + '.',
      });
    }
    if (supervisor && supervisor !== accountant) {
      notifyBg({
        jobId: id, toEmail: supervisor,
        rawSubject: 'You are supervising job: ' + id,
        rawBody: 'You have been set as supervisor for new job ' + id + ' — ' + jobLabel +
          '.\n\nAssigned by ' + req.user.email + '.',
      });
    }
    res.json({ ok: true, id });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// Shared helper to change a job stage (records history, audit, fires notification).
async function changeStage(runner, job, toStage, actor, reason) {
  const from = job.stage;
  await runner.query('UPDATE jobs SET stage=$1, stage_since=now(), updated_at=now(), action_required=$3 WHERE id=$2',
    [toStage, job.id, toStage === '02_waiting_docs' || toStage === '06_awaiting_signature']);
  await runner.query('INSERT INTO job_status_history (job_id, from_stage, to_stage, changed_by, reason) VALUES ($1,$2,$3,$4,$5)',
    [job.id, from, toStage, actor, reason || null]);
  await audit(runner, actor, 'job.stage_change', 'job', job.id, { from, to: toStage, reason });
}

// POST /api/jobs/:id/stage { stage, reason }
app.post('/api/jobs/:id/stage', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  const toStage = String(req.body.stage || '');
  const reason = String(req.body.reason || '');
  if (!wf.isValidStage(toStage)) return res.status(400).json({ error: 'invalid stage' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jr = await client.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!jr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'job not found' }); }
    const job = jr.rows[0];
    if (!wf.canTransition(job.stage, toStage)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'invalid transition' }); }
    await changeStage(client, job, toStage, req.user.email, reason);
    await client.query('COMMIT');
    // Fire notification for the new stage (outside txn).
    await maybeNotifyStage(Object.assign({}, job, { stage: toStage }));
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// POST /api/jobs/:id/flags { onHold, actionRequired }
app.post('/api/jobs/:id/flags', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jr = await client.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!jr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'job not found' }); }
    const onHold = typeof req.body.onHold === 'boolean' ? req.body.onHold : jr.rows[0].on_hold;
    const actionReq = typeof req.body.actionRequired === 'boolean' ? req.body.actionRequired : jr.rows[0].action_required;
    await client.query('UPDATE jobs SET on_hold=$1, action_required=$2, updated_at=now() WHERE id=$3',
      [onHold, actionReq, req.params.id]);
    await audit(client, req.user.email, 'job.flags', 'job', req.params.id, { onHold, actionRequired: actionReq });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// Verify an email holds an allowed role before assigning it. Returns an error string or null.
async function validateAssignment(accEmail, supEmail) {
  if (accEmail) {
    const r = await pool.query('SELECT role FROM users WHERE lower(email)=$1 AND active=true', [accEmail]);
    if (!r.rows.length || r.rows[0].role !== 'accountant') {
      return 'Accountant must be an active user with the accountant role';
    }
  }
  if (supEmail) {
    const r = await pool.query('SELECT role FROM users WHERE lower(email)=$1 AND active=true', [supEmail]);
    if (!r.rows.length || r.rows[0].role !== 'supervisor') {
      return 'Supervisor must be an active user with the supervisor role';
    }
  }
  return null;
}

// GET /api/staff — active staff accounts (for assignment dropdowns).
app.get('/api/staff', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT email, name, role FROM users WHERE role IN ('administrator','supervisor','accountant','reception') AND active=true ORDER BY role, email");
    res.json({ ok: true, staff: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/jobs/:id/assign { accountant, supervisor } — reassign staff on an existing job.
// Only reception / supervisor / administrator may reassign.
app.post('/api/jobs/:id/assign', requireAuth, requireRole('reception', 'supervisor', 'administrator'), async (req, res) => {
  const newAcc = normAccount(req.body.accountant);
  const newSup = normAccount(req.body.supervisor);
  // Validate the chosen people actually hold the right role.
  const roleErr = await validateAssignment(newAcc, newSup);
  if (roleErr) return res.status(400).json({ error: roleErr });
  const client = await pool.connect();
  let job = null;
  try {
    await client.query('BEGIN');
    const jr = await client.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!jr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'job not found' }); }
    job = jr.rows[0];
    await client.query('UPDATE jobs SET accountant_email=$1, supervisor_email=$2, updated_at=now() WHERE id=$3',
      [newAcc || null, newSup || null, req.params.id]);
    await audit(client, req.user.email, 'job.assign', 'job', req.params.id, {
      accountant: newAcc, supervisor: newSup,
      prevAccountant: job.accountant_email, prevSupervisor: job.supervisor_email });
    await client.query('COMMIT');
    // Notify only newly-assigned staff (not if unchanged) — background.
    const label = (job.job_type || 'Tax job') + (job.financial_year ? ' (' + job.financial_year + ')' : '');
    if (newAcc && normAccount(job.accountant_email) !== newAcc) {
      notifyBg({ jobId: job.id, toEmail: newAcc,
        rawSubject: 'Job reassigned to you: ' + job.id,
        rawBody: 'You have been assigned job ' + job.id + ' — ' + label + '.\n\nReassigned by ' + req.user.email + '.' });
    }
    if (newSup && normAccount(job.supervisor_email) !== newSup && newSup !== newAcc) {
      notifyBg({ jobId: job.id, toEmail: newSup,
        rawSubject: 'You now supervise job: ' + job.id,
        rawBody: 'You have been set as supervisor for job ' + job.id + ' — ' + label + '.\n\nReassigned by ' + req.user.email + '.' });
    }
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// Notify helper: look up template + client email, send + log.
async function maybeNotifyStage(job) {
  const key = wf.notifyKeyForStage(job.stage);
  if (!key) return;
  try {
    const cr = await pool.query('SELECT c.email, c.name FROM clients c WHERE c.id=$1', [job.client_id]);
    if (!cr.rows.length || !cr.rows[0].email) return;
    notifyBg({
      jobId: job.id, toEmail: cr.rows[0].email, templateKey: key,
      vars: { clientName: cr.rows[0].name, jobId: job.id, clientStatus: wf.clientView(job).clientStatus },
    });
  } catch (e) { /* logged inside sendNotification */ }
}

// ================= SUPERVISOR REVIEW =================
app.get('/api/review/queue', requireAuth, requireRole('supervisor'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT j.*, c.name AS client_name, c.email AS client_email, e.entity_name,
              (SELECT COUNT(*)::int FROM documents d WHERE d.job_id=j.id) AS doc_count,
              (SELECT COUNT(*)::int FROM doc_requests dr WHERE dr.job_id=j.id AND dr.status='pending') AS pending_reqs
       FROM jobs j JOIN clients c ON c.id=j.client_id
       LEFT JOIN entities e ON e.id=j.entity_id
       WHERE j.stage='05_supervisor_review' ORDER BY j.stage_since`, []);
    const jobs = r.rows.map(function (j) {
      j.days_in_review = Math.floor((Date.now() - new Date(j.stage_since).getTime()) / 86400000);
      return j;
    });
    res.json({ ok: true, jobs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lightweight count of jobs awaiting supervisor review (for the nav badge).
app.get('/api/review/count', requireAuth, requireRole('supervisor'), async (req, res) => {
  try {
    const r = await pool.query("SELECT COUNT(*)::int AS n FROM jobs WHERE stage='05_supervisor_review'");
    res.json({ ok: true, count: r.rows[0].n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/review/:id/approve', requireAuth, requireRole('supervisor'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jr = await client.query("SELECT * FROM jobs WHERE id=$1 AND stage='05_supervisor_review' FOR UPDATE", [req.params.id]);
    if (!jr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'job not in review' }); }
    await changeStage(client, jr.rows[0], '06_awaiting_signature', req.user.email, 'Approved by supervisor');
    await audit(client, req.user.email, 'job.approved', 'job', req.params.id, {});
    await client.query('COMMIT');
    await maybeNotifyStage(Object.assign({}, jr.rows[0], { stage: '06_awaiting_signature' }));
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

app.post('/api/review/:id/return', requireAuth, requireRole('supervisor'), async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'a reason is required to return a job' });
  const client = await pool.connect();
  let returnedJob = null;
  try {
    await client.query('BEGIN');
    const jr = await client.query("SELECT * FROM jobs WHERE id=$1 AND stage='05_supervisor_review' FOR UPDATE", [req.params.id]);
    if (!jr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'job not in review' }); }
    returnedJob = jr.rows[0];
    await changeStage(client, returnedJob, '04_processing', req.user.email, 'Returned: ' + reason);
    await audit(client, req.user.email, 'job.returned', 'job', req.params.id, { reason });
    await client.query('COMMIT');
    // Notify the assigned accountant that the job was sent back, with the reason (background).
    if (returnedJob.accountant_email) {
      notifyBg({
        jobId: returnedJob.id,
        toEmail: returnedJob.accountant_email,
        rawSubject: 'Job ' + returnedJob.id + ' returned by supervisor',
        rawBody: 'Job ' + returnedJob.id + ' was returned to you by ' + req.user.email +
          '.\n\nReason: ' + reason + '\n\nPlease make the requested changes and resubmit for review.',
      });
    }
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// ================= DOCUMENTS =================
const ALLOWED_MIME = [
  'application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv', 'application/csv', 'text/plain',
];
// Some files (esp. CSV) get inconsistent MIME types across browsers/OSes,
// so we also accept these by extension as a fallback.
const ALLOWED_EXT = ['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.heif',
  '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt'];
const DOC_CATEGORIES = ['Income', 'PAYG', 'Rental Property', 'Investments', 'Shares', 'Crypto',
  'Business', 'Motor Vehicle', 'Expenses', 'Superannuation', 'Private Health',
  'Bank Statements', 'Previous Tax Documents', 'Other'];
const storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, UPLOAD_DIR); },
  filename: function (req, file, cb) {
    const safe = file.originalname.replace(/[^\w.\-]+/g, '_');
    cb(null, Date.now() + '_' + crypto.randomBytes(4).toString('hex') + '_' + safe);
  },
});
const upload = multer({
  storage: storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ALLOWED_MIME.indexOf(file.mimetype) !== -1 || ALLOWED_EXT.indexOf(ext) !== -1) return cb(null, true);
    return cb(new Error('file type not allowed: ' + (file.mimetype || ext || 'unknown')));
  },
});

app.get('/api/doc-categories', requireAuth, (req, res) => res.json({ ok: true, categories: DOC_CATEGORIES }));

// Both staff and the owning client can upload.
app.post('/api/documents/upload', requireAuth, upload.single('file'), async (req, res) => {
  const jobId = String(req.body.jobId || '').trim();
  const category = String(req.body.category || 'Other').trim();
  if (!req.file) return res.status(400).json({ error: 'file required' });
  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jr = await client.query('SELECT j.*, c.email AS client_email FROM jobs j JOIN clients c ON c.id=j.client_id WHERE j.id=$1', [jobId]);
    if (!jr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'job not found' }); }
    const job = jr.rows[0];
    // Client can only upload to their own job.
    if (req.user.role === 'client' && normAccount(job.client_email) !== normAccount(req.user.email)) {
      await client.query('ROLLBACK'); return res.status(403).json({ error: 'not your job' });
    }
    await client.query(
      `INSERT INTO documents (job_id, client_id, entity_id, category, filename, stored_path, mime, size, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [jobId, job.client_id, job.entity_id, category, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, req.user.email]);
    await audit(client, req.user.email, 'document.upload', 'job', jobId, { category, filename: req.file.originalname });
    await client.query('COMMIT');

    // If the CLIENT uploaded, let the assigned accountant know so they can action it (background).
    if (req.user.role === 'client' && job.accountant_email) {
      notifyBg({
        jobId: job.id, toEmail: job.accountant_email,
        rawSubject: 'Client uploaded a document: ' + job.id,
        rawBody: 'The client uploaded "' + req.file.originalname + '" (' + category + ') to job ' + job.id + '.\n\nLog in to review it.',
      });
    }
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// GET /api/documents/:id/download
app.get('/api/documents/:id/download', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT d.*, c.email AS client_email FROM documents d JOIN clients c ON c.id=d.client_id WHERE d.id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'document not found' });
    const doc = r.rows[0];
    if (req.user.role === 'client' && normAccount(doc.client_email) !== normAccount(req.user.email)) {
      return res.status(403).json({ error: 'not your document' });
    }
    const p = path.join(UPLOAD_DIR, doc.stored_path);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'file missing on disk' });
    // ?inline=1 → open in-browser (preview) instead of forcing a download.
    if (String(req.query.inline || '') === '1') {
      if (doc.mime) res.type(doc.mime);
      res.setHeader('Content-Disposition', 'inline; filename="' + doc.filename.replace(/"/g, '') + '"');
      return fs.createReadStream(p).pipe(res);
    }
    res.download(p, doc.filename);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/documents/:id', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM documents WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    const doc = r.rows[0];
    await pool.query('DELETE FROM documents WHERE id=$1', [req.params.id]);
    try { fs.unlinkSync(path.join(UPLOAD_DIR, doc.stored_path)); } catch (e) {}
    await audit(pool, req.user.email, 'document.delete', 'document', String(req.params.id), { filename: doc.filename });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ================= OUTSTANDING DOC REQUESTS =================
app.post('/api/doc-requests', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  const jobId = String(req.body.jobId || '').trim();
  const description = String(req.body.description || '').trim();
  const category = String(req.body.category || '').trim();
  const dueDate = req.body.dueDate || null;
  if (!jobId || !description) return res.status(400).json({ error: 'jobId and description required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jr = await client.query('SELECT * FROM jobs WHERE id=$1', [jobId]);
    if (!jr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'job not found' }); }
    await client.query('INSERT INTO doc_requests (job_id, category, description, due_date, created_by) VALUES ($1,$2,$3,$4,$5)',
      [jobId, category || null, description, dueDate || null, req.user.email]);
    // Requesting docs flags the client to act.
    await client.query('UPDATE jobs SET action_required=true, updated_at=now() WHERE id=$1', [jobId]);
    await audit(client, req.user.email, 'docrequest.create', 'job', jobId, { description, dueDate });
    await client.query('COMMIT');
    await maybeNotifyStage(Object.assign({}, jr.rows[0], { stage: '02_waiting_docs' }));
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

app.post('/api/doc-requests/:id/received', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query("UPDATE doc_requests SET status='received', received_at=now() WHERE id=$1 RETURNING job_id", [req.params.id]);
    if (!r.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
    const jobId = r.rows[0].job_id;
    const rem = await client.query("SELECT COUNT(*)::int AS n FROM doc_requests WHERE job_id=$1 AND status='pending'", [jobId]);
    if (rem.rows[0].n === 0) await client.query('UPDATE jobs SET action_required=false, updated_at=now() WHERE id=$1', [jobId]);
    await audit(client, req.user.email, 'docrequest.received', 'job', jobId, { requestId: req.params.id });
    await client.query('COMMIT');
    res.json({ ok: true, remaining: rem.rows[0].n });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// DELETE /api/doc-requests/:id  (remove a request, e.g. a duplicate)
app.delete('/api/doc-requests/:id', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('DELETE FROM doc_requests WHERE id=$1 RETURNING job_id', [req.params.id]);
    if (!r.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
    const jobId = r.rows[0].job_id;
    // If no pending requests remain, clear the ACTION REQUIRED flag.
    const rem = await client.query("SELECT COUNT(*)::int AS n FROM doc_requests WHERE job_id=$1 AND status='pending'", [jobId]);
    if (rem.rows[0].n === 0) await client.query('UPDATE jobs SET action_required=false, updated_at=now() WHERE id=$1', [jobId]);
    await audit(client, req.user.email, 'docrequest.delete', 'job', jobId, { requestId: req.params.id });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// ================= NOTIFICATIONS =================
app.post('/api/notifications/:id/resend', requireAuth, requireRole('administrator', 'supervisor', 'reception'), async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM notifications WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    const n = r.rows[0];
    await sendNotification(pool, { jobId: n.job_id, toEmail: n.to_email, templateKey: n.template_key, rawSubject: n.subject, rawBody: n.body, resend: true });
    await audit(pool, req.user.email, 'notification.resend', 'notification', String(req.params.id), {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/notifications', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 200');
    res.json({ ok: true, notifications: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Personal notification bell (any logged-in user sees notifications addressed to them) ----
// Unread count for the nav bell.
app.get('/api/my-notifications/count', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT COUNT(*)::int AS n FROM notifications WHERE lower(to_email)=$1 AND read_at IS NULL',
      [normAccount(req.user.email)]);
    res.json({ ok: true, count: r.rows[0].n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Recent notifications addressed to the current user.
app.get('/api/my-notifications', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, job_id, subject, body, status, read_at, created_at FROM notifications WHERE lower(to_email)=$1 ORDER BY created_at DESC LIMIT 50',
      [normAccount(req.user.email)]);
    res.json({ ok: true, notifications: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mark all of the current user's notifications as read.
app.post('/api/my-notifications/read', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET read_at=now() WHERE lower(to_email)=$1 AND read_at IS NULL',
      [normAccount(req.user.email)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Clear (delete) all of the current user's notifications.
app.post('/api/my-notifications/clear', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM notifications WHERE lower(to_email)=$1', [normAccount(req.user.email)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ================= ADMIN =================
app.get('/api/admin/users', requireAuth, requireRole('administrator'), async (req, res) => {
  try {
    const r = await pool.query('SELECT email, name, role, active, created_at FROM users ORDER BY created_at DESC');
    res.json({ ok: true, users: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users', requireAuth, requireRole('administrator'), async (req, res) => {
  const email = normAccount(req.body.email);
  const name = String(req.body.name || '').trim();
  const password = String(req.body.password || '');
  const role = String(req.body.role || 'client').trim().toLowerCase();
  const roles = ['administrator', 'supervisor', 'accountant', 'reception', 'client'];
  if (!email || email.indexOf('@') === -1) return res.status(400).json({ error: 'valid email required' });
  if (roles.indexOf(role) === -1) return res.status(400).json({ error: 'invalid role' });
  if (password.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
  try {
    const ex = await pool.query('SELECT email FROM users WHERE email=$1', [email]);
    if (ex.rows.length) return res.status(409).json({ error: 'email already exists' });
    const { salt, hash } = await hashPassword(password);
    await pool.query('INSERT INTO users (email, name, pass_hash, pass_salt, role) VALUES ($1,$2,$3,$4,$5)',
      [email, name || null, hash, salt, role]);
    await audit(pool, req.user.email, 'user.create', 'user', email, { role });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/users/:email', requireAuth, requireRole('administrator'), async (req, res) => {
  const email = normAccount(req.params.email);
  const role = req.body.role ? String(req.body.role).toLowerCase() : null;
  const active = typeof req.body.active === 'boolean' ? req.body.active : null;
  const roles = ['administrator', 'supervisor', 'accountant', 'reception', 'client'];
  if (role && roles.indexOf(role) === -1) return res.status(400).json({ error: 'invalid role' });
  try {
    if (role !== null) await pool.query('UPDATE users SET role=$1 WHERE email=$2', [role, email]);
    if (active !== null) {
      await pool.query('UPDATE users SET active=$1 WHERE email=$2', [active, email]);
      if (!active) { await pool.query('DELETE FROM sessions WHERE email=$1', [email]); sessionCache.clear(); } // kick disabled user
    }
    await audit(pool, req.user.email, 'user.update', 'user', email, { role, active });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/admin/users/:email — permanently remove a login account.
app.delete('/api/admin/users/:email', requireAuth, requireRole('administrator'), async (req, res) => {
  const email = normAccount(req.params.email);
  if (email === normAccount(req.user.email)) {
    return res.status(400).json({ error: 'you cannot delete your own account' });
  }
  try {
    const ex = await pool.query('SELECT email FROM users WHERE email=$1', [email]);
    if (!ex.rows.length) return res.status(404).json({ error: 'user not found' });
    await pool.query('DELETE FROM sessions WHERE email=$1', [email]);
    await pool.query('DELETE FROM users WHERE email=$1', [email]);
    sessionCache.clear(); // drop any cached session for the removed user
    await audit(pool, req.user.email, 'user.delete', 'user', email, {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/templates', requireAuth, requireRole('administrator'), async (req, res) => {
  try { const r = await pool.query('SELECT * FROM notification_templates ORDER BY key'); res.json({ ok: true, templates: r.rows }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/templates/:key', requireAuth, requireRole('administrator'), async (req, res) => {
  const key = String(req.params.key);
  const subject = String(req.body.subject || '').trim();
  const body = String(req.body.body || '').trim();
  if (!subject || !body) return res.status(400).json({ error: 'subject and body required' });
  try {
    await pool.query(
      `INSERT INTO notification_templates (key, subject, body, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (key) DO UPDATE SET subject=EXCLUDED.subject, body=EXCLUDED.body, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [key, subject, body, req.user.email]);
    await audit(pool, req.user.email, 'template.update', 'template', key, {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/audit', requireAuth, requireRole('administrator', 'supervisor'), async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 300');
    res.json({ ok: true, audit: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ================= CLIENT PORTAL =================
// Builds a client-facing "next action" message that matches the job's real situation.
// - If documents are still outstanding -> ask to upload them.
// - If the job is awaiting the client's signature -> ask to review & sign.
// - Otherwise no action is required from the client.
function portalNextAction(job, view, outstanding) {
  if (outstanding > 0) return 'Please upload the requested documents.';
  if (job.stage === '06_awaiting_signature' && !job.on_hold) return 'Please review and sign your documents.';
  return '';
}

// Returns only the client's own jobs with client-safe status (never internal notes).
app.get('/api/portal/jobs', requireAuth, requireRole('client'), async (req, res) => {
  try {
    const cr = await pool.query('SELECT id, name FROM clients WHERE lower(email)=$1', [normAccount(req.user.email)]);
    if (!cr.rows.length) return res.json({ ok: true, jobs: [], clientId: null });
    const clientId = cr.rows[0].id;
    const jr = await pool.query(
      `SELECT j.id, j.job_type, j.financial_year, j.stage, j.on_hold, j.action_required, j.updated_at,
              e.entity_name FROM jobs j LEFT JOIN entities e ON e.id=j.entity_id
       WHERE j.client_id=$1 ORDER BY j.updated_at DESC`, [clientId]);
    const jobs = [];
    for (const j of jr.rows) {
      const view = wf.clientView(j);
      const rem = await pool.query("SELECT COUNT(*)::int AS n FROM doc_requests WHERE job_id=$1 AND status='pending'", [j.id]);
      jobs.push({
        id: j.id, jobType: j.job_type, financialYear: j.financial_year, entityName: j.entity_name,
        clientStatus: view.clientStatus, clientMessage: view.clientMessage, progressPct: view.progressPct,
        lastUpdate: j.updated_at, outstanding: rem.rows[0].n,
        nextAction: portalNextAction(j, view, rem.rows[0].n),
      });
    }
    res.json({ ok: true, clientId, jobs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/portal/jobs/:id', requireAuth, requireRole('client'), async (req, res) => {
  try {
    const cr = await pool.query('SELECT id FROM clients WHERE lower(email)=$1', [normAccount(req.user.email)]);
    if (!cr.rows.length) return res.status(404).json({ error: 'no client profile' });
    const jr = await pool.query('SELECT * FROM jobs WHERE id=$1 AND client_id=$2', [req.params.id, cr.rows[0].id]);
    if (!jr.rows.length) return res.status(404).json({ error: 'job not found' });
    const j = jr.rows[0];
    const view = wf.clientView(j);
    const reqs = await pool.query("SELECT id, category, description, due_date, status FROM doc_requests WHERE job_id=$1 ORDER BY created_at DESC", [req.params.id]);
    const docs = await pool.query('SELECT id, category, filename, uploaded_by, created_at FROM documents WHERE job_id=$1 ORDER BY created_at DESC', [req.params.id]);
    res.json({ ok: true, job: {
      id: j.id, jobType: j.job_type, financialYear: j.financial_year,
      clientStatus: view.clientStatus, clientMessage: view.clientMessage, progressPct: view.progressPct, lastUpdate: j.updated_at,
      canSign: j.stage === '06_awaiting_signature' && !j.on_hold,
    }, docRequests: reqs.rows, documents: docs.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/portal/documents/:id — a client removes a document THEY uploaded on THEIR job.
app.delete('/api/portal/documents/:id', requireAuth, requireRole('client'), async (req, res) => {
  try {
    const cr = await pool.query('SELECT id FROM clients WHERE lower(email)=$1', [normAccount(req.user.email)]);
    if (!cr.rows.length) return res.status(404).json({ error: 'no client profile' });
    const r = await pool.query('SELECT * FROM documents WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'document not found' });
    const doc = r.rows[0];
    // Must belong to this client AND have been uploaded by this client.
    if (doc.client_id !== cr.rows[0].id || normAccount(doc.uploaded_by) !== normAccount(req.user.email)) {
      return res.status(403).json({ error: 'you can only delete documents you uploaded' });
    }
    await pool.query('DELETE FROM documents WHERE id=$1', [req.params.id]);
    try { fs.unlinkSync(path.join(UPLOAD_DIR, doc.stored_path)); } catch (e) {}
    await audit(pool, req.user.email, 'document.delete', 'document', String(req.params.id), { filename: doc.filename, by: 'client' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/portal/jobs/:id/sign — client confirms & signs; advances to Ready for Lodgement.
app.post('/api/portal/jobs/:id/sign', requireAuth, requireRole('client'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cr = await client.query('SELECT id FROM clients WHERE lower(email)=$1', [normAccount(req.user.email)]);
    if (!cr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'no client profile' }); }
    const jr = await client.query('SELECT * FROM jobs WHERE id=$1 AND client_id=$2 FOR UPDATE', [req.params.id, cr.rows[0].id]);
    if (!jr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'job not found' }); }
    const job = jr.rows[0];
    if (job.stage !== '06_awaiting_signature') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'this job is not awaiting your signature' }); }
    if (job.on_hold) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'this job is on hold' }); }
    const signerName = String((req.body && req.body.name) || '').trim() || req.user.email;
    await client.query('UPDATE jobs SET signed_by=$1, signed_at=now() WHERE id=$2', [signerName, job.id]);
    await changeStage(client, job, '07_ready_lodgement', req.user.email, 'Signed by client: ' + signerName);
    await audit(client, req.user.email, 'job.signed', 'job', job.id, { signedBy: signerName });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// ================= EXISTING TAX-TRACKER API (unchanged) =================
function recordsOf(appName, data) {
  if (!data) return [];
  if (appName === 'business') return Array.isArray(data.transactions) ? data.transactions : [];
  return Array.isArray(data.entries) ? data.entries : [];
}

async function syncFlat(client, account, appName, data) {
  await client.query('DELETE FROM transactions WHERE account=$1 AND app=$2', [account, appName]);
  const rows = recordsOf(appName, data);
  for (const t of rows) {
    if (!t || !t.id) continue;
    await client.query(
      `INSERT INTO transactions (id, account, app, type, date, category, description, party, amount, gst, notes, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         account=EXCLUDED.account, app=EXCLUDED.app, type=EXCLUDED.type, date=EXCLUDED.date,
         category=EXCLUDED.category, description=EXCLUDED.description, party=EXCLUDED.party,
         amount=EXCLUDED.amount, gst=EXCLUDED.gst, notes=EXCLUDED.notes, raw=EXCLUDED.raw, updated_at=now()`,
      [
        String(t.id), account, appName, t.type || null,
        t.date || null, t.category || null, t.description || null,
        t.party || t.source || null,
        typeof t.amount === 'number' ? t.amount : null,
        typeof t.gstAmount === 'number' ? t.gstAmount : null,
        t.notes || null, t,
      ]);
  }
}

app.post('/api/save', async (req, res) => {
  const appName = req.body.app;
  const account = normAccount(req.body.account);
  const data = req.body.data;
  if (!validApp(appName)) return res.status(400).json({ error: 'invalid app' });
  if (!account) return res.status(400).json({ error: 'account required' });
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'data required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const incomingCount = recordsOf(appName, data).length;
    if (incomingCount === 0 && req.body.force !== true) {
      const ex = await client.query('SELECT data FROM customer_data WHERE account=$1 AND app=$2', [account, appName]);
      if (ex.rows.length && recordsOf(appName, ex.rows[0].data).length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'refused: would overwrite ' + recordsOf(appName, ex.rows[0].data).length +
                 ' existing records with an empty save. Send force:true to override.'
        });
      }
    }
    await client.query(
      `INSERT INTO customer_data (account, app, data, updated_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (account, app) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`,
      [account, appName, data]);
    await syncFlat(client, account, appName, data);
    await client.query('COMMIT');
    res.json({ ok: true, account, app: appName, records: recordsOf(appName, data).length });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

app.get('/api/load', async (req, res) => {
  const appName = req.query.app;
  const account = normAccount(req.query.account);
  if (!validApp(appName)) return res.status(400).json({ error: 'invalid app' });
  if (!account) return res.status(400).json({ error: 'account required' });
  try {
    const r = await pool.query('SELECT data, updated_at FROM customer_data WHERE account=$1 AND app=$2', [account, appName]);
    if (!r.rows.length) return res.status(404).json({ error: 'no saved data for this account' });
    res.json({ ok: true, data: r.rows[0].data, updatedAt: r.rows[0].updated_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/list', async (req, res) => {
  const account = normAccount(req.query.account);
  if (!account) return res.status(400).json({ error: 'account required' });
  try {
    const r = await pool.query('SELECT app, updated_at FROM customer_data WHERE account=$1 ORDER BY app', [account]);
    res.json({ ok: true, saves: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/merge', async (req, res) => {
  const appName = req.body.app;
  const account = normAccount(req.body.account);
  const incoming = req.body.data;
  if (!validApp(appName)) return res.status(400).json({ error: 'invalid app' });
  if (!account) return res.status(400).json({ error: 'account required' });
  if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'data required' });
  const key = appName === 'business' ? 'transactions' : 'entries';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT data FROM customer_data WHERE account=$1 AND app=$2 FOR UPDATE', [account, appName]);
    let base = cur.rows.length ? cur.rows[0].data : incoming;
    if (cur.rows.length) {
      const seen = {};
      (base[key] || []).forEach((x) => { if (x && x.id) seen[x.id] = true; });
      let added = 0;
      (incoming[key] || []).forEach((x) => {
        if (x && x.id && !seen[x.id]) { base[key].push(x); seen[x.id] = true; added++; }
      });
      if (appName === 'personal' && Array.isArray(incoming.statements)) {
        base.statements = base.statements || [];
        const sids = {};
        base.statements.forEach((s) => { if (s && s.id) sids[s.id] = true; });
        incoming.statements.forEach((s) => { if (s && s.id && !sids[s.id]) { base.statements.push(s); sids[s.id] = true; } });
      }
      base._merged = added;
    }
    await client.query(
      `INSERT INTO customer_data (account, app, data, updated_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (account, app) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`,
      [account, appName, base]);
    await syncFlat(client, account, appName, base);
    await client.query('COMMIT');
    res.json({ ok: true, data: base, records: (base[key] || []).length });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

app.get('/api/export', async (req, res) => {
  const appName = req.query.app;
  const account = normAccount(req.query.account);
  if (!validApp(appName)) return res.status(400).json({ error: 'invalid app' });
  if (!account) return res.status(400).json({ error: 'account required' });
  try {
    const r = await pool.query('SELECT data FROM customer_data WHERE account=$1 AND app=$2', [account, appName]);
    if (!r.rows.length) return res.status(404).json({ error: 'no saved data' });
    const payload = {
      app: 'successwa-' + appName, version: 1,
      exportedAt: new Date().toISOString(), account, data: r.rows[0].data,
    };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="successwa-${appName}-${account}.json"`);
    res.send(JSON.stringify(payload, null, 2));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Multer / generic error handler
app.use(function (err, req, res, next) {
  if (err) return res.status(400).json({ error: err.message });
  next();
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log('Successwa + Elite Client Hub server running on http://localhost:' + PORT));

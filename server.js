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
const { Pool, types } = require('pg');
// Postgres DATE (OID 1082) is otherwise parsed into a JS Date at local midnight,
// which shifts back a day when serialized to UTC JSON. Keep dates as 'YYYY-MM-DD'.
types.setTypeParser(1082, (v) => v);
const wf = require('./workflow');
const checklists = require('./checklists');
const reminders = require('./reminders');
const recurring = require('./recurring');
const { sendNotification } = require('./notify');
const gdrive = require('./google-drive');
const gauth = require('./google-auth');
const fbauth = require('./facebook-auth');
const mfa = require('./mfa');
const setmore = require('./setmore');

// Fire-and-forget notification: never blocks the HTTP response. The row is still
// written to the notifications table inside sendNotification; we just don't await it.
function notifyBg(opts) {
  Promise.resolve().then(() => sendNotification(pool, opts))
    .catch((e) => console.error('[notify]', (e && e.message) || e));
}

// Fire-and-forget Google Drive backup of an uploaded document. Never blocks the
// HTTP response and never breaks the upload flow if Drive is down/not connected.
// On success, records the Drive file id back on the documents row.
function driveBackupBg(docId, clientId, opts) {
  Promise.resolve().then(async () => {
    if (!gdrive.isConfigured()) return;            // no OAuth env -> skip silently
    if (!(await gdrive.isConnected(pool))) return; // firm hasn't connected Drive -> skip
    const r = await gdrive.uploadFileToDrive(pool, opts);
    if (r && r.fileId && docId) {
      await pool.query('UPDATE documents SET drive_file_id=$1 WHERE id=$2', [r.fileId, docId]);
    }
    // Cache the shareable client-folder link on the client so staff can open it from a job.
    if (r && r.folderLink && clientId) {
      await pool.query(
        'UPDATE clients SET drive_folder_id=$1, drive_folder_link=$2 WHERE id=$3',
        [r.folderId || null, r.folderLink, clientId]);
    }
  }).catch((e) => console.error('[drive backup]', (e && e.message) || e));
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

// Pre-warm a handful of pooled connections on boot + periodically ping them so
// Neon doesn't drop them. Without this, the first analytics request (which fans
// out ~35 concurrent queries) pays to open many TLS connections at once (~3-5s).
const PREWARM = Math.min(8, Number(process.env.PG_POOL_MAX || 20));
async function warmPool() {
  try { await Promise.all(Array.from({ length: PREWARM }, () => pool.query('SELECT 1'))); }
  catch (e) { /* best-effort */ }
}
warmPool();
setInterval(warmPool, 25000).unref();

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
app.set('trust proxy', 1); // behind nginx/PM2 -> req.ip is the real client IP
app.use(compression()); // gzip HTML/JS/CSS/JSON responses
app.use(express.json({ limit: '20mb' }));

// Baseline security headers (hand-rolled; avoids pulling in helmet for ~6 headers).
// Blocks framing (clickjacking) + MIME sniffing, and forces HTTPS once behind TLS.
app.use(function (req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
// ponytail: headers set manually — upgrade to `helmet` + strict nonce CSP when inline scripts are removed.


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

// Mask an email for display in the MFA prompt, e.g. "jane.doe@x.com" -> "j****e@x.com".
function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 0) return s;
  const local = s.slice(0, at), domain = s.slice(at);
  if (local.length <= 2) return local[0] + '*' + domain;
  return local[0] + '****' + local[local.length - 1] + domain;
}

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

// Ensure a `clients` row exists for a client user (self sign-up / social login
// only create a `users` row). Returns the client id. Safe to call repeatedly.
async function ensureClientForUser(email, name) {
  const e = normAccount(email);
  if (!e) return null;
  const existing = await pool.query('SELECT id FROM clients WHERE lower(email)=$1 ORDER BY id LIMIT 1', [e]);
  if (existing.rows.length) return existing.rows[0].id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = await nextId(client, 'client', 'CL-');
    // Rely on the unique index clients_email_lower_uidx: if a concurrent request
    // already inserted this email, DO NOTHING and we fall through to the re-select.
    const ins = await client.query(
      `INSERT INTO clients (id, name, email) VALUES ($1,$2,$3)
       ON CONFLICT (lower(email)) WHERE email IS NOT NULL DO NOTHING
       RETURNING id`,
      [id, String(name || '').trim() || e, e]);
    if (ins.rows.length) {
      await audit(client, e, 'client.auto_create', 'client', ins.rows[0].id, { via: 'self-service' });
      await client.query('COMMIT');
      return ins.rows[0].id;
    }
    // Conflict: someone else created it. Roll back our unused id bump and re-read.
    await client.query('ROLLBACK');
    const again = await pool.query('SELECT id FROM clients WHERE lower(email)=$1 ORDER BY id LIMIT 1', [e]);
    return again.rows.length ? again.rows[0].id : null;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e2) {}
    console.error('[ensureClientForUser]', err && err.message);
    // Last-ditch: the row may exist now despite the error.
    const fb = await pool.query('SELECT id FROM clients WHERE lower(email)=$1 ORDER BY id LIMIT 1', [e]);
    return fb.rows.length ? fb.rows[0].id : null;
  } finally { client.release(); }
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

// Legacy tax-tracker data (customer_data) is keyed by an `account` (email) supplied
// by the caller. Ensure the caller may only read/write their OWN account — staff may
// access any account. Must run AFTER requireAuth so req.user is set.
function enforceAccountAccess(req, res, next) {
  const account = normAccount((req.body && req.body.account) || (req.query && req.query.account));
  if (!account) return res.status(400).json({ error: 'account required' });
  const isStaff = req.user && STAFF.indexOf(req.user.role) !== -1;
  if (!isStaff && account !== normAccount(req.user.email)) {
    return res.status(403).json({ error: 'you can only access your own account data' });
  }
  next();
}

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
    await ensureClientForUser(email, name);
    const token = await createSession(email, 'client');
    res.json({ ok: true, email, name, role: 'client', token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Brute-force guard for login: max attempts per IP+email per rolling window.
const LOGIN_RL_WINDOW_MS = 15 * 60 * 1000; // 15 min
const LOGIN_RL_MAX = Number(process.env.LOGIN_RATE_MAX || 10);
const loginHits = new Map(); // key -> [timestamps]
function loginRateLimited(key) {
  const now = Date.now();
  const arr = (loginHits.get(key) || []).filter((t) => now - t < LOGIN_RL_WINDOW_MS);
  arr.push(now);
  loginHits.set(key, arr);
  return arr.length > LOGIN_RL_MAX;
}
// Opportunistic cleanup so the map can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of loginHits) {
    const live = arr.filter((t) => now - t < LOGIN_RL_WINDOW_MS);
    if (live.length) loginHits.set(k, live); else loginHits.delete(k);
  }
}, LOGIN_RL_WINDOW_MS).unref();

// POST /api/login { email, password }
app.post('/api/login', async (req, res) => {
  const email = normAccount(req.body.email);
  const password = String(req.body.password || '');
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  if (loginRateLimited(req.ip + '|' + email)) {
    return res.status(429).json({ error: 'Too many login attempts. Please wait a few minutes and try again.' });
  }
  try {
    const r = await pool.query(
      'SELECT email, name, role, active, pass_hash, pass_salt, mfa_enabled, mfa_method, mfa_secret FROM users WHERE email=$1',
      [email]);
    if (!r.rows.length) return res.status(401).json({ error: 'incorrect email or password' });
    const u = r.rows[0];
    if (!(await verifyPassword(password, u.pass_salt, u.pass_hash))) {
      return res.status(401).json({ error: 'incorrect email or password' });
    }
    if (!u.active) return res.status(403).json({ error: 'this account has been disabled' });

    // ---- Password OK. If MFA is enabled, require a second factor. ----
    if (u.mfa_enabled && u.mfa_method) {
      mfa.purgeExpired(pool);
      if (u.mfa_method === 'email') {
        const code = mfa.sixDigitCode();
        const challengeId = await mfa.createChallenge(pool, { email: u.email, purpose: 'login', method: 'email', code });
        notifyBg({
          toEmail: u.email,
          rawSubject: 'Your Successwa sign-in code',
          rawBody: 'Your verification code is ' + code + '\n\nIt expires in 10 minutes. If you did not try to sign in, you can ignore this email.',
        });
        return res.json({ ok: true, mfaRequired: true, method: 'email', challengeId, maskedEmail: maskEmail(u.email) });
      }
      // totp
      const challengeId = await mfa.createChallenge(pool, { email: u.email, purpose: 'login', method: 'totp', code: null });
      return res.json({ ok: true, mfaRequired: true, method: 'totp', challengeId });
    }

    // No MFA — issue the session token directly.
    const token = await createSession(u.email, u.role);
    res.json({ ok: true, email: u.email, name: u.name, role: u.role, token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/login/verify { challengeId, code } — complete an MFA login.
app.post('/api/login/verify', async (req, res) => {
  const challengeId = String(req.body.challengeId || '');
  const code = String(req.body.code || '').trim();
  if (!challengeId || !code) return res.status(400).json({ error: 'code required' });
  try {
    // For TOTP we need the user's stored secret; look it up via the challenge's email.
    const cr = await pool.query('SELECT * FROM mfa_challenges WHERE id=$1', [challengeId]);
    if (!cr.rows.length) return res.status(400).json({ error: 'This verification request is invalid or has expired.' });
    const email = cr.rows[0].email;
    const ur = await pool.query('SELECT email, name, role, active, mfa_secret FROM users WHERE email=$1', [email]);
    if (!ur.rows.length) return res.status(400).json({ error: 'account not found' });
    const u = ur.rows[0];

    const result = await mfa.verifyChallenge(pool, { id: challengeId, code, totpSecret: u.mfa_secret });
    if (!result.ok) return res.status(401).json({ error: result.error });
    if (!u.active) return res.status(403).json({ error: 'this account has been disabled' });

    const token = await createSession(u.email, u.role);
    res.json({ ok: true, email: u.email, name: u.name, role: u.role, token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ================= "Continue with Google" sign-in =================
// Login-only OAuth (identity scopes only), separate from the Drive integration.
// State is HMAC-signed + time-limited so it is unforgeable and cluster-safe
// (no shared memory needed across PM2 workers).
function googleStateSecret() {
  return process.env.GOOGLE_CLIENT_SECRET || process.env.APP_URL || 'successwa-login-state';
}
function makeGoogleState() {
  const payload = crypto.randomBytes(12).toString('hex') + '.' + Date.now();
  const sig = crypto.createHmac('sha256', googleStateSecret()).update(payload).digest('hex');
  return payload + '.' + sig;
}
function verifyGoogleState(state) {
  const parts = String(state || '').split('.');
  if (parts.length !== 3) return false;
  const payload = parts[0] + '.' + parts[1];
  const expected = crypto.createHmac('sha256', googleStateSecret()).update(payload).digest('hex');
  let ok = false;
  try { ok = crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(expected)); } catch (e) { return false; }
  if (!ok) return false;
  const ts = Number(parts[1]);
  if (!ts || Date.now() - ts > 10 * 60 * 1000) return false; // 10-minute window
  return true;
}

// GET /api/auth/google/start — redirect the browser to Google's consent screen.
app.get('/api/auth/google/start', (req, res) => {
  if (!gauth.isConfigured()) {
    return res.redirect('/login.html#error=' + encodeURIComponent('Google sign-in is not configured on the server.'));
  }
  try {
    const url = gauth.getLoginAuthUrl(baseUrl(req), makeGoogleState());
    res.redirect(url);
  } catch (e) {
    console.error('[google login start]', e && e.message);
    res.redirect('/login.html#error=' + encodeURIComponent('Could not start Google sign-in.'));
  }
});

// GET /api/auth/google/callback — Google redirects here with ?code&state.
app.get('/api/auth/google/callback', async (req, res) => {
  const fail = (msg) => res.redirect('/login.html#error=' + encodeURIComponent(msg));
  try {
    const { code, state, error } = req.query;
    if (error) return fail('Google sign-in was cancelled.');
    if (!code || !verifyGoogleState(state)) return fail('Google sign-in expired or was invalid. Please try again.');

    const profile = await gauth.exchangeCodeForProfile(baseUrl(req), String(code));
    if (!profile.email || !profile.emailVerified) {
      return fail('Your Google account email is not verified.');
    }
    const email = normAccount(profile.email);

    let ur = await pool.query('SELECT email, name, role, active FROM users WHERE email=$1', [email]);
    let u = ur.rows[0];

    if (!u) {
      // Option 1B: any Google account may sign in; new emails become client accounts.
      const rnd = crypto.randomBytes(24).toString('hex'); // unusable random password
      const { salt, hash } = await hashPassword(rnd);
      await pool.query(
        "INSERT INTO users (email, name, pass_hash, pass_salt, role) VALUES ($1,$2,$3,$4,'client')",
        [email, profile.name || null, hash, salt]);
      await audit(pool, email, 'user.google_signup', 'user', email, {});
      u = { email, name: profile.name || null, role: 'client', active: true };
    }

    if (!u.active) return fail('This account has been disabled. Please contact your accountant.');

    // Make sure a client profile row exists so onboarding + profile work.
    if (u.role === 'client') await ensureClientForUser(u.email, u.name);

    // Google verified the user — issue the session directly (bypasses app MFA).
    const token = await createSession(u.email, u.role);
    await audit(pool, u.email, 'login.google', 'user', u.email, {});
    const frag = '#token=' + encodeURIComponent(token) +
      '&email=' + encodeURIComponent(u.email) +
      '&role=' + encodeURIComponent(u.role) +
      '&name=' + encodeURIComponent(u.name || '');
    res.redirect('/login.html' + frag);
  } catch (e) {
    console.error('[google login callback]', e && e.message);
    fail('Google sign-in failed. Please try again.');
  }
});


// ================= "Continue with Facebook" sign-in =================
// Same signed-state approach as Google (HMAC + 10-min window), reusing the
// makeGoogleState/verifyGoogleState helpers above since they are generic.

// GET /api/auth/facebook/start — redirect the browser to Facebook's consent screen.
app.get('/api/auth/facebook/start', (req, res) => {
  if (!fbauth.isConfigured()) {
    return res.redirect('/login.html#error=' + encodeURIComponent('Facebook sign-in is not configured on the server.'));
  }
  try {
    const url = fbauth.getLoginAuthUrl(baseUrl(req), makeGoogleState());
    res.redirect(url);
  } catch (e) {
    console.error('[facebook login start]', e && e.message);
    res.redirect('/login.html#error=' + encodeURIComponent('Could not start Facebook sign-in.'));
  }
});

// GET /api/auth/facebook/callback — Facebook redirects here with ?code&state.
app.get('/api/auth/facebook/callback', async (req, res) => {
  const fail = (msg) => res.redirect('/login.html#error=' + encodeURIComponent(msg));
  try {
    const { code, state, error } = req.query;
    if (error) return fail('Facebook sign-in was cancelled.');
    if (!code || !verifyGoogleState(state)) return fail('Facebook sign-in expired or was invalid. Please try again.');

    const profile = await fbauth.exchangeCodeForProfile(baseUrl(req), String(code));
    if (!profile.email) {
      return fail('We could not get an email from your Facebook account. Please use email/password or Google sign-in.');
    }
    const email = normAccount(profile.email);

    let ur = await pool.query('SELECT email, name, role, active FROM users WHERE email=$1', [email]);
    let u = ur.rows[0];

    if (!u) {
      // Any Facebook account may sign in; new emails become client accounts.
      const rnd = crypto.randomBytes(24).toString('hex'); // unusable random password
      const { salt, hash } = await hashPassword(rnd);
      await pool.query(
        "INSERT INTO users (email, name, pass_hash, pass_salt, role) VALUES ($1,$2,$3,$4,'client')",
        [email, profile.name || null, hash, salt]);
      await audit(pool, email, 'user.facebook_signup', 'user', email, {});
      u = { email, name: profile.name || null, role: 'client', active: true };
    }

    if (!u.active) return fail('This account has been disabled. Please contact your accountant.');

    // Make sure a client profile row exists so onboarding + profile work.
    if (u.role === 'client') await ensureClientForUser(u.email, u.name);

    // Facebook verified the user — issue the session directly (bypasses app MFA).
    const token = await createSession(u.email, u.role);
    await audit(pool, u.email, 'login.facebook', 'user', u.email, {});
    const frag = '#token=' + encodeURIComponent(token) +
      '&email=' + encodeURIComponent(u.email) +
      '&role=' + encodeURIComponent(u.role) +
      '&name=' + encodeURIComponent(u.name || '');
    res.redirect('/login.html' + frag);
  } catch (e) {
    console.error('[facebook login callback]', e && e.message);
    fail('Facebook sign-in failed. Please try again.');
  }
});


// ================= Forgot / Reset password (public) =================
// Reset tokens are random, stored hashed, single-use, and expire in 60 minutes.
const RESET_TTL_MS = 60 * 60 * 1000;
function hashToken(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }

// Build an absolute base URL for links in emails. Prefer APP_URL; otherwise infer
// from the request (works behind the VPS reverse proxy via x-forwarded-* headers).
function baseUrl(req) {
  if (process.env.APP_URL) return String(process.env.APP_URL).replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || 'localhost:' + (process.env.PORT || 8000)).split(',')[0].trim();
  return proto + '://' + host;
}

// Create a reset token for an email and email the link. Shared by the public
// forgot-password route and the admin-triggered reset.
async function createAndSendReset(req, email, opts) {
  const token = crypto.randomBytes(32).toString('hex');
  const id = crypto.randomBytes(12).toString('hex');
  const expires = new Date(Date.now() + RESET_TTL_MS);
  // Invalidate any earlier unused tokens for this email, then insert the new one.
  await pool.query('UPDATE password_resets SET used=true WHERE email=$1 AND used=false', [email]);
  await pool.query(
    'INSERT INTO password_resets (id, email, token_hash, expires_at) VALUES ($1,$2,$3,$4)',
    [id, email, hashToken(token), expires]);
  const link = baseUrl(req) + '/reset?token=' + id + '.' + token;
  const intro = (opts && opts.byAdmin)
    ? 'An administrator has started a password reset for your Successwa account.'
    : 'We received a request to reset the password for your Successwa account.';
  notifyBg({
    toEmail: email,
    rawSubject: 'Reset your Successwa password',
    rawBody: intro + '\n\nClick the link below to choose a new password. This link expires in 60 minutes and can be used once.\n\n'
      + link + '\n\nIf you did not request this, you can safely ignore this email.',
  });
  return link;
}

// POST /api/forgot-password { email } — always returns ok (no account enumeration).
app.post('/api/forgot-password', async (req, res) => {
  const email = normAccount(req.body.email);
  if (!email || email.indexOf('@') === -1) return res.status(400).json({ error: 'valid email required' });
  try {
    const r = await pool.query('SELECT email, active FROM users WHERE email=$1', [email]);
    if (r.rows.length && r.rows[0].active) {
      await createAndSendReset(req, email, { byAdmin: false });
    }
    // Same response whether or not the account exists.
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/reset-password { token, password } — consume token, set new password.
app.post('/api/reset-password', async (req, res) => {
  const raw = String(req.body.token || '');
  const password = String(req.body.password || '');
  if (!raw || raw.indexOf('.') === -1) return res.status(400).json({ error: 'invalid or expired reset link' });
  if (password.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
  const dot = raw.indexOf('.');
  const id = raw.slice(0, dot);
  const token = raw.slice(dot + 1);
  try {
    const r = await pool.query('SELECT * FROM password_resets WHERE id=$1', [id]);
    if (!r.rows.length) return res.status(400).json({ error: 'invalid or expired reset link' });
    const row = r.rows[0];
    if (row.used) return res.status(400).json({ error: 'this reset link has already been used' });
    if (new Date(row.expires_at) < new Date()) return res.status(400).json({ error: 'this reset link has expired' });
    if (hashToken(token) !== row.token_hash) return res.status(400).json({ error: 'invalid or expired reset link' });

    const { salt, hash } = await hashPassword(password);
    await pool.query('UPDATE users SET pass_hash=$1, pass_salt=$2 WHERE email=$3', [hash, salt, row.email]);
    await pool.query('UPDATE password_resets SET used=true WHERE id=$1', [id]);
    // Kick any existing sessions so the old password can't keep a session alive.
    await pool.query('DELETE FROM sessions WHERE email=$1', [row.email]);
    sessionCache.clear();
    await audit(pool, row.email, 'password.reset', 'user', row.email, {});
    res.json({ ok: true });
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

// ---- Per-account UI preferences (layout config only; never business data) ----
// Scopes are allow-listed so arbitrary keys can't be written. Prefs are always
// bound to req.user.email — a user can only read/write their OWN prefs.
const PREF_SCOPES = ['insights'];

// GET /api/me/prefs/:scope — the caller's saved prefs for a page (or {} if none).
app.get('/api/me/prefs/:scope', requireAuth, async (req, res) => {
  const scope = String(req.params.scope || '');
  if (PREF_SCOPES.indexOf(scope) === -1) return res.status(400).json({ error: 'unknown scope' });
  try {
    const r = await pool.query('SELECT prefs FROM user_prefs WHERE email=$1 AND scope=$2',
      [normAccount(req.user.email), scope]);
    res.json({ ok: true, prefs: (r.rows[0] && r.rows[0].prefs) || {} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/me/prefs/:scope { prefs } — upsert the caller's prefs for a page.
app.put('/api/me/prefs/:scope', requireAuth, async (req, res) => {
  const scope = String(req.params.scope || '');
  if (PREF_SCOPES.indexOf(scope) === -1) return res.status(400).json({ error: 'unknown scope' });
  const prefs = req.body && req.body.prefs;
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
    return res.status(400).json({ error: 'prefs must be an object' });
  }
  const json = JSON.stringify(prefs);
  if (json.length > 8192) return res.status(400).json({ error: 'prefs too large' });
  try {
    await pool.query(
      `INSERT INTO user_prefs (email, scope, prefs, updated_at) VALUES ($1,$2,$3::jsonb, now())
       ON CONFLICT (email, scope) DO UPDATE SET prefs=EXCLUDED.prefs, updated_at=now()`,
      [normAccount(req.user.email), scope, json]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ================= MFA (self-service, any logged-in user) =================
// GET current MFA status for the logged-in user.
app.get('/api/mfa/status', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT mfa_enabled, mfa_method FROM users WHERE email=$1', [normAccount(req.user.email)]);
    const u = r.rows[0] || {};
    res.json({ ok: true, enabled: !!u.mfa_enabled, method: u.mfa_enabled ? u.mfa_method : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/mfa/setup { method: 'email' | 'totp' } — begin enabling MFA.
//  - email: sends a 6-digit code to the user's email; returns a challengeId.
//  - totp : generates a secret (stored as pending) + QR code to scan.
app.post('/api/mfa/setup', requireAuth, async (req, res) => {
  const method = String(req.body.method || '').trim();
  const email = normAccount(req.user.email);
  if (method !== 'email' && method !== 'totp') return res.status(400).json({ error: 'invalid method' });
  try {
    mfa.purgeExpired(pool);
    if (method === 'email') {
      const code = mfa.sixDigitCode();
      const challengeId = await mfa.createChallenge(pool, { email, purpose: 'enable_email', method: 'email', code });
      notifyBg({
        toEmail: email,
        rawSubject: 'Confirm two-factor authentication',
        rawBody: 'Your confirmation code is ' + code + '\n\nEnter it in Successwa to turn on email two-factor authentication. It expires in 10 minutes.',
      });
      return res.json({ ok: true, method: 'email', challengeId, maskedEmail: maskEmail(email) });
    }
    // totp: stage a pending secret, return QR for the authenticator app.
    const secret = mfa.generateTotpSecret();
    await pool.query('UPDATE users SET mfa_pending_secret=$1 WHERE email=$2', [secret, email]);
    const { otpauth, qr } = await mfa.totpQrDataUrl(email, secret);
    res.json({ ok: true, method: 'totp', qr, secret, otpauth });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/mfa/enable { method, code, challengeId? } — confirm & switch MFA on.
app.post('/api/mfa/enable', requireAuth, async (req, res) => {
  const method = String(req.body.method || '').trim();
  const code = String(req.body.code || '').trim();
  const email = normAccount(req.user.email);
  if (!code) return res.status(400).json({ error: 'code required' });
  try {
    if (method === 'email') {
      const challengeId = String(req.body.challengeId || '');
      const result = await mfa.verifyChallenge(pool, { id: challengeId, code });
      if (!result.ok) return res.status(400).json({ error: result.error });
      await pool.query(
        "UPDATE users SET mfa_enabled=true, mfa_method='email', mfa_secret=NULL, mfa_pending_secret=NULL WHERE email=$1",
        [email]);
      await audit(pool, email, 'mfa.enable', 'user', email, { method: 'email' });
      return res.json({ ok: true, enabled: true, method: 'email' });
    }
    if (method === 'totp') {
      const pr = await pool.query('SELECT mfa_pending_secret FROM users WHERE email=$1', [email]);
      const secret = pr.rows.length ? pr.rows[0].mfa_pending_secret : null;
      if (!secret) return res.status(400).json({ error: 'Please restart setup — no pending secret found.' });
      if (!mfa.verifyTotp(secret, code)) return res.status(400).json({ error: 'Incorrect code. Make sure your device time is correct and try again.' });
      await pool.query(
        "UPDATE users SET mfa_enabled=true, mfa_method='totp', mfa_secret=$1, mfa_pending_secret=NULL WHERE email=$2",
        [secret, email]);
      await audit(pool, email, 'mfa.enable', 'user', email, { method: 'totp' });
      return res.json({ ok: true, enabled: true, method: 'totp' });
    }
    res.status(400).json({ error: 'invalid method' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/mfa/disable — turn MFA off for the logged-in user.
app.post('/api/mfa/disable', requireAuth, async (req, res) => {
  const email = normAccount(req.user.email);
  try {
    await pool.query(
      'UPDATE users SET mfa_enabled=false, mfa_method=NULL, mfa_secret=NULL, mfa_pending_secret=NULL WHERE email=$1',
      [email]);
    await audit(pool, email, 'mfa.disable', 'user', email, null);
    res.json({ ok: true, enabled: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


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
    await runAutomations(client, 'client_created', { client: { id: id, name: name, email: email || null } }, req.user.email);
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
              ua.name AS accountant_name, us.name AS supervisor_name,
              (SELECT COUNT(*)::int FROM job_checklist_items ci WHERE ci.job_id=j.id) AS checklist_total,
              (SELECT COUNT(*)::int FROM job_checklist_items ci WHERE ci.job_id=j.id AND ci.checked) AS checklist_done
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
    const [jr, hist, docs, reqs, notif, notes, chk] = await Promise.all([
      pool.query(
        `SELECT j.*, c.name AS client_name, c.email AS client_email, c.drive_folder_link,
                e.entity_name, e.entity_type,
                ua.name AS accountant_name, us.name AS supervisor_name
         FROM jobs j JOIN clients c ON c.id=j.client_id
         LEFT JOIN entities e ON e.id=j.entity_id
         LEFT JOIN users ua ON lower(ua.email) = lower(j.accountant_email)
         LEFT JOIN users us ON lower(us.email) = lower(j.supervisor_email) WHERE j.id=$1`, [req.params.id]),
      pool.query('SELECT * FROM job_status_history WHERE job_id=$1 ORDER BY created_at', [req.params.id]),
      pool.query('SELECT * FROM documents WHERE job_id=$1 ORDER BY created_at DESC', [req.params.id]),
      pool.query('SELECT * FROM doc_requests WHERE job_id=$1 ORDER BY created_at DESC', [req.params.id]),
      pool.query('SELECT * FROM notifications WHERE job_id=$1 ORDER BY created_at DESC', [req.params.id]),
      pool.query('SELECT jn.*, u.name AS author_name FROM job_notes jn LEFT JOIN users u ON lower(u.email)=lower(jn.author) WHERE jn.job_id=$1 ORDER BY jn.created_at DESC', [req.params.id]),
      pool.query('SELECT * FROM job_checklist_items WHERE job_id=$1 ORDER BY sort_order, id', [req.params.id]),
    ]);
    if (!jr.rows.length) return res.status(404).json({ error: 'job not found' });
    const job = jr.rows[0];
    // Accountants may only open their own jobs.
    if (req.user.role === 'accountant' && normAccount(job.accountant_email) !== normAccount(req.user.email)) {
      return res.status(403).json({ error: 'You can only view jobs assigned to you' });
    }
    job.stage_label = (wf.STAGE_MAP[job.stage] || {}).internalLabel || job.stage;
    job.next_action = wf.NEXT_ACTION[job.stage] || '';
    res.json({ ok: true, job, history: hist.rows, documents: docs.rows, docRequests: reqs.rows, notifications: notif.rows, notes: notes.rows, checklist: chk.rows, stages: wf.STAGES, stageMap: wf.STAGE_MAP });
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
  const dueDate = String(req.body.dueDate || '').trim() || null; // YYYY-MM-DD or null
  const priority = ['high', 'normal', 'low'].indexOf(String(req.body.priority || '').toLowerCase()) !== -1
    ? String(req.body.priority).toLowerCase() : 'normal';
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
      `INSERT INTO jobs (id, client_id, entity_id, job_type, financial_year, accountant_email, supervisor_email, due_date, priority, stage)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'01_created')`,
      [id, clientId, entityId || null, jobType || null, fy || null, accountant || null, supervisor || null, dueDate, priority]);
    // Seed the work checklist from the template that matches this job type.
    const tpl = checklists.templateFor(jobType);
    for (let i = 0; i < tpl.length; i++) {
      await client.query(
        'INSERT INTO job_checklist_items (job_id, label, required, sort_order) VALUES ($1,$2,$3,$4)',
        [id, tpl[i].label, tpl[i].required !== false, i]);
    }
    await client.query('INSERT INTO job_status_history (job_id, from_stage, to_stage, changed_by, reason) VALUES ($1,$2,$3,$4,$5)',
      [id, null, '01_created', req.user.email, 'Job created']);
    await audit(client, req.user.email, 'job.create', 'job', id, { clientId, entityId, jobType, accountant, supervisor, priority });
    // Automation events (best-effort, inside the txn): a new job was created, and possibly assigned.
    const newJob = { id: id, client_id: clientId, job_type: jobType || null, stage: '01_created',
      accountant_email: accountant || null, supervisor_email: supervisor || null };
    await runAutomations(client, 'job_created', { job: newJob }, req.user.email);
    if (accountant || supervisor) await runAutomations(client, 'job_assigned', { job: newJob }, req.user.email);
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
  // Admin-defined automations that trigger when a job ENTERS this stage.
  await runAutomations(runner, 'stage_enter', { job: Object.assign({}, job, { stage: toStage }) }, actor);
}

// Generic automation engine. Runs all enabled admin rules whose trigger matches an event.
//   eventType: 'stage_enter' | 'job_created' | 'job_assigned' | 'client_created' | 'document_uploaded'
//   ctx: { job?, client?, document? }  — whatever context the event carries.
//   eventKey (optional): narrows rules (stage for stage_enter, job_type for job_created).
// Best-effort: a failing rule is logged and skipped, never blocks the triggering request.
async function runAutomations(runner, eventType, ctx, actor, eventKey) {
  ctx = ctx || {};
  const job = ctx.job || null;
  const clientId = job ? job.client_id : (ctx.client ? ctx.client.id : null);
  // Derive the matching key when not supplied.
  let key = eventKey;
  if (key == null) {
    if (eventType === 'stage_enter') key = job ? job.stage : null;
    else if (eventType === 'job_created') key = job ? (job.job_type || '') : null;
  }
  let rules;
  try {
    rules = await runner.query(
      `SELECT * FROM stage_automations
        WHERE trigger_type=$1 AND enabled=true
          AND (trigger_key IS NULL OR trigger_key='' OR trigger_key=$2)
        ORDER BY sort_order, id`,
      [eventType, key == null ? '' : String(key)]);
  } catch (e) { return; }
  for (const r of rules.rows) {
    const cfg = r.config || {};
    try {
      if (r.action === 'set_action_required') {
        if (job) await runner.query('UPDATE jobs SET action_required=true, updated_at=now() WHERE id=$1', [job.id]);
      } else if (r.action === 'clear_action_required') {
        if (job) await runner.query('UPDATE jobs SET action_required=false, updated_at=now() WHERE id=$1', [job.id]);
      } else if (r.action === 'add_note') {
        const text = String(cfg.note || '').trim();
        if (text && job) await runner.query('INSERT INTO job_notes (job_id, author, note) VALUES ($1,$2,$3)',
          [job.id, actor || 'automation', text]);
      } else if (r.action === 'notify_staff') {
        const to = normAccount(cfg.email || '');
        if (to) {
          const subject = 'Automation: ' + automationEventLabel(eventType, ctx);
          await runner.query(
            `INSERT INTO notifications (job_id, to_email, template_key, subject, body, channel, status)
             VALUES ($1,$2,'automation',$3,$4,'inapp','sent')`,
            [job ? job.id : null, to, subject, String(cfg.note || '')]);
        }
      } else if (r.action === 'notify_client') {
        // Record-only until email is wired. Uses the client's email from job or client ctx.
        let email = null;
        if (clientId) {
          const cr = await runner.query('SELECT email FROM clients WHERE id=$1', [clientId]);
          email = cr.rows[0] && cr.rows[0].email;
        }
        if (email && cfg.templateKey) {
          const t = await runner.query('SELECT subject, body FROM notification_templates WHERE key=$1', [cfg.templateKey]);
          const subj = (t.rows[0] && t.rows[0].subject) || 'Update on your job';
          const body = (t.rows[0] && t.rows[0].body) || '';
          await runner.query(
            `INSERT INTO notifications (job_id, to_email, template_key, subject, body, channel, status)
             VALUES ($1,$2,$3,$4,$5,'email','sent')`,
            [job ? job.id : null, email, cfg.templateKey, subj, body]);
        }
      }
      await audit(runner, actor || 'automation', 'automation.run', 'job', job ? job.id : (clientId || null),
        { action: r.action, ruleId: r.id, trigger: eventType, key: key });
    } catch (e) { /* skip failing rule */ }
  }
}

// Short human label describing the event, used in notify_staff subject lines.
function automationEventLabel(eventType, ctx) {
  const job = ctx.job, client = ctx.client;
  if (eventType === 'stage_enter' && job) return job.id + ' entered ' + job.stage;
  if (eventType === 'job_created' && job) return 'New job ' + job.id + (job.job_type ? ' (' + job.job_type + ')' : '');
  if (eventType === 'job_assigned' && job) return 'Job ' + job.id + ' assigned';
  if (eventType === 'client_created' && client) return 'New client ' + client.id + (client.name ? ' (' + client.name + ')' : '');
  if (eventType === 'document_uploaded' && job) return 'Document uploaded on ' + job.id;
  return eventType;
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
    // Gate: cannot send to supervisor review until all REQUIRED checklist items are done.
    if (toStage === '05_supervisor_review') {
      const inc = await client.query(
        'SELECT COUNT(*)::int AS n FROM job_checklist_items WHERE job_id=$1 AND required AND NOT checked', [job.id]);
      if (inc.rows[0].n > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Complete the required checklist items before sending for review (' + inc.rows[0].n + ' remaining).' });
      }
    }
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

// POST /api/jobs/:id/checklist/:itemId { checked }  — tick/untick a work-checklist item.
// Staff only; accountants may only touch their own jobs.
app.post('/api/jobs/:id/checklist/:itemId', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  const checked = !!req.body.checked;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jr = await client.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!jr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'job not found' }); }
    if (req.user.role === 'accountant' && normAccount(jr.rows[0].accountant_email) !== normAccount(req.user.email)) {
      await client.query('ROLLBACK'); return res.status(403).json({ error: 'You can only update jobs assigned to you' });
    }
    const upd = await client.query(
      `UPDATE job_checklist_items SET checked=$1, checked_by=$2, checked_at=$3
       WHERE id=$4 AND job_id=$5 RETURNING id`,
      [checked, checked ? req.user.email : null, checked ? new Date() : null, req.params.itemId, req.params.id]);
    if (!upd.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'checklist item not found' }); }
    await audit(client, req.user.email, 'job.checklist', 'job', req.params.id, { itemId: Number(req.params.itemId), checked });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// PATCH /api/jobs/:id/priority { priority }  — high | normal | low.
// Reception / supervisor / administrator (same as reassign).
app.patch('/api/jobs/:id/priority', requireAuth, requireRole('reception', 'supervisor', 'administrator'), async (req, res) => {
  const priority = String(req.body.priority || '').toLowerCase();
  if (['high', 'normal', 'low'].indexOf(priority) === -1) return res.status(400).json({ error: 'invalid priority' });
  try {
    const r = await pool.query('UPDATE jobs SET priority=$1, updated_at=now() WHERE id=$2 RETURNING id', [priority, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'job not found' });
    await audit(pool, req.user.email, 'job.priority', 'job', req.params.id, { priority });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/jobs/:id — permanently delete a job. Administrator only (destructive).
// Child rows (history, documents, doc_requests) are removed via ON DELETE CASCADE;
// notifications.job_id is set NULL. We also delete the physical uploaded files.
app.delete('/api/jobs/:id', requireAuth, requireRole('administrator'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jr = await client.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!jr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'job not found' }); }
    // Collect stored files to unlink from disk after the row is gone.
    const docs = await client.query('SELECT stored_path FROM documents WHERE job_id=$1', [req.params.id]);
    await audit(client, req.user.email, 'job.delete', 'job', req.params.id, { documents: docs.rows.length });
    await client.query('DELETE FROM jobs WHERE id=$1', [req.params.id]);
    await client.query('COMMIT');
    // Best-effort disk cleanup (never fails the request).
    docs.rows.forEach((d) => { try { if (d.stored_path) fs.unlinkSync(path.join(UPLOAD_DIR, d.stored_path)); } catch (e) {} });
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

// ================= RECURRING JOB SCHEDULES =================
const RECUR_ROLES = ['reception', 'supervisor', 'administrator'];

// GET /api/recurring — list schedules with client/entity names.
app.get('/api/recurring', requireAuth, requireRole.apply(null, RECUR_ROLES), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT rc.*, c.name AS client_name, e.entity_name,
              ua.name AS accountant_name, us.name AS supervisor_name
       FROM recurring_jobs rc
       JOIN clients c ON c.id = rc.client_id
       LEFT JOIN entities e ON e.id = rc.entity_id
       LEFT JOIN users ua ON lower(ua.email) = lower(rc.accountant_email)
       LEFT JOIN users us ON lower(us.email) = lower(rc.supervisor_email)
       ORDER BY rc.active DESC, rc.next_run_date`);
    res.json({ ok: true, schedules: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/recurring — create a schedule.
app.post('/api/recurring', requireAuth, requireRole.apply(null, RECUR_ROLES), async (req, res) => {
  const clientId = String(req.body.clientId || '').trim();
  const entityId = String(req.body.entityId || '').trim();
  const jobType = String(req.body.jobType || '').trim();
  const fy = String(req.body.financialYear || '').trim();
  const accountant = normAccount(req.body.accountant);
  const supervisor = normAccount(req.body.supervisor);
  const priority = ['high', 'normal', 'low'].indexOf(String(req.body.priority || '').toLowerCase()) !== -1
    ? String(req.body.priority).toLowerCase() : 'normal';
  const frequency = String(req.body.frequency || '').toLowerCase();
  const nextRun = String(req.body.nextRunDate || '').trim();
  const leadDays = Number.isFinite(Number(req.body.leadDays)) ? Math.max(0, Math.floor(Number(req.body.leadDays))) : 14;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  if (['monthly', 'quarterly', 'annually'].indexOf(frequency) === -1) return res.status(400).json({ error: 'invalid frequency' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nextRun)) return res.status(400).json({ error: 'nextRunDate must be YYYY-MM-DD' });
  const roleErr = await validateAssignment(accountant, supervisor);
  if (roleErr) return res.status(400).json({ error: roleErr });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ex = await client.query('SELECT id FROM clients WHERE id=$1', [clientId]);
    if (!ex.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'client not found' }); }
    const id = await nextId(client, 'recurring', 'RC-');
    await client.query(
      `INSERT INTO recurring_jobs (id, client_id, entity_id, job_type, accountant_email, supervisor_email, priority, frequency, next_run_date, lead_days, financial_year, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, clientId, entityId || null, jobType || null, accountant || null, supervisor || null, priority, frequency, nextRun, leadDays, fy || null, req.user.email]);
    await audit(client, req.user.email, 'recurring.create', 'recurring', id, { clientId, jobType, frequency, nextRun });
    await client.query('COMMIT');
    res.json({ ok: true, id });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// PATCH /api/recurring/:id — pause/resume or edit fields.
app.patch('/api/recurring/:id', requireAuth, requireRole.apply(null, RECUR_ROLES), async (req, res) => {
  const sets = [];
  const params = [];
  function set(col, val) { params.push(val); sets.push(col + '=$' + params.length); }
  if (typeof req.body.active === 'boolean') set('active', req.body.active);
  if (req.body.frequency && ['monthly', 'quarterly', 'annually'].indexOf(String(req.body.frequency).toLowerCase()) !== -1) set('frequency', String(req.body.frequency).toLowerCase());
  if (req.body.nextRunDate && /^\d{4}-\d{2}-\d{2}$/.test(req.body.nextRunDate)) set('next_run_date', req.body.nextRunDate);
  if (req.body.priority && ['high', 'normal', 'low'].indexOf(String(req.body.priority).toLowerCase()) !== -1) set('priority', String(req.body.priority).toLowerCase());
  if (Number.isFinite(Number(req.body.leadDays))) set('lead_days', Math.max(0, Math.floor(Number(req.body.leadDays))));
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  params.push(req.params.id);
  try {
    const r = await pool.query('UPDATE recurring_jobs SET ' + sets.join(', ') + ' WHERE id=$' + params.length + ' RETURNING id', params);
    if (!r.rows.length) return res.status(404).json({ error: 'schedule not found' });
    await audit(pool, req.user.email, 'recurring.update', 'recurring', req.params.id, req.body);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/recurring/:id — remove a schedule (does not touch already-created jobs).
app.delete('/api/recurring/:id', requireAuth, requireRole.apply(null, RECUR_ROLES), async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM recurring_jobs WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'schedule not found' });
    await audit(pool, req.user.email, 'recurring.delete', 'recurring', req.params.id, {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/recurring/:id/run-now — generate the next job immediately.
app.post('/api/recurring/:id/run-now', requireAuth, requireRole.apply(null, RECUR_ROLES), async (req, res) => {
  try {
    const jobId = await recurring.generateForSchedule(pool, req.params.id, req.user.email, notifyBg, true);
    if (!jobId) return res.status(404).json({ error: 'schedule not found' });
    await audit(pool, req.user.email, 'recurring.run_now', 'recurring', req.params.id, { jobId });
    res.json({ ok: true, jobId });
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
    // Fire job_assigned automations only when the assignment actually changed.
    const accChanged = normAccount(job.accountant_email) !== (newAcc || '');
    const supChanged = normAccount(job.supervisor_email) !== (newSup || '');
    if (accChanged || supChanged) {
      await runAutomations(client, 'job_assigned',
        { job: Object.assign({}, job, { accountant_email: newAcc || null, supervisor_email: newSup || null }) },
        req.user.email);
    }
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

// PATCH /api/jobs/:id/due-date { dueDate } — set or clear a job's deadline.
// Accountants (offshore) cannot change deadlines — reception / supervisor / administrator only.
app.patch('/api/jobs/:id/due-date', requireAuth, requireRole('reception', 'supervisor', 'administrator'), async (req, res) => {
  const raw = String(req.body.dueDate || '').trim();
  // Empty clears the date; otherwise require YYYY-MM-DD.
  const dueDate = raw || null;
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return res.status(400).json({ error: 'due date must be YYYY-MM-DD' });
  try {
    const jr = await pool.query('SELECT id FROM jobs WHERE id=$1', [req.params.id]);
    if (!jr.rows.length) return res.status(404).json({ error: 'job not found' });
    await pool.query('UPDATE jobs SET due_date=$1, updated_at=now() WHERE id=$2', [dueDate, req.params.id]);
    await audit(pool, req.user.email, 'job.due_date', 'job', req.params.id, { dueDate });
    res.json({ ok: true, dueDate });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/documents/:id/status { status, note } — staff verify an uploaded document.
// status: 'received' | 'verified' | 'incorrect' | 'info_required'. The latter two
// notify the client (with an optional note) and flag the job as action-required.
app.patch('/api/documents/:id/status', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  const status = String(req.body.status || '').trim();
  const note = String(req.body.note || '').trim() || null;
  const allowed = ['received', 'verified', 'incorrect', 'info_required'];
  if (allowed.indexOf(status) === -1) return res.status(400).json({ error: 'invalid status' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dr = await client.query(
      `SELECT d.*, j.id AS job_id, c.email AS client_email, c.name AS client_name
         FROM documents d JOIN jobs j ON j.id=d.job_id JOIN clients c ON c.id=j.client_id
        WHERE d.id=$1 FOR UPDATE`, [req.params.id]);
    if (!dr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'document not found' }); }
    const doc = dr.rows[0];
    // Accountants may only verify docs on their own jobs.
    if (req.user.role === 'accountant') {
      const own = await client.query('SELECT 1 FROM jobs WHERE id=$1 AND lower(accountant_email)=lower($2)', [doc.job_id, req.user.email]);
      if (!own.rows.length) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'You can only review documents on your own jobs' }); }
    }
    const verified = status === 'verified' || status === 'incorrect' || status === 'info_required';
    await client.query(
      'UPDATE documents SET status=$1, review_note=$2, verified_by=$3, verified_at=$4 WHERE id=$5',
      [status, note, verified ? req.user.email : null, verified ? new Date() : null, doc.id]);
    // If the doc needs client action, flag the job so the portal shows "Action Required".
    if (status === 'incorrect' || status === 'info_required') {
      await client.query('UPDATE jobs SET action_required=true, updated_at=now() WHERE id=$1', [doc.job_id]);
    }
    await audit(client, req.user.email, 'document.status', 'job', doc.job_id, { documentId: doc.id, status, note });
    await client.query('COMMIT');

    // Tell the client when we need something from them (background).
    if ((status === 'incorrect' || status === 'info_required') && doc.client_email) {
      const what = status === 'incorrect'
        ? 'There is an issue with a document you uploaded'
        : 'We need a bit more information about a document you uploaded';
      notifyBg({
        jobId: doc.job_id, toEmail: doc.client_email,
        rawSubject: 'Action needed on your document — ' + doc.job_id,
        rawBody: what + ' ("' + doc.filename + '") for job ' + doc.job_id + '.'
          + (note ? '\n\nNote from our team: ' + note : '')
          + '\n\nPlease log in to your portal to review and re-upload if needed.',
      });
    }
    res.json({ ok: true, status });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// PATCH /api/documents/:id/visibility { visible } — staff share (or unshare) a
// document with the client. Staff-uploaded deliverables (final returns, notices of
// assessment) stay hidden until a staff member explicitly shares them. A client's
// OWN uploads are always visible to them regardless of this flag.
app.patch('/api/documents/:id/visibility', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  try {
    const visible = req.body.visible === true || req.body.visible === 'true';
    const dr = await pool.query(
      `SELECT d.*, j.accountant_email FROM documents d LEFT JOIN jobs j ON j.id=d.job_id WHERE d.id=$1`, [req.params.id]);
    if (!dr.rows.length) return res.status(404).json({ error: 'document not found' });
    const doc = dr.rows[0];
    // Accountants may only change visibility on their own jobs.
    if (req.user.role === 'accountant' && normAccount(doc.accountant_email) !== normAccount(req.user.email)) {
      return res.status(403).json({ error: 'You can only manage documents on your own jobs' });
    }
    await pool.query('UPDATE documents SET client_visible=$1 WHERE id=$2', [visible, doc.id]);
    await audit(pool, req.user.email, 'document.visibility', 'document', String(doc.id), { visible });
    res.json({ ok: true, visible });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ================= Internal notes (staff-only; never shown to clients) =================
// GET /api/jobs/:id/notes — list notes (accountants only on their own jobs).
app.get('/api/jobs/:id/notes', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  try {
    if (req.user.role === 'accountant') {
      const own = await pool.query('SELECT 1 FROM jobs WHERE id=$1 AND lower(accountant_email)=lower($2)', [req.params.id, req.user.email]);
      if (!own.rows.length) return res.status(403).json({ error: 'You can only view notes on your own jobs' });
    }
    const r = await pool.query(
      'SELECT jn.*, u.name AS author_name FROM job_notes jn LEFT JOIN users u ON lower(u.email)=lower(jn.author) WHERE jn.job_id=$1 ORDER BY jn.created_at DESC',
      [req.params.id]);
    res.json({ ok: true, notes: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/jobs/:id/notes { note } — add an internal note.
app.post('/api/jobs/:id/notes', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  const note = String(req.body.note || '').trim();
  if (!note) return res.status(400).json({ error: 'note required' });
  if (note.length > 4000) return res.status(400).json({ error: 'note is too long' });
  try {
    const jr = await pool.query('SELECT id, accountant_email FROM jobs WHERE id=$1', [req.params.id]);
    if (!jr.rows.length) return res.status(404).json({ error: 'job not found' });
    if (req.user.role === 'accountant' && normAccount(jr.rows[0].accountant_email) !== normAccount(req.user.email)) {
      return res.status(403).json({ error: 'You can only add notes to your own jobs' });
    }

    // Resolve @mentions. The client may send an explicit `mentions` array of staff emails
    // (from the autocomplete); we validate them against active staff and never trust it blindly.
    let mentions = [];
    const requested = Array.isArray(req.body.mentions) ? req.body.mentions : [];
    if (requested.length) {
      const staff = await pool.query(
        "SELECT lower(email) AS email FROM users WHERE role IN ('administrator','supervisor','accountant','reception') AND active=true");
      const valid = new Set(staff.rows.map((r) => r.email));
      const me = normAccount(req.user.email);
      mentions = Array.from(new Set(requested
        .map((m) => normAccount(String(m)))
        .filter((m) => valid.has(m) && m !== me)));  // don't notify yourself
    }

    const ins = await pool.query(
      'INSERT INTO job_notes (job_id, author, note, mentions) VALUES ($1,$2,$3,$4) RETURNING id, created_at',
      [req.params.id, req.user.email, note, mentions]);

    // In-app bell notification for each mentioned colleague (staff-only; client never sees notes).
    if (mentions.length) {
      const author = req.user.name || req.user.email;
      const snippet = note.length > 140 ? note.slice(0, 140) + '…' : note;
      for (const to of mentions) {
        await pool.query(
          `INSERT INTO notifications (job_id, to_email, template_key, subject, body, channel, status)
           VALUES ($1,$2,'mention',$3,$4,'inapp','sent')`,
          [req.params.id, to, author + ' mentioned you on ' + req.params.id, snippet]);
      }
    }

    await audit(pool, req.user.email, 'job.note_add', 'job', req.params.id, { noteId: ins.rows[0].id, mentions: mentions.length });
    res.json({ ok: true, id: ins.rows[0].id, created_at: ins.rows[0].created_at, mentions: mentions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/jobs/:id/notes/:noteId — remove a note (author or administrator only).
app.delete('/api/jobs/:id/notes/:noteId', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  try {
    const nr = await pool.query('SELECT * FROM job_notes WHERE id=$1 AND job_id=$2', [req.params.noteId, req.params.id]);
    if (!nr.rows.length) return res.status(404).json({ error: 'note not found' });
    const isAuthor = normAccount(nr.rows[0].author) === normAccount(req.user.email);
    if (!isAuthor && req.user.role !== 'administrator') {
      return res.status(403).json({ error: 'only the author or an administrator can delete this note' });
    }
    await pool.query('DELETE FROM job_notes WHERE id=$1', [req.params.noteId]);
    await audit(pool, req.user.email, 'job.note_delete', 'job', req.params.id, { noteId: req.params.noteId });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
              (SELECT COUNT(*)::int FROM doc_requests dr WHERE dr.job_id=j.id AND dr.status='pending') AS pending_reqs,
              (SELECT COUNT(*)::int FROM job_checklist_items ci WHERE ci.job_id=j.id) AS checklist_total,
              (SELECT COUNT(*)::int FROM job_checklist_items ci WHERE ci.job_id=j.id AND ci.checked) AS checklist_done
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

// POST /api/review/:id/request-info { message, category?, dueDate? }
// Supervisor asks the CLIENT for more information/documents during review. The job
// stays in supervisor review, but a client-facing document request is created and the
// job is flagged Action Required so the client is prompted to respond.
app.post('/api/review/:id/request-info', requireAuth, requireRole('supervisor'), async (req, res) => {
  const message = String(req.body.message || '').trim();
  const category = String(req.body.category || '').trim();
  const dueDate = req.body.dueDate || null;
  if (!message) return res.status(400).json({ error: 'a message for the client is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jr = await client.query("SELECT * FROM jobs WHERE id=$1 AND stage='05_supervisor_review' FOR UPDATE", [req.params.id]);
    if (!jr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'job not in review' }); }
    const job = jr.rows[0];
    await client.query(
      'INSERT INTO doc_requests (job_id, category, description, due_date, created_by) VALUES ($1,$2,$3,$4,$5)',
      [job.id, category || null, message, dueDate || null, req.user.email]);
    await client.query('UPDATE jobs SET action_required=true, updated_at=now() WHERE id=$1', [job.id]);
    await client.query('INSERT INTO job_status_history (job_id, from_stage, to_stage, changed_by, reason) VALUES ($1,$2,$2,$3,$4)',
      [job.id, job.stage, req.user.email, 'Requested more info from client: ' + message]);
    await audit(client, req.user.email, 'job.request_client_info', 'job', job.id, { message, dueDate });
    await client.query('COMMIT');
    // Notify the client (background).
    const cr = await pool.query('SELECT email, name FROM clients WHERE id=$1', [job.client_id]);
    if (cr.rows.length && cr.rows[0].email) {
      notifyBg({
        jobId: job.id,
        toEmail: cr.rows[0].email,
        rawSubject: 'We need a little more information for ' + job.id,
        rawBody: 'Hi ' + (cr.rows[0].name || 'there') + ',\n\nWhile reviewing your job (' + job.id + '), we need a bit more information from you:\n\n' +
          message + '\n\nPlease log in to your portal to provide it. Thank you.',
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

// ================= CONTROLLED DOCUMENT FOLDERS (Stage 4) =================
// The standard, controlled sub-folders seeded under each financial-year root.
const STANDARD_FOLDERS = ['Income', 'Deductions', 'Rental Property', 'Shares & Crypto', 'Business', 'Other'];
// Guard rails so a client can't create a runaway tree.
const MAX_CLIENT_FOLDERS = 100;      // total non-system folders per client
const MAX_FOLDER_CHILDREN = 30;      // children under a single parent
const MAX_FOLDER_DEPTH = 4;          // year root(1) -> standard(2) -> custom(3) -> custom(4)

// Compute the current Australian financial-year label, e.g. "2026 Tax" for FY2025-26.
function currentFyLabel(d) {
  const now = d || new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0=Jan; AU FY starts in July (month 6)
  const fyEnd = m >= 6 ? y + 1 : y;
  return fyEnd + ' Tax';
}

// Resolve the client id for the logged-in client (first match wins, deterministic).
async function clientIdForUser(email) {
  const r = await pool.query('SELECT id FROM clients WHERE lower(email)=$1 ORDER BY id LIMIT 1', [normAccount(email)]);
  return r.rows.length ? r.rows[0].id : null;
}

// Ensure the current financial-year root + standard sub-folders exist for a client.
async function ensureStandardFolders(clientId) {
  const year = currentFyLabel();
  let root = await pool.query(
    'SELECT id FROM doc_folders WHERE client_id=$1 AND parent_id IS NULL AND name=$2', [clientId, year]);
  let rootId;
  if (!root.rows.length) {
    const ins = await pool.query(
      'INSERT INTO doc_folders (client_id, parent_id, name, year, is_system, created_by) VALUES ($1,NULL,$2,$2,true,$3) RETURNING id',
      [clientId, year, 'system']);
    rootId = ins.rows[0].id;
  } else {
    rootId = root.rows[0].id;
  }
  for (const name of STANDARD_FOLDERS) {
    const ex = await pool.query(
      'SELECT id FROM doc_folders WHERE client_id=$1 AND parent_id=$2 AND name=$3', [clientId, rootId, name]);
    if (!ex.rows.length) {
      await pool.query(
        'INSERT INTO doc_folders (client_id, parent_id, name, year, is_system, created_by) VALUES ($1,$2,$3,$4,true,$5)',
        [clientId, rootId, name, year, 'system']);
    }
  }
  return rootId;
}

// GET /api/portal/folders — the client's full folder tree + per-folder document counts.
app.get('/api/portal/folders', requireAuth, requireRole('client'), async (req, res) => {
  try {
    const clientId = await clientIdForUser(req.user.email);
    if (!clientId) return res.json({ ok: true, folders: [] });
    await ensureStandardFolders(clientId);
    const fr = await pool.query(
      `SELECT f.id, f.parent_id, f.name, f.year, f.is_system,
              (SELECT COUNT(*)::int FROM documents d WHERE d.folder_id=f.id) AS doc_count
       FROM doc_folders f WHERE f.client_id=$1 ORDER BY f.parent_id NULLS FIRST, f.is_system DESC, f.name`,
      [clientId]);
    res.json({ ok: true, folders: fr.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/portal/invoices — the client's own invoices (amount + status only; no staff/internal data).
app.get('/api/portal/invoices', requireAuth, requireRole('client'), async (req, res) => {
  try {
    const clientId = await clientIdForUser(req.user.email);
    if (!clientId) return res.json({ ok: true, invoices: [] });
    const r = await pool.query(
      `SELECT id, description, amount_cents, currency, status, due_date, issued_at, paid_at
         FROM invoices WHERE client_id=$1 AND status <> 'void' ORDER BY issued_at DESC LIMIT 100`, [clientId]);
    res.json({ ok: true, invoices: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/portal/invoices/:id/pay — Pay Now. Online payment gateway is not wired yet,
// so this is a placeholder that confirms the invoice is payable and tells the client how to pay.
// ponytail: no gateway — swap this for a Stripe Checkout session + webhook that flips status to 'paid'.
app.post('/api/portal/invoices/:id/pay', requireAuth, requireRole('client'), async (req, res) => {
  try {
    const clientId = await clientIdForUser(req.user.email);
    if (!clientId) return res.status(404).json({ error: 'no client profile' });
    const r = await pool.query('SELECT id, status FROM invoices WHERE id=$1 AND client_id=$2', [req.params.id, clientId]);
    if (!r.rows.length) return res.status(404).json({ error: 'invoice not found' });
    if (r.rows[0].status === 'paid') return res.json({ ok: true, status: 'paid', message: 'This invoice is already paid.' });
    res.json({ ok: true, status: 'unpaid', message: 'Online payment is coming soon. Please contact our office to settle this invoice.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/portal/folders { parentId, name } — client creates a sub-folder (within limits).
app.post('/api/portal/folders', requireAuth, requireRole('client'), async (req, res) => {
  try {
    const clientId = await clientIdForUser(req.user.email);
    if (!clientId) return res.status(404).json({ error: 'no client profile' });
    const name = String(req.body.name || '').trim().slice(0, 60);
    const parentId = req.body.parentId ? Number(req.body.parentId) : null;
    if (!name) return res.status(400).json({ error: 'folder name required' });
    if (!parentId) return res.status(400).json({ error: 'a parent folder is required' });

    // Parent must belong to this client.
    const pr = await pool.query('SELECT id, year FROM doc_folders WHERE id=$1 AND client_id=$2', [parentId, clientId]);
    if (!pr.rows.length) return res.status(404).json({ error: 'parent folder not found' });

    // Enforce total-folder and per-parent limits.
    const tot = await pool.query('SELECT COUNT(*)::int AS n FROM doc_folders WHERE client_id=$1 AND is_system=false', [clientId]);
    if (tot.rows[0].n >= MAX_CLIENT_FOLDERS) return res.status(400).json({ error: 'folder limit reached' });
    const kids = await pool.query('SELECT COUNT(*)::int AS n FROM doc_folders WHERE parent_id=$1', [parentId]);
    if (kids.rows[0].n >= MAX_FOLDER_CHILDREN) return res.status(400).json({ error: 'this folder has too many sub-folders' });

    // Enforce maximum depth by walking up the parent chain.
    let depth = 1, cursor = parentId;
    while (cursor) {
      const up = await pool.query('SELECT parent_id FROM doc_folders WHERE id=$1', [cursor]);
      if (!up.rows.length) break;
      depth++; cursor = up.rows[0].parent_id;
      if (depth > MAX_FOLDER_DEPTH) return res.status(400).json({ error: 'maximum folder depth reached' });
    }

    // No duplicate name under the same parent.
    const dup = await pool.query('SELECT id FROM doc_folders WHERE parent_id=$1 AND lower(name)=lower($2)', [parentId, name]);
    if (dup.rows.length) return res.status(400).json({ error: 'a folder with that name already exists here' });

    const ins = await pool.query(
      'INSERT INTO doc_folders (client_id, parent_id, name, year, is_system, created_by) VALUES ($1,$2,$3,$4,false,$5) RETURNING id',
      [clientId, parentId, name, pr.rows[0].year, req.user.email]);
    await audit(pool, req.user.email, 'folder.create', 'folder', String(ins.rows[0].id), { name, parentId });
    res.json({ ok: true, id: ins.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/portal/folders/:id — remove a client-created (non-system) folder.
// Documents inside are kept (folder_id set to NULL via FK), never deleted.
app.delete('/api/portal/folders/:id', requireAuth, requireRole('client'), async (req, res) => {
  try {
    const clientId = await clientIdForUser(req.user.email);
    if (!clientId) return res.status(404).json({ error: 'no client profile' });
    const fr = await pool.query('SELECT id, is_system FROM doc_folders WHERE id=$1 AND client_id=$2', [req.params.id, clientId]);
    if (!fr.rows.length) return res.status(404).json({ error: 'folder not found' });
    if (fr.rows[0].is_system) return res.status(403).json({ error: 'standard folders cannot be deleted' });
    await pool.query('DELETE FROM doc_folders WHERE id=$1', [req.params.id]);
    await audit(pool, req.user.email, 'folder.delete', 'folder', String(req.params.id), {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/portal/folders/:id/documents — documents filed in one folder (client-owned).
app.get('/api/portal/folders/:id/documents', requireAuth, requireRole('client'), async (req, res) => {
  try {
    const clientId = await clientIdForUser(req.user.email);
    if (!clientId) return res.status(404).json({ error: 'no client profile' });
    const fr = await pool.query('SELECT id FROM doc_folders WHERE id=$1 AND client_id=$2', [req.params.id, clientId]);
    if (!fr.rows.length) return res.status(404).json({ error: 'folder not found' });
    const docs = await pool.query(
      'SELECT id, category, filename, created_at, status FROM documents WHERE folder_id=$1 AND client_id=$2 ORDER BY created_at DESC',
      [req.params.id, clientId]);
    res.json({ ok: true, documents: docs.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/portal/folders/:id/upload — free-form upload straight into a folder
// (not tied to a job's document request). Uses the same disk storage + limits.
app.post('/api/portal/folders/:id/upload', requireAuth, requireRole('client'), upload.single('file'), async (req, res) => {
  try {
    const clientId = await clientIdForUser(req.user.email);
    if (!clientId) return res.status(404).json({ error: 'no client profile' });
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const fr = await pool.query('SELECT id FROM doc_folders WHERE id=$1 AND client_id=$2', [req.params.id, clientId]);
    if (!fr.rows.length) return res.status(404).json({ error: 'folder not found' });
    const category = String(req.body.category || 'Other').trim();
    const ins = await pool.query(
      `INSERT INTO documents (job_id, client_id, entity_id, category, filename, stored_path, mime, size, uploaded_by, folder_id)
       VALUES (NULL,$1,NULL,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [clientId, category, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, req.user.email, req.params.id]);
    await audit(pool, req.user.email, 'document.upload_folder', 'folder', String(req.params.id), { filename: req.file.originalname });
    res.json({ ok: true, id: ins.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ================= GOOGLE DRIVE (firm-wide OAuth) =================
// The firm connects ONE Google account once; refresh token is stored server-side.
// Connect/disconnect/status are administrator-only. The OAuth callback is a
// browser redirect from Google (no Bearer header), so it is protected by a
// one-time random `state` value instead.
const K_OAUTH_STATE = 'google_drive.oauth_state';

app.get('/api/google/status', requireAuth, requireRole('administrator'), async (req, res) => {
  try { res.json({ ok: true, status: await gdrive.getStatus(pool) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Returns the Google consent URL for the admin UI to redirect to (window.location).
app.get('/api/google/auth-url', requireAuth, requireRole('administrator'), async (req, res) => {
  try {
    if (!gdrive.isConfigured()) return res.status(400).json({ error: 'Google OAuth is not configured on the server (.env).' });
    const state = crypto.randomBytes(16).toString('hex');
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ($1,$2,$3, now())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [K_OAUTH_STATE, state, req.user.email]);
    const url = gdrive.getAuthUrl() + '&state=' + encodeURIComponent(state);
    res.json({ ok: true, url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Google redirects the browser here with ?code=&state=. Public route + state check.
app.get('/api/google/callback', async (req, res) => {
  const code = String(req.query.code || '');
  const state = String(req.query.state || '');
  try {
    const saved = await pool.query('SELECT value FROM app_settings WHERE key=$1', [K_OAUTH_STATE]);
    const expected = saved.rows.length ? saved.rows[0].value : null;
    if (!code || !state || !expected || state !== expected) {
      return res.redirect(302, '/admin?drive=error');
    }
    await pool.query('DELETE FROM app_settings WHERE key=$1', [K_OAUTH_STATE]);
    await gdrive.saveTokensFromCode(pool, code, 'oauth-callback');
    res.redirect(302, '/admin?drive=connected');
  } catch (e) {
    console.error('[google callback]', e.message);
    res.redirect(302, '/admin?drive=error');
  }
});

app.post('/api/google/disconnect', requireAuth, requireRole('administrator'), async (req, res) => {
  try {
    await gdrive.disconnect(pool);
    await audit(pool, req.user.email, 'google_drive.disconnect', 'app_settings', 'google_drive', null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// Both staff and the owning client can upload.
app.post('/api/documents/upload', requireAuth, upload.single('file'), async (req, res) => {
  const jobId = String(req.body.jobId || '').trim();
  const category = String(req.body.category || 'Other').trim();
  // Optional: the specific outstanding request this upload fulfils (from the
  // "Documents we need from you" list). If omitted we try to match by category.
  const docRequestId = req.body.docRequestId ? Number(req.body.docRequestId) : null;
  if (!req.file) return res.status(400).json({ error: 'file required' });
  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  const client = await pool.connect();
  // Captured inside the transaction, used for notifications after COMMIT.
  let autoAdvanced = false;      // did the workflow move to "Documents Received"?
  let fulfilledDesc = null;      // description of the request this upload satisfied
  try {
    await client.query('BEGIN');
    const jr = await client.query('SELECT j.*, c.email AS client_email FROM jobs j JOIN clients c ON c.id=j.client_id WHERE j.id=$1', [jobId]);
    if (!jr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'job not found' }); }
    const job = jr.rows[0];
    // Client can only upload to their own job.
    if (req.user.role === 'client' && normAccount(job.client_email) !== normAccount(req.user.email)) {
      await client.query('ROLLBACK'); return res.status(403).json({ error: 'not your job' });
    }
    // (1) confirm receipt + (2) timestamp (created_at default) + (3) identify client
    //     (job JOIN clients) + (4) link to job (job_id).
    const ins = await client.query(
      `INSERT INTO documents (job_id, client_id, entity_id, category, filename, stored_path, mime, size, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [jobId, job.client_id, job.entity_id, category, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, req.user.email]);
    const docId = ins.rows[0].id;
    await audit(client, req.user.email, 'document.upload', 'job', jobId, { category, filename: req.file.originalname });

    // (5) update checklist: mark the matching outstanding document request as received.
    //     Prefer the explicit request id; otherwise fall back to the oldest pending
    //     request in the same category. This is the "auto-acknowledgement" that
    //     removes the manual staff step.
    let fr = { rows: [] };
    if (docRequestId) {
      fr = await client.query(
        "UPDATE doc_requests SET status='received', received_at=now() WHERE id=$1 AND job_id=$2 AND status='pending' RETURNING description",
        [docRequestId, jobId]);
    }
    if (!fr.rows.length && category) {
      fr = await client.query(
        "UPDATE doc_requests SET status='received', received_at=now() WHERE id=(SELECT id FROM doc_requests WHERE job_id=$1 AND status='pending' AND category=$2 ORDER BY created_at LIMIT 1) RETURNING description",
        [jobId, category]);
    }
    if (fr.rows.length) fulfilledDesc = fr.rows[0].description;

    // (7) update workflow: if nothing is outstanding any more, clear the action flag
    //     and — if we were still collecting documents — advance to "Documents Received".
    const rem = await client.query("SELECT COUNT(*)::int AS n FROM doc_requests WHERE job_id=$1 AND status='pending'", [jobId]);
    if (rem.rows[0].n === 0) {
      await client.query('UPDATE jobs SET action_required=false, updated_at=now() WHERE id=$1', [jobId]);
      if (job.stage === '01_created' || job.stage === '02_waiting_docs') {
        await changeStage(client, job, '03_docs_received', 'system', 'All requested documents received');
        autoAdvanced = true;
      }
    }

    // Automation event: a client uploaded a document against this job (best-effort, in-txn).
    if (req.user.role === 'client') {
      await runAutomations(client, 'document_uploaded',
        { job: job, document: { id: docId, category: category, filename: req.file.originalname } }, req.user.email);
    }

    await client.query('COMMIT');

    // Back up to Google Drive (no-op if not connected). Group by client, with the
    // client's email as the folder prefix for easy identification.
    const driveSubfolder = job.client_email
      ? job.client_email + ' - ' + job.client_id
      : job.client_id;
    driveBackupBg(docId, job.client_id, {
      localPath: path.join(UPLOAD_DIR, req.file.filename),
      filename: req.file.originalname,
      mime: req.file.mimetype,
      subfolder: driveSubfolder,
    });

    // (6) notify staff: if the CLIENT uploaded, let the assigned accountant know (background).
    if (req.user.role === 'client' && job.accountant_email) {
      notifyBg({
        jobId: job.id, toEmail: job.accountant_email,
        rawSubject: 'Client uploaded a document: ' + job.id,
        rawBody: 'The client uploaded "' + req.file.originalname + '" (' + category + ') to job ' + job.id + '.'
          + (fulfilledDesc ? '\n\nThis fulfils the request: "' + fulfilledDesc + '".' : '')
          + (autoAdvanced ? '\n\nAll requested documents are now in — the job has moved to "Documents Received".' : '')
          + '\n\nLog in to review it.',
      });
    }

    // (8) log to communication history + auto-acknowledge the CLIENT (background).
    if (req.user.role === 'client' && job.client_email) {
      notifyBg({
        jobId: job.id, toEmail: job.client_email,
        rawSubject: 'Document received — ' + job.id,
        rawBody: 'Thank you. Your document "' + req.file.originalname + '" has been received for job ' + job.id + '.'
          + (fulfilledDesc ? '\n\nThis covers the item we requested: "' + fulfilledDesc + '".' : '')
          + (autoAdvanced
              ? '\n\nWe now have everything we asked for and have started work on your job.'
              : '\n\nOur team will review it shortly. You can track progress any time by logging in to your portal.'),
      });
    }
    // If we auto-advanced the workflow, fire the stage's standard client notification too.
    if (autoAdvanced) {
      await maybeNotifyStage(Object.assign({}, job, { stage: '03_docs_received' }));
    }
    res.json({ ok: true, autoAdvanced: autoAdvanced, fulfilled: !!fulfilledDesc });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// GET /api/documents/:id/download
app.get('/api/documents/:id/download', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT d.*, c.email AS client_email, j.accountant_email FROM documents d JOIN clients c ON c.id=d.client_id LEFT JOIN jobs j ON j.id=d.job_id WHERE d.id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'document not found' });
    const doc = r.rows[0];
    if (req.user.role === 'client') {
      // Must be the client's own job/profile...
      if (normAccount(doc.client_email) !== normAccount(req.user.email)) {
        return res.status(403).json({ error: 'not your document' });
      }
      // ...and either their OWN upload or a firm document shared with them.
      const ownUpload = normAccount(doc.uploaded_by) === normAccount(req.user.email);
      if (!ownUpload && doc.client_visible !== true) {
        return res.status(403).json({ error: 'this document is not available to you' });
      }
    } else if (req.user.role === 'accountant') {
      // Accountants may only download documents on their own jobs (matches other doc routes).
      if (normAccount(doc.accountant_email) !== normAccount(req.user.email)) {
        return res.status(403).json({ error: 'You can only access documents on your own jobs' });
      }
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

// POST /api/admin/users/:email/reset — admin sends the user a password-reset link.
app.post('/api/admin/users/:email/reset', requireAuth, requireRole('administrator'), async (req, res) => {
  const email = normAccount(req.params.email);
  try {
    const ex = await pool.query('SELECT email FROM users WHERE email=$1', [email]);
    if (!ex.rows.length) return res.status(404).json({ error: 'user not found' });
    await createAndSendReset(req, email, { byAdmin: true });
    await audit(pool, req.user.email, 'password.reset_sent', 'user', email, {});
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

// Client-Home announcement banner (admin-editable). Stored as JSON in app_settings.
app.get('/api/admin/announcement', requireAuth, requireRole('administrator'), async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM app_settings WHERE key='portal_announcement'");
    let a = { enabled: false, title: '', body: '' };
    if (r.rows.length && r.rows[0].value) { try { a = Object.assign(a, JSON.parse(r.rows[0].value)); } catch (e) { /* ignore */ } }
    res.json({ ok: true, announcement: a });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/announcement', requireAuth, requireRole('administrator'), async (req, res) => {
  const a = {
    enabled: !!req.body.enabled,
    title: String(req.body.title || '').trim().slice(0, 200),
    body: String(req.body.body || '').trim().slice(0, 2000),
  };
  try {
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_by, updated_at)
       VALUES ('portal_announcement', $1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [JSON.stringify(a), req.user.email]);
    await audit(pool, req.user.email, 'announcement.update', 'app_settings', 'portal_announcement', { enabled: a.enabled });
    res.json({ ok: true, announcement: a });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ================= ADMIN AUTOMATIONS (per-stage rules + SLA limits) =================
app.get('/api/admin/automations', requireAuth, requireRole('administrator'), async (req, res) => {
  try {
    const [rules, limits] = await Promise.all([
      pool.query('SELECT * FROM stage_automations ORDER BY stage, sort_order, id'),
      pool.query('SELECT * FROM stage_limits'),
    ]);
    res.json({ ok: true, rules: rules.rows, limits: limits.rows, stages: wf.STAGES, stageMap: wf.STAGE_MAP, triggers: AUTOMATION_TRIGGERS });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const AUTOMATION_ACTIONS = ['notify_client', 'set_action_required', 'clear_action_required', 'add_note', 'notify_staff'];
// Event triggers an admin rule can listen on. `key` describes the optional narrowing field.
const AUTOMATION_TRIGGERS = [
  { type: 'stage_enter', label: 'Job enters a stage', key: 'stage' },
  { type: 'job_created', label: 'Job is created', key: 'job_type' },
  { type: 'job_assigned', label: 'Job is assigned', key: null },
  { type: 'client_created', label: 'Client is created', key: null },
  { type: 'document_uploaded', label: 'Client uploads a document', key: null },
];
const AUTOMATION_TRIGGER_TYPES = AUTOMATION_TRIGGERS.map((t) => t.type);
// Actions that need a job in context — cannot run on client_created.
const JOB_ONLY_ACTIONS = ['set_action_required', 'clear_action_required', 'add_note'];

app.post('/api/admin/automations', requireAuth, requireRole('administrator'), async (req, res) => {
  const triggerType = String(req.body.triggerType || 'stage_enter');
  const action = String(req.body.action || '');
  if (AUTOMATION_TRIGGER_TYPES.indexOf(triggerType) === -1) return res.status(400).json({ error: 'invalid trigger' });
  if (AUTOMATION_ACTIONS.indexOf(action) === -1) return res.status(400).json({ error: 'invalid action' });
  // trigger_key: for stage_enter it must be a valid stage; for job_created it's an optional job_type; else ignored.
  let triggerKey = null;
  let stageCol = ''; // legacy `stage` column kept in sync for back-compat
  if (triggerType === 'stage_enter') {
    const stage = String(req.body.triggerKey || req.body.stage || '');
    if (!wf.isValidStage(stage)) return res.status(400).json({ error: 'invalid stage' });
    triggerKey = stage; stageCol = stage;
  } else if (triggerType === 'job_created') {
    triggerKey = String(req.body.triggerKey || '').trim() || null; // optional job_type filter
  }
  // Guard: job-only actions make no sense on the client_created event.
  if (triggerType === 'client_created' && JOB_ONLY_ACTIONS.indexOf(action) !== -1) {
    return res.status(400).json({ error: 'that action needs a job; it cannot run on client-created' });
  }
  const config = (req.body.config && typeof req.body.config === 'object') ? req.body.config : {};
  try {
    const r = await pool.query(
      `INSERT INTO stage_automations (stage, action, config, enabled, sort_order, created_by, trigger_type, trigger_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [stageCol, action, config, req.body.enabled !== false, Number(req.body.sortOrder) || 0, req.user.email, triggerType, triggerKey]);
    await audit(pool, req.user.email, 'automation.create', 'stage_automation', String(r.rows[0].id), { triggerType, triggerKey, action });
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/automations/:id', requireAuth, requireRole('administrator'), async (req, res) => {
  try {
    const cur = await pool.query('SELECT * FROM stage_automations WHERE id=$1', [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'rule not found' });
    const enabled = typeof req.body.enabled === 'boolean' ? req.body.enabled : cur.rows[0].enabled;
    const config = (req.body.config && typeof req.body.config === 'object') ? req.body.config : cur.rows[0].config;
    await pool.query('UPDATE stage_automations SET enabled=$1, config=$2 WHERE id=$3', [enabled, config, req.params.id]);
    await audit(pool, req.user.email, 'automation.update', 'stage_automation', String(req.params.id), { enabled });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/automations/:id', requireAuth, requireRole('administrator'), async (req, res) => {
  try {
    await pool.query('DELETE FROM stage_automations WHERE id=$1', [req.params.id]);
    await audit(pool, req.user.email, 'automation.delete', 'stage_automation', String(req.params.id), {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/stage-limits/:stage', requireAuth, requireRole('administrator'), async (req, res) => {
  const stage = String(req.params.stage);
  if (!wf.isValidStage(stage)) return res.status(400).json({ error: 'invalid stage' });
  const days = Math.max(0, Number(req.body.limitDays) || 0);
  try {
    await pool.query(
      `INSERT INTO stage_limits (stage, limit_days, updated_by, updated_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (stage) DO UPDATE SET limit_days=EXCLUDED.limit_days, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [stage, days, req.user.email]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ================= STAFF: mentionable colleagues (for @mention autocomplete) =================
app.get('/api/staff/mentionable', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT email, name, role FROM users WHERE role IN ('administrator','supervisor','accountant','reception') AND active=true ORDER BY name NULLS LAST, email");
    res.json({ ok: true, staff: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ================= STAFF: pipeline board (jobs grouped by stage) =================
app.get('/api/pipeline', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  try {
    const params = [];
    let where = '';
    // Accountants only see their own jobs.
    if (req.user.role === 'accountant') { params.push(normAccount(req.user.email)); where = 'WHERE lower(j.accountant_email)=$1'; }
    const jr = await pool.query(
      `SELECT j.id, j.stage, j.job_type, j.financial_year, j.priority, j.due_date, j.on_hold, j.action_required,
              j.stage_since, c.name AS client_name, e.entity_name,
              ua.name AS accountant_name
       FROM jobs j JOIN clients c ON c.id=j.client_id
       LEFT JOIN entities e ON e.id=j.entity_id
       LEFT JOIN users ua ON lower(ua.email)=lower(j.accountant_email)
       ${where} ORDER BY j.priority DESC, j.due_date NULLS LAST, j.stage_since`, params);
    const limits = await pool.query('SELECT stage, limit_days FROM stage_limits');
    const limitMap = {}; limits.rows.forEach((l) => { limitMap[l.stage] = l.limit_days; });
    const now = Date.now();
    const jobs = jr.rows.map((j) => {
      let overdue = false;
      const lim = limitMap[j.stage] || 0;
      if (lim > 0 && j.stage_since) {
        const days = (now - new Date(j.stage_since).getTime()) / 86400000;
        overdue = days > lim;
      }
      return Object.assign(j, { overdue });
    });
    res.json({ ok: true, jobs, stages: wf.STAGES, stageMap: wf.STAGE_MAP, limits: limitMap });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ================= STAFF: insights dashboard =================
app.get('/api/insights/summary', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  try {
    const scoped = req.user.role === 'accountant';
    // ---- read + validate filters ----
    const fy = String(req.query.fy || '').trim();
    const type = String(req.query.type || '').trim();
    const priority = String(req.query.priority || '').trim();
    const staff = String(req.query.staff || '').trim();
    let months = parseInt(req.query.months, 10);
    if (![3, 6, 12].includes(months)) months = 6;

    // Filter definitions shared by every jobs-based query (same param order everywhere).
    const filters = [];
    if (scoped) filters.push({ mode: 'acct', val: normAccount(req.user.email) });
    else if (staff) filters.push({ mode: 'acct', val: staff.toLowerCase() });
    if (fy) filters.push({ mode: 'plain', col: 'financial_year', val: fy });
    if (type) filters.push({ mode: 'type', val: type });
    if (priority) filters.push({ mode: 'prio', val: priority });
    const params = filters.map((f) => f.val);
    const hasFilter = filters.length > 0;
    function cond(f, pre, idx) {
      const c = pre ? pre + '.' : '';
      if (f.mode === 'acct') return `lower(${c}accountant_email)=$${idx}`;
      if (f.mode === 'type') return `COALESCE(NULLIF(${c}job_type,''),'Unspecified')=$${idx}`;
      if (f.mode === 'prio') return `COALESCE(NULLIF(${c}priority,''),'normal')=$${idx}`;
      return `${c}${f.col}=$${idx}`;
    }
    function whereClause(pre, extras) {
      const parts = filters.map((f, i) => cond(f, pre, i + 1));
      (extras || []).forEach((e) => parts.push(e));
      return parts.length ? 'WHERE ' + parts.join(' AND ') : '';
    }
    const ACTIVE = "stage <> '09_completed'";
    const EMPTY = Promise.resolve({ rows: [] });

    // All aggregations are fired concurrently (node-postgres starts each query
    // immediately); a single Promise.all then waits for them together. This turns
    // ~40 sequential Neon round-trips into a handful of concurrent batches.
    const qByStage = pool.query(`SELECT stage, COUNT(*)::int AS n FROM jobs ${whereClause('', [])} GROUP BY stage`, params);
    const qByType = pool.query(
      `SELECT COALESCE(NULLIF(job_type,''),'Unspecified') AS type, COUNT(*)::int AS n
         FROM jobs ${whereClause('', [ACTIVE])} GROUP BY 1 ORDER BY n DESC`, params);
    const qByPriority = pool.query(
      `SELECT COALESCE(NULLIF(priority,''),'normal') AS priority, COUNT(*)::int AS n
         FROM jobs ${whereClause('', [ACTIVE])} GROUP BY 1`, params);
    const qOverdue = pool.query(
      `SELECT COUNT(*)::int AS n FROM jobs ${whereClause('', ['due_date IS NOT NULL', 'due_date < CURRENT_DATE', ACTIVE])}`, params);
    const qActive = pool.query(`SELECT COUNT(*)::int AS n FROM jobs ${whereClause('', [ACTIVE])}`, params);
    const qCompleted = pool.query(`SELECT COUNT(*)::int AS n FROM jobs ${whereClause('', ["stage = '09_completed'"])}`, params);
    const qOnHold = pool.query(`SELECT COUNT(*)::int AS n FROM jobs ${whereClause('', ['on_hold = true', ACTIVE])}`, params);
    const qHighPriority = pool.query(`SELECT COUNT(*)::int AS n FROM jobs ${whereClause('', ["priority = 'high'", ACTIVE])}`, params);
    const qThroughput = pool.query(
      `SELECT to_char(date_trunc('month', h.created_at),'YYYY-MM') AS month, COUNT(*)::int AS n
         FROM job_status_history h JOIN jobs j ON j.id = h.job_id
         ${whereClause('j', ["h.to_stage='09_completed'", `h.created_at >= now() - interval '${months} months'`])}
         GROUP BY 1 ORDER BY 1`, params);
    const qIntake = pool.query(
      `SELECT to_char(date_trunc('month', created_at),'YYYY-MM') AS month, COUNT(*)::int AS n
         FROM jobs ${whereClause('', [`created_at >= now() - interval '${months} months'`])} GROUP BY 1 ORDER BY 1`, params);
    const qWorkload = scoped ? EMPTY : pool.query(
      `SELECT COALESCE(u.name, j.accountant_email, 'Unassigned') AS staff, COUNT(*)::int AS n
         FROM jobs j LEFT JOIN users u ON lower(u.email)=lower(j.accountant_email)
         ${whereClause('j', ['j.' + ACTIVE])} GROUP BY 1 ORDER BY n DESC`, params);
    const qDocsByStatus = pool.query(
      `SELECT d.status, COUNT(*)::int AS n FROM documents d JOIN jobs j ON j.id=d.job_id
         ${whereClause('j', [])} GROUP BY 1 ORDER BY n DESC`, params);
    const qDocsToReview = pool.query(
      `SELECT COUNT(*)::int AS n FROM documents d JOIN jobs j ON j.id=d.job_id ${whereClause('j', ["d.status='received'"])}`, params);
    const qOutstandingDocs = pool.query(
      `SELECT COUNT(*)::int AS n FROM doc_requests dr JOIN jobs j ON j.id=dr.job_id ${whereClause('j', ["dr.status='pending'"])}`, params);
    const qClients = (!scoped && !hasFilter)
      ? pool.query('SELECT COUNT(*)::int AS n FROM clients')
      : pool.query(`SELECT COUNT(DISTINCT client_id)::int AS n FROM jobs ${whereClause('', [])}`, params);
    const qUpcomingAppts = (!scoped && !hasFilter)
      ? pool.query("SELECT COUNT(*)::int AS n FROM appointments WHERE status='booked' AND start_time >= now()")
      : pool.query(
          `SELECT COUNT(*)::int AS n FROM appointments WHERE status='booked' AND start_time >= now()
             AND client_id IN (SELECT DISTINCT client_id FROM jobs ${whereClause('', [])})`, params);
    const qByYear = pool.query(
      `SELECT COALESCE(NULLIF(financial_year,''),'Unspecified') AS year, COUNT(*)::int AS n
         FROM jobs ${whereClause('', [ACTIVE])} GROUP BY 1 ORDER BY 1 DESC`, params);
    const qNewThisWeek = pool.query(
      `SELECT COUNT(*)::int AS n FROM jobs ${whereClause('', ["created_at >= now() - interval '7 days'"])}`, params);
    const qCompletedThisWeek = pool.query(
      `SELECT COUNT(*)::int AS n FROM job_status_history h JOIN jobs j ON j.id = h.job_id
         ${whereClause('j', ["h.to_stage='09_completed'", "h.created_at >= now() - interval '7 days'"])}`, params);
    const qApptsThisWeek = (!scoped && !hasFilter)
      ? pool.query("SELECT COUNT(*)::int AS n FROM appointments WHERE status='booked' AND start_time >= now() AND start_time < now() + interval '7 days'")
      : pool.query(
          `SELECT COUNT(*)::int AS n FROM appointments WHERE status='booked' AND start_time >= now() AND start_time < now() + interval '7 days'
             AND client_id IN (SELECT DISTINCT client_id FROM jobs ${whereClause('', [])})`, params);
    const qAvgStageAge = pool.query(
      `SELECT COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (now() - stage_since)) / 86400))::int, 0) AS n
         FROM jobs ${whereClause('', [ACTIVE])}`, params);

    // ---- Insights 2.0 aggregations ----
    const qCreatedCur = pool.query(`SELECT COUNT(*)::int AS n FROM jobs ${whereClause('', ["created_at >= now() - interval '30 days'"])}`, params);
    const qCreatedPrev = pool.query(`SELECT COUNT(*)::int AS n FROM jobs ${whereClause('', ["created_at >= now() - interval '60 days'", "created_at < now() - interval '30 days'"])}`, params);
    const qDoneCur = pool.query(
      `SELECT COUNT(*)::int AS n FROM job_status_history h JOIN jobs j ON j.id=h.job_id
         ${whereClause('j', ["h.to_stage='09_completed'", "h.created_at >= now() - interval '30 days'"])}`, params);
    const qDonePrev = pool.query(
      `SELECT COUNT(*)::int AS n FROM job_status_history h JOIN jobs j ON j.id=h.job_id
         ${whereClause('j', ["h.to_stage='09_completed'", "h.created_at >= now() - interval '60 days'", "h.created_at < now() - interval '30 days'"])}`, params);
    const qStageByPriority = pool.query(
      `SELECT stage,
              COUNT(*) FILTER (WHERE COALESCE(NULLIF(priority,''),'normal')='high')::int   AS high,
              COUNT(*) FILTER (WHERE COALESCE(NULLIF(priority,''),'normal')='normal')::int AS normal,
              COUNT(*) FILTER (WHERE COALESCE(NULLIF(priority,''),'normal')='low')::int    AS low
         FROM jobs ${whereClause('', [ACTIVE])} GROUP BY stage`, params);
    const qAvgStageDuration = pool.query(
      `SELECT stage, ROUND(AVG(days)::numeric, 1)::float AS days, COUNT(*)::int AS n FROM (
         SELECT h.to_stage AS stage,
                EXTRACT(EPOCH FROM (LEAD(h.created_at) OVER (PARTITION BY h.job_id ORDER BY h.created_at) - h.created_at))/86400 AS days
           FROM job_status_history h JOIN jobs j ON j.id=h.job_id ${whereClause('j', [])}
       ) t WHERE days IS NOT NULL GROUP BY stage`, params);
    const qCycleBox = pool.query(
      `SELECT job_type,
              ROUND(MIN(days)::numeric,1)::float AS min,
              ROUND(percentile_cont(0.25) WITHIN GROUP (ORDER BY days)::numeric,1)::float AS q1,
              ROUND(percentile_cont(0.5)  WITHIN GROUP (ORDER BY days)::numeric,1)::float AS median,
              ROUND(percentile_cont(0.75) WITHIN GROUP (ORDER BY days)::numeric,1)::float AS q3,
              ROUND(MAX(days)::numeric,1)::float AS max,
              COUNT(*)::int AS n
         FROM (
           SELECT COALESCE(NULLIF(j.job_type,''),'Unspecified') AS job_type,
                  EXTRACT(EPOCH FROM (h.created_at - j.created_at))/86400 AS days
             FROM jobs j JOIN job_status_history h ON h.job_id=j.id AND h.to_stage='09_completed'
             ${whereClause('j', [])}
         ) t GROUP BY job_type ORDER BY median DESC`, params);
    const qAgeHist = pool.query(
      `SELECT width_bucket(EXTRACT(EPOCH FROM (now()-stage_since))/86400, 0, 90, 9) AS b, COUNT(*)::int AS n
         FROM jobs ${whereClause('', [ACTIVE])} GROUP BY 1 ORDER BY 1`, params);
    const qActivity = pool.query(
      `SELECT to_char(h.created_at,'YYYY-MM') AS month, EXTRACT(DOW FROM h.created_at)::int AS dow, COUNT(*)::int AS n
         FROM job_status_history h JOIN jobs j ON j.id=h.job_id
         ${whereClause('j', [`h.created_at >= now() - interval '${months} months'`])}
         GROUP BY 1,2 ORDER BY 1,2`, params);
    const qWorkloadByStage = scoped ? EMPTY : pool.query(
      `SELECT COALESCE(u.name, j.accountant_email, 'Unassigned') AS staff, j.stage, COUNT(*)::int AS n
         FROM jobs j LEFT JOIN users u ON lower(u.email)=lower(j.accountant_email)
         ${whereClause('j', ['j.' + ACTIVE])} GROUP BY 1,2`, params);
    const qStaffBubble = scoped ? EMPTY : pool.query(
      `SELECT COALESCE(u.name, j.accountant_email, 'Unassigned') AS staff,
              COUNT(*) FILTER (WHERE j.stage<>'09_completed')::int AS active,
              COUNT(*) FILTER (WHERE j.due_date IS NOT NULL AND j.due_date<CURRENT_DATE AND j.stage<>'09_completed')::int AS overdue,
              COUNT(*)::int AS total
         FROM jobs j LEFT JOIN users u ON lower(u.email)=lower(j.accountant_email)
         ${whereClause('j', [])} GROUP BY 1 ORDER BY active DESC`, params);
    const qApptsByService = (!scoped && !hasFilter)
      ? pool.query(
          `SELECT COALESCE(NULLIF(service_name,''),'Unspecified') AS service, COUNT(*)::int AS n
             FROM appointments WHERE status='booked' AND start_time >= now() AND start_time < now() + interval '30 days'
             GROUP BY 1 ORDER BY n DESC`)
      : pool.query(
          `SELECT COALESCE(NULLIF(service_name,''),'Unspecified') AS service, COUNT(*)::int AS n
             FROM appointments WHERE status='booked' AND start_time >= now() AND start_time < now() + interval '30 days'
               AND client_id IN (SELECT DISTINCT client_id FROM jobs ${whereClause('', [])}) GROUP BY 1 ORDER BY n DESC`, params);
    const qOutstandingByStage = pool.query(
      `SELECT j.stage, COUNT(*)::int AS n FROM doc_requests dr JOIN jobs j ON j.id=dr.job_id
         ${whereClause('j', ["dr.status='pending'"])} GROUP BY j.stage ORDER BY j.stage`, params);

    // Await everything together.
    const [
      byStage, byType, byPriority, overdue, active, completed, onHold, highPriority,
      throughput, intake, workload, docsByStatus, docsToReview, outstandingDocs,
      clientsCount, upcomingAppts, byYear, newThisWeek, completedThisWeek, apptsThisWeek, avgStageAge,
      createdCur, createdPrev, doneCur, donePrev, stageByPriority, avgStageDuration, cycleBox,
      ageHist, activity, workloadByStage, staffBubble, apptsByService, outstandingByStage
    ] = await Promise.all([
      qByStage, qByType, qByPriority, qOverdue, qActive, qCompleted, qOnHold, qHighPriority,
      qThroughput, qIntake, qWorkload, qDocsByStatus, qDocsToReview, qOutstandingDocs,
      qClients, qUpcomingAppts, qByYear, qNewThisWeek, qCompletedThisWeek, qApptsThisWeek, qAvgStageAge,
      qCreatedCur, qCreatedPrev, qDoneCur, qDonePrev, qStageByPriority, qAvgStageDuration, qCycleBox,
      qAgeHist, qActivity, qWorkloadByStage, qStaffBubble, qApptsByService, qOutstandingByStage
    ]);

    const activeN = active.rows[0].n, completedN = completed.rows[0].n;
    const completionRate = (activeN + completedN) > 0 ? Math.round((completedN / (activeN + completedN)) * 100) : 0;

    // ---- filter option lists (concurrent) ----
    const optParams = scoped ? [normAccount(req.user.email)] : [];
    const optScope = scoped ? 'AND lower(accountant_email)=$1' : '';
    const [yearsQ, typesQ, staffQ] = await Promise.all([
      pool.query(
        `SELECT DISTINCT financial_year AS v FROM jobs WHERE financial_year IS NOT NULL AND financial_year<>'' ${optScope} ORDER BY 1 DESC`, optParams),
      pool.query(
        `SELECT DISTINCT COALESCE(NULLIF(job_type,''),'Unspecified') AS v FROM jobs WHERE 1=1 ${optScope} ORDER BY 1`, optParams),
      scoped ? EMPTY : pool.query(
        `SELECT lower(j.accountant_email) AS email, COALESCE(u.name, j.accountant_email) AS name
           FROM jobs j LEFT JOIN users u ON lower(u.email)=lower(j.accountant_email)
          WHERE j.accountant_email IS NOT NULL AND j.accountant_email<>'' GROUP BY 1,2 ORDER BY 2`)
    ]);
    const staffOpts = staffQ.rows;

    res.json({
      ok: true,
      scoped,
      filters: { fy, type, priority, staff, months },
      filterOptions: {
        years: yearsQ.rows.map((r) => r.v),
        types: typesQ.rows.map((r) => r.v),
        priorities: ['high', 'normal', 'low'],
        staff: staffOpts,
      },
      byStage: byStage.rows,
      byType: byType.rows,
      byPriority: byPriority.rows,
      byYear: byYear.rows,
      overdue: overdue.rows[0].n,
      active: active.rows[0].n,
      completed: completed.rows[0].n,
      onHold: onHold.rows[0].n,
      highPriority: highPriority.rows[0].n,
      newThisWeek: newThisWeek.rows[0].n,
      completedThisWeek: completedThisWeek.rows[0].n,
      apptsThisWeek: apptsThisWeek.rows[0].n,
      avgStageAge: avgStageAge.rows[0].n,
      completionRate: completionRate,
      throughput: throughput.rows,
      intake: intake.rows,
      workload: workload.rows,
      docsByStatus: docsByStatus.rows,
      docsToReview: docsToReview.rows[0].n,
      outstandingDocs: outstandingDocs.rows[0].n,
      clients: clientsCount.rows[0].n,
      upcomingAppts: upcomingAppts.rows[0].n,
      groupings: [
        { key: 'stage', label: 'Stage' },
        { key: 'type', label: 'Type' },
        { key: 'priority', label: 'Priority' },
        { key: 'year', label: 'Financial year' },
      ].concat(scoped ? [] : [{ key: 'staff', label: 'Staff' }]),
      // ---- Insights 2.0 ----
      deltas: {
        created: { cur: createdCur.rows[0].n, prev: createdPrev.rows[0].n },
        completed: { cur: doneCur.rows[0].n, prev: donePrev.rows[0].n },
      },
      stageByPriority: stageByPriority.rows,
      avgStageDuration: avgStageDuration.rows,
      cycleBox: cycleBox.rows,
      ageHist: ageHist.rows,
      activity: activity.rows,
      workloadByStage: workloadByStage.rows,
      staffBubble: staffBubble.rows,
      apptsByService: apptsByService.rows,
      outstandingByStage: outstandingByStage.rows,
      stageOrder: wf.STAGES,
      stageMap: wf.STAGE_MAP,
    });
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
    const clientIds = cr.rows.map((r) => r.id);
    const clientId = clientIds[0];
    const jr = await pool.query(
      `SELECT j.id, j.job_type, j.financial_year, j.stage, j.on_hold, j.action_required, j.updated_at,
              e.entity_name FROM jobs j LEFT JOIN entities e ON e.id=j.entity_id
       WHERE j.client_id = ANY($1) ORDER BY j.updated_at DESC`, [clientIds]);
    const jobs = [];
    for (const j of jr.rows) {
      const rc = await pool.query(
        "SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status <> 'pending')::int AS received FROM doc_requests WHERE job_id=$1",
        [j.id]);
      const requested = rc.rows[0].total;
      const received = rc.rows[0].received;
      const rem = requested - received;
      const view = wf.clientView(j, { requested: requested, received: received });
      jobs.push({
        id: j.id, jobType: j.job_type, financialYear: j.financial_year, entityName: j.entity_name,
        clientStatus: view.clientStatus, clientMessage: view.clientMessage, progressPct: view.progressPct,
        clientStep: view.clientStep, clientStepLabel: view.clientStepLabel, clientStepExplain: view.clientStepExplain,
        clientSteps: view.clientSteps,
        lastUpdate: j.updated_at, outstanding: rem,
        nextAction: portalNextAction(j, view, rem),
      });
    }
    res.json({ ok: true, clientId, jobs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/portal/jobs/:id', requireAuth, requireRole('client'), async (req, res) => {
  try {
    const cr = await pool.query('SELECT id FROM clients WHERE lower(email)=$1', [normAccount(req.user.email)]);
    if (!cr.rows.length) return res.status(404).json({ error: 'no client profile' });
    const clientIds = cr.rows.map((r) => r.id);
    const jr = await pool.query('SELECT * FROM jobs WHERE id=$1 AND client_id = ANY($2)', [req.params.id, clientIds]);
    if (!jr.rows.length) return res.status(404).json({ error: 'job not found' });
    const j = jr.rows[0];
    const reqs = await pool.query("SELECT id, category, description, due_date, status FROM doc_requests WHERE job_id=$1 ORDER BY created_at DESC", [req.params.id]);
    // Only show documents the client is allowed to see: their OWN uploads, or firm
    // documents a staff member has explicitly shared (client_visible=true). Internal
    // working papers stay hidden. `sharedByFirm` lets the UI label firm deliverables.
    const docs = await pool.query(
      `SELECT id, category, filename, created_at, status, review_note,
              (lower(uploaded_by) = $2) AS is_own_upload,
              (client_visible AND lower(uploaded_by) <> $2) AS shared_by_firm
         FROM documents
        WHERE job_id=$1 AND (client_visible = true OR lower(uploaded_by) = $2)
        ORDER BY created_at DESC`,
      [req.params.id, normAccount(req.user.email)]);
    const requested = reqs.rows.length;
    const received = reqs.rows.filter((r) => r.status !== 'pending').length;
    const view = wf.clientView(j, { requested: requested, received: received });
    res.json({ ok: true, job: {
      id: j.id, jobType: j.job_type, financialYear: j.financial_year,
      clientStatus: view.clientStatus, clientMessage: view.clientMessage, progressPct: view.progressPct, lastUpdate: j.updated_at,
      clientStep: view.clientStep, clientStepLabel: view.clientStepLabel, clientStepExplain: view.clientStepExplain, clientSteps: view.clientSteps,
      canSign: j.stage === '06_awaiting_signature' && !j.on_hold,
    }, docRequests: reqs.rows, documents: docs.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/portal/summary — everything the client Home dashboard needs in one call:
// their name, an aggregated "Action Required" list, a brief of current work, the next
// appointment placeholder (Setmore wired in a later stage), and recent messages.
app.get('/api/portal/summary', requireAuth, requireRole('client'), async (req, res) => {
  try {
    const cr = await pool.query('SELECT id, name FROM clients WHERE lower(email)=$1', [normAccount(req.user.email)]);
    const clientName = (cr.rows[0] && cr.rows[0].name) || req.user.name || '';
    if (!cr.rows.length) {
      return res.json({ ok: true, clientName: clientName, actions: [], jobs: [], messages: [] });
    }
    const clientIds = cr.rows.map((r) => r.id);
    const jr = await pool.query(
      `SELECT j.id, j.job_type, j.financial_year, j.stage, j.on_hold, j.action_required, j.updated_at,
              e.entity_name FROM jobs j LEFT JOIN entities e ON e.id=j.entity_id
       WHERE j.client_id = ANY($1) ORDER BY j.updated_at DESC`, [clientIds]);

    const jobs = [];
    const completedJobs = [];
    const actions = [];
    for (const j of jr.rows) {
      const rc = await pool.query(
        "SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status <> 'pending')::int AS received FROM doc_requests WHERE job_id=$1",
        [j.id]);
      const requested = rc.rows[0].total;
      const received = rc.rows[0].received;
      const view = wf.clientView(j, { requested: requested, received: received });
      const pend = await pool.query(
        "SELECT description FROM doc_requests WHERE job_id=$1 AND status='pending' ORDER BY created_at", [j.id]);
      const outstanding = pend.rows.length;
      // Aggregate action items across all jobs for the Home "Action Required" widget.
      pend.rows.forEach((p) => {
        actions.push({ jobId: j.id, type: 'upload', label: 'Upload ' + p.description });
      });
      if (j.stage === '06_awaiting_signature' && !j.on_hold) {
        actions.push({ jobId: j.id, type: 'sign', label: 'Sign ' + (j.job_type || 'your documents') });
      }
      // Only surface active (not completed) jobs as "current work".
      if (j.stage !== '09_completed') {
        jobs.push({
          id: j.id, jobType: j.job_type, financialYear: j.financial_year, entityName: j.entity_name,
          clientStatus: view.clientStatus, clientMessage: view.clientMessage, progressPct: view.progressPct,
          clientStep: view.clientStep, clientStepLabel: view.clientStepLabel, clientStepExplain: view.clientStepExplain,
          outstanding: outstanding, lastUpdate: j.updated_at,
        });
      } else if (completedJobs.length < 5) {
        // Recently completed work — client-safe fields only (no staff data).
        completedJobs.push({
          id: j.id, jobType: j.job_type, financialYear: j.financial_year, entityName: j.entity_name,
          completedAt: j.updated_at,
        });
      }
    }

    const msgs = await pool.query(
      'SELECT id, job_id, subject, body, created_at, read_at FROM notifications WHERE lower(to_email)=$1 ORDER BY created_at DESC LIMIT 5',
      [normAccount(req.user.email)]);

    // Next upcoming appointment (booked, in the future) for the dashboard card.
    // NOTE: staff_name here is the Setmore adviser the CLIENT chose when booking (a separate
    // Setmore staff list) — it is NOT an internal app user / offshore accountant, so showing it
    // is safe and is exactly what the brief asks ("see which adviser they are meeting").
    const ap = await pool.query(
      `SELECT service_name, staff_name, start_time FROM appointments
        WHERE client_id = ANY($1) AND status='booked' AND start_time >= now()
        ORDER BY start_time ASC LIMIT 1`, [clientIds]);

    // Firm-wide announcement banner for the client Home (admin-editable via app_settings).
    let announcement = null;
    try {
      const anr = await pool.query("SELECT value FROM app_settings WHERE key='portal_announcement'");
      if (anr.rows.length && anr.rows[0].value) {
        const a = JSON.parse(anr.rows[0].value);
        if (a && a.enabled && (a.title || a.body)) announcement = { title: a.title || '', body: a.body || '' };
      }
    } catch (e) { /* ignore malformed announcement */ }

    res.json({ ok: true, clientName: clientName, actions: actions, jobs: jobs,
      completedJobs: completedJobs, messages: msgs.rows,
      nextAppointment: ap.rows[0] || null, announcement: announcement });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Required client profile fields — used by the onboarding gate + completion check.
function profileIsComplete(c) {
  if (!c) return false;
  var pref = String(c.preferred_contact || '').toLowerCase();
  return !!(String(c.name || '').trim()
    && c.dob
    && String(c.mobile || '').trim()
    && String(c.address || '').trim()
    && ['email', 'mobile', 'phone'].indexOf(pref) !== -1);
}

function isoDob(dob) {
  if (!dob) return '';
  try { return new Date(dob).toISOString().slice(0, 10); } catch (e) { return ''; }
}

// GET /api/portal/profile — the client's basic contact details (no sensitive tax data).
app.get('/api/portal/profile', requireAuth, requireRole('client'), async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, name, email, phone, address, mobile, preferred_contact, dob FROM clients WHERE lower(email)=$1 ORDER BY id LIMIT 1',
      [normAccount(req.user.email)]);
    const c = r.rows[0] || { name: req.user.name || '', email: req.user.email };
    res.json({ ok: true, profile: {
      name: c.name || '', email: c.email || req.user.email, phone: c.phone || '',
      address: c.address || '', mobile: c.mobile || '', preferredContact: c.preferred_contact || 'email',
      dob: isoDob(c.dob),
    } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/portal/status — onboarding gate flags for the signed-in client.
app.get('/api/portal/status', requireAuth, requireRole('client'), async (req, res) => {
  try {
    const email = normAccount(req.user.email);
    const ur = await pool.query('SELECT mfa_enabled FROM users WHERE email=$1', [email]);
    const mfaEnabled = !!(ur.rows[0] && ur.rows[0].mfa_enabled);
    const cr = await pool.query(
      'SELECT name, address, mobile, preferred_contact, dob FROM clients WHERE lower(email)=$1 ORDER BY id LIMIT 1',
      [email]);
    res.json({ ok: true, mfaEnabled, profileComplete: profileIsComplete(cr.rows[0]) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/portal/profile/complete — mandatory onboarding: all fields required.
app.post('/api/portal/profile/complete', requireAuth, requireRole('client'), async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const dob = String(req.body.dob || '').trim();
    const mobile = String(req.body.mobile || '').trim();
    const address = String(req.body.address || '').trim();
    const phone = String(req.body.phone || '').trim();
    let pref = String(req.body.preferredContact || '').trim().toLowerCase();

    if (!name) return res.status(400).json({ error: 'Please enter your full name.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return res.status(400).json({ error: 'Please enter a valid date of birth.' });
    if (!mobile) return res.status(400).json({ error: 'Please enter your mobile number.' });
    if (!address) return res.status(400).json({ error: 'Please enter your residential address.' });
    if (['email', 'mobile', 'phone'].indexOf(pref) === -1) return res.status(400).json({ error: 'Please choose a preferred contact method.' });

    const id = await ensureClientForUser(req.user.email, name);
    if (!id) return res.status(500).json({ error: 'Could not create your profile. Please try again.' });
    await pool.query(
      'UPDATE clients SET name=$1, dob=$2, mobile=$3, address=$4, phone=$5, preferred_contact=$6 WHERE id=$7',
      [name, dob, mobile, address, phone || null, pref, id]);
    await audit(pool, req.user.email, 'client.profile_complete', 'client', id, { by: 'client' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/portal/profile — client updates their own basic contact details only.
app.post('/api/portal/profile', requireAuth, requireRole('client'), async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const address = String(req.body.address || '').trim();
    const mobile = String(req.body.mobile || '').trim();
    const phone = String(req.body.phone || '').trim();
    const dob = String(req.body.dob || '').trim();
    let pref = String(req.body.preferredContact || 'email').trim().toLowerCase();
    if (['email', 'mobile', 'phone'].indexOf(pref) === -1) pref = 'email';
    // Upsert: create the clients row if it does not exist yet (self sign-up / social login).
    const id = await ensureClientForUser(req.user.email, name);
    if (!id) return res.status(500).json({ error: 'Could not save your profile. Please try again.' });
    const dobVal = /^\d{4}-\d{2}-\d{2}$/.test(dob) ? dob : null;
    await pool.query(
      'UPDATE clients SET name=COALESCE(NULLIF($1,\'\'), name), address=$2, mobile=$3, phone=$4, preferred_contact=$5, dob=COALESCE($6, dob) WHERE id=$7',
      [name, address || null, mobile || null, phone || null, pref, dobVal, id]);
    await audit(pool, req.user.email, 'client.profile_update', 'client', id, { by: 'client' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/portal/documents/:id — a client removes a document THEY uploaded on THEIR job.
app.delete('/api/portal/documents/:id', requireAuth, requireRole('client'), async (req, res) => {
  try {
    const cr = await pool.query('SELECT id FROM clients WHERE lower(email)=$1', [normAccount(req.user.email)]);
    if (!cr.rows.length) return res.status(404).json({ error: 'no client profile' });
    const clientIds = cr.rows.map((r) => r.id);
    const r = await pool.query('SELECT * FROM documents WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'document not found' });
    const doc = r.rows[0];
    // Must belong to this client AND have been uploaded by this client.
    if (clientIds.indexOf(doc.client_id) === -1 || normAccount(doc.uploaded_by) !== normAccount(req.user.email)) {
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
    const clientIds = cr.rows.map((r) => r.id);
    const jr = await client.query('SELECT * FROM jobs WHERE id=$1 AND client_id = ANY($2) FOR UPDATE', [req.params.id, clientIds]);
    if (!jr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'job not found' }); }
    const job = jr.rows[0];
    if (job.stage !== '06_awaiting_signature') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'this job is not awaiting your signature' }); }
    if (job.on_hold) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'this job is on hold' }); }
    const signerName = String((req.body && req.body.name) || '').trim();
    if (!signerName) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Please type your full name to sign' }); }
    if (!(req.body && req.body.consent === true)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Please tick the confirmation box to authorise lodgement' }); }
    // Capture a lightweight e-signature audit trail (IP + user agent + timestamp).
    const signIp = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const signUa = String(req.headers['user-agent'] || '').slice(0, 400);
    await client.query('UPDATE jobs SET signed_by=$1, signed_at=now(), signed_ip=$2, signed_user_agent=$3 WHERE id=$4', [signerName, signIp, signUa, job.id]);
    await changeStage(client, job, '07_ready_lodgement', req.user.email, 'Signed by client: ' + signerName);
    await audit(client, req.user.email, 'job.signed', 'job', job.id, { signedBy: signerName, ip: signIp });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// GET /api/portal/previous — the client's archive of COMPLETED work plus any firm
// documents that have been shared with them (final returns, notices of assessment).
// Read-only. Never exposes staff names or internal notes.
app.get('/api/portal/previous', requireAuth, requireRole('client'), async (req, res) => {
  try {
    const cr = await pool.query('SELECT id FROM clients WHERE lower(email)=$1', [normAccount(req.user.email)]);
    if (!cr.rows.length) return res.json({ ok: true, jobs: [] });
    const clientIds = cr.rows.map((r) => r.id);
    const jr = await pool.query(
      `SELECT j.id, j.job_type, j.financial_year, j.stage, j.updated_at, e.entity_name
         FROM jobs j LEFT JOIN entities e ON e.id=j.entity_id
        WHERE j.client_id = ANY($1) AND j.stage='09_completed'
        ORDER BY j.updated_at DESC`, [clientIds]);
    const me = normAccount(req.user.email);
    const jobs = [];
    for (const j of jr.rows) {
      // Only client-visible documents (their own uploads OR firm-shared deliverables).
      const dr = await pool.query(
        `SELECT id, category, filename, created_at,
                (client_visible AND lower(uploaded_by) <> $2) AS shared_by_firm
           FROM documents
          WHERE job_id=$1 AND (client_visible = true OR lower(uploaded_by) = $2)
          ORDER BY created_at DESC`, [j.id, me]);
      jobs.push({
        id: j.id, jobType: j.job_type, financialYear: j.financial_year,
        entityName: j.entity_name, completedAt: j.updated_at, documents: dr.rows,
      });
    }
    res.json({ ok: true, jobs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ================= SECURE CLIENT MESSAGING (Stage 6) =================
// A single conversation thread per client between them and the firm. The client
// side never shows staff names — all firm replies are attributed to "Syraxx".

// GET /api/portal/messages — the client's full conversation thread. Marks inbound
// (firm→client) messages as read by the client.
app.get('/api/portal/messages', requireAuth, requireRole('client'), async (req, res) => {
  try {
    const clientId = await clientIdForUser(req.user.email);
    if (!clientId) return res.json({ ok: true, messages: [] });
    const r = await pool.query(
      `SELECT id, job_id, direction, body, created_at FROM client_messages
        WHERE client_id=$1 ORDER BY created_at ASC`, [clientId]);
    await pool.query("UPDATE client_messages SET read_by_client=true WHERE client_id=$1 AND direction='out' AND read_by_client=false", [clientId]);
    res.json({ ok: true, messages: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/portal/messages/count — unread firm→client messages (for a badge).
app.get('/api/portal/messages/count', requireAuth, requireRole('client'), async (req, res) => {
  try {
    const clientId = await clientIdForUser(req.user.email);
    if (!clientId) return res.json({ ok: true, count: 0 });
    const r = await pool.query("SELECT COUNT(*)::int AS n FROM client_messages WHERE client_id=$1 AND direction='out' AND read_by_client=false", [clientId]);
    res.json({ ok: true, count: r.rows[0].n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/portal/messages { body } — client sends a message to the firm.
app.post('/api/portal/messages', requireAuth, requireRole('client'), async (req, res) => {
  try {
    const clientId = await clientIdForUser(req.user.email);
    if (!clientId) return res.status(404).json({ error: 'no client profile' });
    const body = String(req.body.body || '').trim().slice(0, 4000);
    if (!body) return res.status(400).json({ error: 'message is empty' });
    const ins = await pool.query(
      "INSERT INTO client_messages (client_id, direction, sender_email, body, read_by_client) VALUES ($1,'in',$2,$3,true) RETURNING id, direction, body, created_at",
      [clientId, normAccount(req.user.email), body]);
    await audit(pool, req.user.email, 'message.client_send', 'client', clientId, {});
    // Notify the client's assigned accountants (best effort) that a new message arrived.
    const jr = await pool.query("SELECT DISTINCT accountant_email FROM jobs WHERE client_id=$1 AND accountant_email IS NOT NULL", [clientId]);
    jr.rows.forEach((row) => {
      notifyBg({ toEmail: row.accountant_email, rawSubject: 'New client message',
        rawBody: 'A client sent a new message via the portal. Log in to view and reply.' });
    });
    res.json({ ok: true, message: ins.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Staff side ----
// GET /api/clients/:id/messages — staff view a client's thread (marks inbound read).
app.get('/api/clients/:id/messages', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  try {
    // Accountants may only view clients they have a job with.
    if (req.user.role === 'accountant') {
      const own = await pool.query('SELECT 1 FROM jobs WHERE client_id=$1 AND lower(accountant_email)=lower($2) LIMIT 1', [req.params.id, req.user.email]);
      if (!own.rows.length) return res.status(403).json({ error: 'You can only message your own clients' });
    }
    const r = await pool.query(
      `SELECT m.id, m.job_id, m.direction, m.sender_email, m.body, m.created_at, u.name AS sender_name
         FROM client_messages m LEFT JOIN users u ON lower(u.email)=lower(m.sender_email)
        WHERE m.client_id=$1 ORDER BY m.created_at ASC`, [req.params.id]);
    await pool.query("UPDATE client_messages SET read_by_staff=true WHERE client_id=$1 AND direction='in' AND read_by_staff=false", [req.params.id]);
    res.json({ ok: true, messages: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/clients/:id/messages { body } — staff reply to a client.
app.post('/api/clients/:id/messages', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  try {
    if (req.user.role === 'accountant') {
      const own = await pool.query('SELECT 1 FROM jobs WHERE client_id=$1 AND lower(accountant_email)=lower($2) LIMIT 1', [req.params.id, req.user.email]);
      if (!own.rows.length) return res.status(403).json({ error: 'You can only message your own clients' });
    }
    const cr = await pool.query('SELECT id, email FROM clients WHERE id=$1', [req.params.id]);
    if (!cr.rows.length) return res.status(404).json({ error: 'client not found' });
    const body = String(req.body.body || '').trim().slice(0, 4000);
    if (!body) return res.status(400).json({ error: 'message is empty' });
    const ins = await pool.query(
      "INSERT INTO client_messages (client_id, direction, sender_email, body, read_by_staff) VALUES ($1,'out',$2,$3,true) RETURNING id, direction, body, created_at",
      [req.params.id, normAccount(req.user.email), body]);
    await audit(pool, req.user.email, 'message.staff_send', 'client', req.params.id, {});
    // Email the client that a new secure message is waiting (no message body in email).
    if (cr.rows[0].email) {
      notifyBg({ toEmail: cr.rows[0].email, rawSubject: 'New message from Syraxx',
        rawBody: 'You have a new secure message from our team. Please log in to your portal to read and reply.' });
    }
    res.json({ ok: true, message: ins.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ================= DIRECT CLIENT EMAIL + EMAIL LOG (Wave 4A) =================
// GET /api/clients/:id/emails — staff view direct emails sent to this client's address.
// Only lists rows with template_key='client_email' (the direct-email feature), so it never
// leaks unrelated system notifications. Accountants are scoped to their own clients.
app.get('/api/clients/:id/emails', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  try {
    if (req.user.role === 'accountant') {
      const own = await pool.query('SELECT 1 FROM jobs WHERE client_id=$1 AND lower(accountant_email)=lower($2) LIMIT 1', [req.params.id, req.user.email]);
      if (!own.rows.length) return res.status(403).json({ error: 'You can only view your own clients' });
    }
    const cr = await pool.query('SELECT id, email FROM clients WHERE id=$1', [req.params.id]);
    if (!cr.rows.length) return res.status(404).json({ error: 'client not found' });
    if (!cr.rows[0].email) return res.json({ ok: true, emails: [] });
    const r = await pool.query(
      `SELECT id, subject, body, status, created_at FROM notifications
         WHERE lower(to_email)=lower($1) AND template_key='client_email'
         ORDER BY created_at DESC LIMIT 50`, [cr.rows[0].email]);
    res.json({ ok: true, emails: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/clients/:id/email { subject, body } — staff send a direct email to a client.
// The subject + body ARE the email content (unlike secure messages, which only notify).
// Sends via sendNotification (real SMTP if configured, otherwise logged) and records it in
// the notifications table with template_key='client_email' for the email log above.
app.post('/api/clients/:id/email', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  try {
    if (req.user.role === 'accountant') {
      const own = await pool.query('SELECT 1 FROM jobs WHERE client_id=$1 AND lower(accountant_email)=lower($2) LIMIT 1', [req.params.id, req.user.email]);
      if (!own.rows.length) return res.status(403).json({ error: 'You can only email your own clients' });
    }
    const cr = await pool.query('SELECT id, email, name FROM clients WHERE id=$1', [req.params.id]);
    if (!cr.rows.length) return res.status(404).json({ error: 'client not found' });
    if (!cr.rows[0].email) return res.status(400).json({ error: 'This client has no email address on file' });
    const subject = String(req.body.subject || '').trim().slice(0, 200);
    const body = String(req.body.body || '').trim().slice(0, 8000);
    if (!subject) return res.status(400).json({ error: 'Subject is required' });
    if (!body) return res.status(400).json({ error: 'Message body is required' });
    const result = await sendNotification(pool, { toEmail: cr.rows[0].email, templateKey: 'client_email', rawSubject: subject, rawBody: body });
    await audit(pool, req.user.email, 'client.email_sent', 'client', req.params.id, { subject });
    res.json({ ok: true, status: result.status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ================= INVOICES / PAYMENT (Phase 1 #13/#15, record-only) =================
// Accountants may only touch invoices for their own clients; other staff see all.
async function assertClientOwnedOr403(req, res, clientId) {
  if (req.user.role === 'accountant') {
    const own = await pool.query('SELECT 1 FROM jobs WHERE client_id=$1 AND lower(accountant_email)=lower($2) LIMIT 1', [clientId, req.user.email]);
    if (!own.rows.length) { res.status(403).json({ error: 'You can only manage your own clients' }); return false; }
  }
  return true;
}
// Load an invoice + enforce accountant scoping via its client. Returns the row or null (response already sent).
async function loadInvoiceOr403(req, res) {
  const r = await pool.query('SELECT * FROM invoices WHERE id=$1', [req.params.id]);
  if (!r.rows.length) { res.status(404).json({ error: 'invoice not found' }); return null; }
  if (!(await assertClientOwnedOr403(req, res, r.rows[0].client_id))) return null;
  return r.rows[0];
}

// GET /api/clients/:id/invoices — staff list a client's invoices.
app.get('/api/clients/:id/invoices', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  try {
    if (!(await assertClientOwnedOr403(req, res, req.params.id))) return;
    const r = await pool.query(
      `SELECT id, job_id, description, amount_cents, currency, status, due_date, issued_at, paid_at, paid_method
         FROM invoices WHERE client_id=$1 ORDER BY issued_at DESC LIMIT 100`, [req.params.id]);
    res.json({ ok: true, invoices: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/clients/:id/invoices { amount, description, dueDate, jobId } — staff raise an invoice.
// `amount` is dollars (e.g. 150 or "150.50"); stored as integer cents.
app.post('/api/clients/:id/invoices', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  try {
    if (!(await assertClientOwnedOr403(req, res, req.params.id))) return;
    const cr = await pool.query('SELECT id FROM clients WHERE id=$1', [req.params.id]);
    if (!cr.rows.length) return res.status(404).json({ error: 'client not found' });
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'A positive amount is required' });
    const amountCents = Math.round(amount * 100);
    const description = String(req.body.description || '').trim().slice(0, 500) || null;
    const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(req.body.dueDate || '') ? req.body.dueDate : null;
    let jobId = String(req.body.jobId || '').trim() || null;
    if (jobId) {
      const jr = await pool.query('SELECT 1 FROM jobs WHERE id=$1 AND client_id=$2', [jobId, req.params.id]);
      if (!jr.rows.length) return res.status(400).json({ error: 'jobId does not belong to this client' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const id = await nextId(client, 'invoice', 'INV-');
      await client.query(
        `INSERT INTO invoices (id, client_id, job_id, description, amount_cents, due_date, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, req.params.id, jobId, description, amountCents, dueDate, req.user.email]);
      await audit(client, req.user.email, 'invoice.created', 'invoice', id, { amountCents, clientId: req.params.id });
      await client.query('COMMIT');
      res.json({ ok: true, id });
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/invoices/:id/paid { method, ref } — staff mark an invoice paid (manual record).
app.post('/api/invoices/:id/paid', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  try {
    const inv = await loadInvoiceOr403(req, res);
    if (!inv) return;
    if (inv.status === 'paid') return res.json({ ok: true, status: 'paid' }); // idempotent
    const method = String(req.body.method || 'manual').trim().slice(0, 40);
    const ref = String(req.body.ref || '').trim().slice(0, 100) || null;
    await pool.query(
      `UPDATE invoices SET status='paid', paid_at=now(), paid_method=$2, paid_ref=$3 WHERE id=$1`,
      [inv.id, method, ref]);
    await audit(pool, req.user.email, 'invoice.marked_paid', 'invoice', inv.id, { method, ref });
    res.json({ ok: true, status: 'paid' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/invoices/:id/void — staff void an invoice.
app.post('/api/invoices/:id/void', requireAuth, requireRole.apply(null, STAFF), async (req, res) => {
  try {
    const inv = await loadInvoiceOr403(req, res);
    if (!inv) return;
    await pool.query(`UPDATE invoices SET status='void' WHERE id=$1`, [inv.id]);
    await audit(pool, req.user.email, 'invoice.voided', 'invoice', inv.id, null);
    res.json({ ok: true, status: 'void' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ================= APPOINTMENTS (Setmore, Stage 7) =================
// Format a JS Date as Setmore's dd/MM/yyyy (for slots).
function setmoreDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear();
}

// GET /api/appointments/services — bookable services + the staff who can deliver them.
// Available to any signed-in user (client or staff).
app.get('/api/appointments/services', requireAuth, async (req, res) => {
  try {
    if (!setmore.isConfigured()) return res.json({ ok: true, configured: false, services: [], staff: [] });
    const [services, staff] = await Promise.all([setmore.getServices(), setmore.getStaff()]);
    res.json({ ok: true, configured: true, services, staff });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// GET /api/appointments/slots?staffKey=&serviceKey=&date=YYYY-MM-DD — free slots.
app.get('/api/appointments/slots', requireAuth, async (req, res) => {
  try {
    if (!setmore.isConfigured()) return res.json({ ok: true, slots: [] });
    const staffKey = String(req.query.staffKey || '');
    const serviceKey = String(req.query.serviceKey || '');
    const isoDate = String(req.query.date || '');
    if (!staffKey || !serviceKey || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
      return res.status(400).json({ error: 'staffKey, serviceKey and date (YYYY-MM-DD) are required' });
    }
    const [y, m, d] = isoDate.split('-').map(Number);
    const slots = await setmore.getSlots(staffKey, serviceKey, setmoreDate(new Date(y, m - 1, d)), 30);
    res.json({ ok: true, slots });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// POST /api/portal/appointments { serviceKey, serviceName, staffKey, staffName, date, slot, durationMins }
// Client books an appointment. We create a Setmore customer + appointment, then
// mirror it locally for the portal.
app.post('/api/portal/appointments', requireAuth, requireRole('client'), async (req, res) => {
  try {
    if (!setmore.isConfigured()) return res.status(400).json({ error: 'Online booking is not available right now.' });
    const cr = await pool.query('SELECT id, name, email, phone FROM clients WHERE lower(email)=$1 ORDER BY id LIMIT 1', [normAccount(req.user.email)]);
    if (!cr.rows.length) return res.status(404).json({ error: 'no client profile' });
    const client = cr.rows[0];
    const b = req.body || {};
    const isoDate = String(b.date || '');
    const slot = String(b.slot || '');
    if (!b.serviceKey || !b.staffKey || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate) || !slot) {
      return res.status(400).json({ error: 'serviceKey, staffKey, date and slot are required' });
    }
    const times = setmore.slotToTimes(isoDate, slot, Number(b.durationMins) || 30);
    // Create / reuse the Setmore customer for this client.
    const nameParts = String(client.name || 'Client').trim().split(/\s+/);
    const customerKey = await setmore.createCustomer({
      firstName: nameParts[0] || 'Client',
      lastName: nameParts.slice(1).join(' '),
      email: client.email || '',
      phone: client.phone || '',
    });
    const appt = await setmore.createAppointment({
      staffKey: b.staffKey, serviceKey: b.serviceKey, customerKey: customerKey,
      startTime: times.start_time, endTime: times.end_time,
    });
    const apptKey = (appt && (appt.appointment && appt.appointment.key)) || (appt && appt.key) || null;
    // Mirror locally.
    const ins = await pool.query(
      `INSERT INTO appointments (client_id, setmore_appt_key, service_key, service_name, staff_key, staff_name, start_time, end_time, booked_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [client.id, apptKey, b.serviceKey, b.serviceName || null, b.staffKey, b.staffName || null,
       times.start_time, times.end_time, req.user.email]);
    await audit(pool, req.user.email, 'appointment.book', 'client', client.id, { apptKey, serviceKey: b.serviceKey, start: times.start_time });
    res.json({ ok: true, id: ins.rows[0].id, setmoreKey: apptKey });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// GET /api/portal/appointments — the client's own upcoming + past appointments.
app.get('/api/portal/appointments', requireAuth, requireRole('client'), async (req, res) => {
  try {
    const cr = await pool.query('SELECT id FROM clients WHERE lower(email)=$1', [normAccount(req.user.email)]);
    if (!cr.rows.length) return res.json({ ok: true, upcoming: [], past: [] });
    const clientIds = cr.rows.map((r) => r.id);
    const r = await pool.query(
      `SELECT id, service_key, service_name, staff_key, staff_name, start_time, end_time, status
         FROM appointments WHERE client_id = ANY($1) AND status='booked' ORDER BY start_time ASC`, [clientIds]);
    const now = Date.now();
    const upcoming = [], past = [];
    r.rows.forEach((a) => { (new Date(a.start_time).getTime() >= now ? upcoming : past).push(a); });
    res.json({ ok: true, upcoming, past: past.reverse() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Helper: load a client-owned, still-booked, upcoming appointment (shared by cancel + reschedule).
async function loadOwnedUpcomingAppt(runner, userEmail, apptId) {
  const cr = await runner.query('SELECT id FROM clients WHERE lower(email)=$1', [normAccount(userEmail)]);
  if (!cr.rows.length) return { error: 404, msg: 'no client profile' };
  const clientIds = cr.rows.map((r) => r.id);
  const ar = await runner.query('SELECT * FROM appointments WHERE id=$1 AND client_id = ANY($2)', [apptId, clientIds]);
  if (!ar.rows.length) return { error: 404, msg: 'appointment not found' };
  const appt = ar.rows[0];
  if (appt.status !== 'booked') return { error: 400, msg: 'this appointment is no longer active' };
  if (new Date(appt.start_time).getTime() < Date.now()) return { error: 400, msg: 'past appointments cannot be changed' };
  return { appt, clientIds };
}

// POST /api/portal/appointments/:id/cancel — client cancels their own upcoming booking.
app.post('/api/portal/appointments/:id/cancel', requireAuth, requireRole('client'), async (req, res) => {
  try {
    const found = await loadOwnedUpcomingAppt(pool, req.user.email, req.params.id);
    if (found.error) return res.status(found.error).json({ error: found.msg });
    const appt = found.appt;
    // Setmore has no cancel API; flag the booking's label so staff can spot it
    // in the dashboard. Best-effort — never block the local cancel if it errors.
    if (appt.setmore_appt_key && setmore.isConfigured()) {
      try { await setmore.labelAppointment(appt.setmore_appt_key, 'CANCELLED'); }
      catch (e) { console.error('[appt cancel setmore label]', e.message); }
    }
    await pool.query("UPDATE appointments SET status='cancelled' WHERE id=$1", [appt.id]);
    await audit(pool, req.user.email, 'appointment.cancel', 'client', appt.client_id, { apptId: appt.id, setmoreKey: appt.setmore_appt_key });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/portal/appointments/:id/reschedule { date, slot, durationMins } — move to a new time.
// Implemented as create-new-then-cancel-old on Setmore, keeping the same service + staff.
app.post('/api/portal/appointments/:id/reschedule', requireAuth, requireRole('client'), async (req, res) => {
  try {
    if (!setmore.isConfigured()) return res.status(400).json({ error: 'Online booking is not available right now.' });
    const found = await loadOwnedUpcomingAppt(pool, req.user.email, req.params.id);
    if (found.error) return res.status(found.error).json({ error: found.msg });
    const appt = found.appt;
    const b = req.body || {};
    const isoDate = String(b.date || '');
    const slot = String(b.slot || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate) || !slot) return res.status(400).json({ error: 'date and slot are required' });
    if (!appt.service_key || !appt.staff_key) return res.status(400).json({ error: 'this appointment cannot be rescheduled online' });
    const cr = await pool.query('SELECT id, name, email, phone FROM clients WHERE id=$1', [appt.client_id]);
    const client = cr.rows[0];
    const times = setmore.slotToTimes(isoDate, slot, Number(b.durationMins) || 30);
    const nameParts = String(client.name || 'Client').trim().split(/\s+/);
    const customerKey = await setmore.createCustomer({
      firstName: nameParts[0] || 'Client', lastName: nameParts.slice(1).join(' '),
      email: client.email || '', phone: client.phone || '',
    });
    // Book the new slot first so a Setmore failure leaves the original intact.
    const newAppt = await setmore.createAppointment({
      staffKey: appt.staff_key, serviceKey: appt.service_key, customerKey: customerKey,
      startTime: times.start_time, endTime: times.end_time,
    });
    const newKey = (newAppt && (newAppt.appointment && newAppt.appointment.key)) || (newAppt && newAppt.key) || null;
    // Flag the OLD Setmore booking (no cancel API) so staff can clear it. Best-effort.
    if (appt.setmore_appt_key) {
      try { await setmore.labelAppointment(appt.setmore_appt_key, 'CANCELLED - rescheduled'); }
      catch (e) { console.error('[appt reschedule setmore label]', e.message); }
    }
    await pool.query(
      'UPDATE appointments SET setmore_appt_key=$1, start_time=$2, end_time=$3 WHERE id=$4',
      [newKey, times.start_time, times.end_time, appt.id]);
    await audit(pool, req.user.email, 'appointment.reschedule', 'client', appt.client_id, { apptId: appt.id, from: appt.start_time, to: times.start_time });
    res.json({ ok: true, id: appt.id, start_time: times.start_time });
  } catch (e) { res.status(502).json({ error: e.message }); }
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

app.post('/api/save', requireAuth, enforceAccountAccess, async (req, res) => {
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

app.get('/api/load', requireAuth, enforceAccountAccess, async (req, res) => {
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

app.get('/api/list', requireAuth, enforceAccountAccess, async (req, res) => {
  const account = normAccount(req.query.account);
  if (!account) return res.status(400).json({ error: 'account required' });
  try {
    const r = await pool.query('SELECT app, updated_at FROM customer_data WHERE account=$1 ORDER BY app', [account]);
    res.json({ ok: true, saves: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/merge', requireAuth, enforceAccountAccess, async (req, res) => {
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

app.get('/api/export', requireAuth, enforceAccountAccess, async (req, res) => {
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

// ================= AI HELP ASSISTANT (OpenRouter) =================
// Context-aware help chat. The API key stays server-side; the browser only ever
// talks to /api/assistant. Auth is OPTIONAL: if a valid Bearer token is present we
// personalise by role, otherwise we still answer general how-to questions.
const { APP_KB } = require('./assistant-kb');
const AI_MODEL = process.env.OPENROUTER_MODEL || 'qwen/qwen3.8-27b';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Simple in-memory rate limiter: max requests per key per rolling window.
const AI_RL_WINDOW_MS = 60 * 1000;
const AI_RL_MAX = Number(process.env.AI_RATE_MAX || 20);
const aiHits = new Map(); // key -> [timestamps]
function aiRateLimited(key) {
  const now = Date.now();
  const arr = (aiHits.get(key) || []).filter((t) => now - t < AI_RL_WINDOW_MS);
  arr.push(now);
  aiHits.set(key, arr);
  return arr.length > AI_RL_MAX;
}
// Opportunistically resolve the caller's role from their session token (no hard fail).
async function softUser(req) {
  const h = req.headers.authorization || '';
  const token = h.indexOf('Bearer ') === 0 ? h.slice(7) : null;
  if (!token) return null;
  const cached = sessionCache.get(token);
  if (cached && cached.cacheExp > Date.now() && cached.sessionExp > Date.now()) return cached.user;
  try {
    const r = await pool.query(
      'SELECT s.email, s.role, u.name FROM sessions s JOIN users u ON u.email=s.email WHERE s.token=$1 AND s.expires_at > now()',
      [token]);
    return r.rows.length ? { email: r.rows[0].email, role: r.rows[0].role, name: r.rows[0].name } : null;
  } catch (e) { return null; }
}

// ---- Read-only DB tools the assistant may call (role-scoped) ----
// Declarations advertised to Gemini (function calling).
const ASSISTANT_TOOLS = [
  {
    name: 'lookup_client',
    description: 'Search the firm\'s clients by name, email or client ID. Staff only. Returns matching clients with their id, name, email and phone.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Name, email or client ID fragment to search for.' } },
      required: ['query'],
    },
  },
  {
    name: 'get_client_jobs',
    description: 'List jobs for a client (by client ID like CL-0001, or by name). Staff only. Returns each job\'s id, type, financial year, stage label, and how many requested documents are still outstanding.',
    parameters: {
      type: 'object',
      properties: { client: { type: 'string', description: 'Client ID or name.' } },
      required: ['client'],
    },
  },
  {
    name: 'get_job_status',
    description: 'Get the status of one job by its job ID (e.g. JB-0001). Returns stage, client, assigned staff, number of documents uploaded, and outstanding document requests (i.e. whether the client has submitted their files).',
    parameters: {
      type: 'object',
      properties: { jobId: { type: 'string', description: 'Job ID such as JB-0001.' } },
      required: ['jobId'],
    },
  },
  {
    name: 'my_jobs',
    description: 'For a signed-in CLIENT: list the client\'s own jobs with plain-language status, the current progress step (1-6) and percent complete, and whether documents are still needed. Use this when a client asks about their own jobs, documents, or the progress/status of their work.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'lookup_user',
    description: 'Search LOGIN ACCOUNTS (users) by email or name. Staff only. Returns each account\'s email, name, role (client/reception/accountant/supervisor/administrator) and whether it is active. Use this to answer questions about a person\'s role, permissions, or whether an account exists.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Email or name fragment to search for.' } },
      required: ['query'],
    },
  },
  {
    name: 'universal_search',
    description: 'Search EVERYTHING at once for a term: login accounts (users), clients, entities, and jobs. Staff only. Use this when you are unsure which record type the user means, or when a client lookup finds nothing (the record may be a user account, entity, or job instead).',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Any name, email, ID or keyword to search across all records.' } },
      required: ['query'],
    },
  },
];
const STAFF_ROLES = ['administrator', 'supervisor', 'accountant', 'reception'];

// Executes a tool call, enforcing role permissions. Returns a plain object result.
async function runAssistantTool(name, args, user) {
  const role = user && user.role;
  const isStaff = STAFF_ROLES.indexOf(role) !== -1;
  args = args || {};
  try {
    if (name === 'lookup_client') {
      if (!isStaff) return { error: 'Only firm staff can look up clients.' };
      const q = String(args.query || '').trim().toLowerCase();
      if (!q) return { error: 'query required' };
      const r = await pool.query(
        'SELECT id, name, email, phone FROM clients WHERE lower(name) LIKE $1 OR lower(email) LIKE $1 OR lower(id) LIKE $1 ORDER BY id LIMIT 10',
        ['%' + q + '%']);
      return { count: r.rows.length, clients: r.rows };
    }
    if (name === 'get_client_jobs') {
      if (!isStaff) return { error: 'Only firm staff can view client jobs.' };
      const key = String(args.client || '').trim().toLowerCase();
      if (!key) return { error: 'client required' };
      const cr = await pool.query(
        'SELECT id, name FROM clients WHERE lower(id)=$1 OR lower(name) LIKE $2 ORDER BY id LIMIT 1',
        [key, '%' + key + '%']);
      if (!cr.rows.length) return { found: false, message: 'No client matched "' + args.client + '".' };
      const clientId = cr.rows[0].id;
      let sql =
        `SELECT j.id, j.job_type, j.financial_year, j.stage, j.accountant_email
         FROM jobs j WHERE j.client_id=$1`;
      const params = [clientId];
      if (role === 'accountant') { sql += ' AND lower(j.accountant_email)=$2'; params.push(normAccount(user.email)); }
      sql += ' ORDER BY j.updated_at DESC';
      const jr = await pool.query(sql, params);
      const jobs = [];
      for (const j of jr.rows) {
        const rem = await pool.query("SELECT COUNT(*)::int AS n FROM doc_requests WHERE job_id=$1 AND status='pending'", [j.id]);
        jobs.push({
          jobId: j.id, type: j.job_type, financialYear: j.financial_year,
          stage: (wf.STAGE_MAP[j.stage] || {}).internalLabel || j.stage,
          outstandingDocuments: rem.rows[0].n,
        });
      }
      return { client: cr.rows[0], jobCount: jobs.length, jobs: jobs };
    }
    if (name === 'get_job_status') {
      if (!isStaff) return { error: 'Only firm staff can view job status here.' };
      const jobId = String(args.jobId || '').trim().toUpperCase();
      if (!jobId) return { error: 'jobId required' };
      const jr = await pool.query(
        `SELECT j.*, c.name AS client_name, ua.name AS accountant_name, us.name AS supervisor_name
         FROM jobs j JOIN clients c ON c.id=j.client_id
         LEFT JOIN users ua ON lower(ua.email)=lower(j.accountant_email)
         LEFT JOIN users us ON lower(us.email)=lower(j.supervisor_email)
         WHERE upper(j.id)=$1`, [jobId]);
      if (!jr.rows.length) return { found: false, message: 'No job matched "' + args.jobId + '".' };
      const j = jr.rows[0];
      if (role === 'accountant' && normAccount(j.accountant_email) !== normAccount(user.email)) {
        return { error: 'You can only view jobs assigned to you.' };
      }
      const [docs, reqs] = await Promise.all([
        pool.query('SELECT COUNT(*)::int AS n FROM documents WHERE job_id=$1', [j.id]),
        pool.query("SELECT COUNT(*)::int AS n FROM doc_requests WHERE job_id=$1 AND status='pending'", [j.id]),
      ]);
      const outstanding = reqs.rows[0].n;
      return {
        jobId: j.id, client: j.client_name, type: j.job_type, financialYear: j.financial_year,
        stage: (wf.STAGE_MAP[j.stage] || {}).internalLabel || j.stage,
        accountant: j.accountant_name, supervisor: j.supervisor_name,
        documentsUploaded: docs.rows[0].n,
        outstandingRequests: outstanding,
        clientHasSubmittedAll: outstanding === 0,
      };
    }
    if (name === 'my_jobs') {
      if (role !== 'client') return { error: 'This tool is only for signed-in clients.' };
      const cr = await pool.query('SELECT id FROM clients WHERE lower(email)=$1', [normAccount(user.email)]);
      if (!cr.rows.length) return { jobCount: 0, jobs: [] };
      const clientIds = cr.rows.map((r) => r.id);
      const jr = await pool.query(
        'SELECT id, job_type, financial_year, stage, on_hold FROM jobs WHERE client_id = ANY($1) ORDER BY updated_at DESC',
        [clientIds]);
      const jobs = [];
      for (const j of jr.rows) {
        const view = wf.clientView(j);
        const rem = await pool.query("SELECT COUNT(*)::int AS n FROM doc_requests WHERE job_id=$1 AND status='pending'", [j.id]);
        jobs.push({
          jobId: j.id, type: j.job_type, financialYear: j.financial_year,
          status: view.clientStatus, documentsStillNeeded: rem.rows[0].n,
          progressStep: view.clientStep, progressStepLabel: view.clientStepLabel,
          totalSteps: Array.isArray(view.clientSteps) ? view.clientSteps.length : 6,
          progressPercent: view.progressPct,
        });
      }
      return { jobCount: jobs.length, jobs: jobs };
    }
    if (name === 'lookup_user') {
      if (!isStaff) return { error: 'Only firm staff can look up user accounts.' };
      const q = String(args.query || '').trim().toLowerCase();
      if (!q) return { error: 'query required' };
      const r = await pool.query(
        'SELECT email, name, role, active FROM users WHERE lower(email) LIKE $1 OR lower(name) LIKE $1 ORDER BY email LIMIT 10',
        ['%' + q + '%']);
      return { count: r.rows.length, users: r.rows };
    }
    if (name === 'universal_search') {
      if (!isStaff) return { error: 'Only firm staff can search records.' };
      const q = String(args.query || '').trim().toLowerCase();
      if (!q) return { error: 'query required' };
      const like = '%' + q + '%';
      const [users, clients, entities, jobs] = await Promise.all([
        pool.query('SELECT email, name, role, active FROM users WHERE lower(email) LIKE $1 OR lower(name) LIKE $1 ORDER BY email LIMIT 8', [like]),
        pool.query('SELECT id, name, email, phone FROM clients WHERE lower(name) LIKE $1 OR lower(email) LIKE $1 OR lower(id) LIKE $1 ORDER BY id LIMIT 8', [like]),
        pool.query('SELECT id, client_id, entity_name, entity_type, abn FROM entities WHERE lower(entity_name) LIKE $1 OR lower(id) LIKE $1 OR lower(abn) LIKE $1 ORDER BY id LIMIT 8', [like]),
        pool.query(
          `SELECT j.id, j.job_type, j.financial_year, j.stage, c.name AS client_name
           FROM jobs j JOIN clients c ON c.id=j.client_id
           WHERE lower(j.id) LIKE $1 OR lower(c.name) LIKE $1 OR lower(j.job_type) LIKE $1
           ORDER BY j.updated_at DESC LIMIT 8`, [like]),
      ]);
      const jobRows = jobs.rows.map((j) => ({
        jobId: j.id, type: j.job_type, financialYear: j.financial_year,
        stage: (wf.STAGE_MAP[j.stage] || {}).internalLabel || j.stage, client: j.client_name,
      }));
      return {
        query: args.query,
        totals: { users: users.rows.length, clients: clients.rows.length, entities: entities.rows.length, jobs: jobRows.length },
        users: users.rows, clients: clients.rows, entities: entities.rows, jobs: jobRows,
      };
    }
    return { error: 'unknown tool' };
  } catch (e) {
    console.error('[assistant tool]', name, e && e.message);
    return { error: 'lookup failed' };
  }
}

app.post('/api/assistant', async (req, res) => {

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'AI assistant is not configured yet.' });

  const question = String((req.body && req.body.question) || '').trim();
  if (!question) return res.status(400).json({ error: 'question required' });
  if (question.length > 2000) return res.status(400).json({ error: 'question too long' });

  const rlKey = (req.headers.authorization || '') || req.ip || 'anon';
  if (aiRateLimited(rlKey)) return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });

  const user = await softUser(req);
  const ctx = (req.body && req.body.context) || {};
  const page = String((req.body && req.body.page) || ctx.path || '').slice(0, 120);
  const history = Array.isArray(req.body && req.body.history) ? req.body.history.slice(-8) : [];

  const contextLines = [
    'CURRENT USER ROLE: ' + (user ? user.role : 'guest (not signed in)'),
    'CURRENT PAGE PATH: ' + (page || 'unknown'),
    ctx.title ? ('CURRENT SECTION/HEADING: ' + String(ctx.title).slice(0, 160)) : '',
    ctx.tab ? ('ACTIVE TAB/STEP: ' + String(ctx.tab).slice(0, 160)) : '',
    ctx.modal ? ('OPEN DIALOG: ' + String(ctx.modal).slice(0, 160)) : '',
  ].filter(Boolean).join('\n');

  const systemPrompt =
    'You are Enzo, the built-in AI assistant for the Successwa / Elite Client Hub web app. ' +
    'When greeting or introducing yourself, say you are Enzo, the app\'s AI assistant. ' +
    'You help users in two ways: (1) explain features and guide them through the exact step ' +
    'they are on, and (2) answer questions about REAL data by calling the provided tools ' +
    '(e.g. whether a client exists, a client\'s jobs, a job\'s status, or whether a client has ' +
    'submitted their documents). Prefer calling a tool over guessing whenever the user asks about ' +
    'specific clients, jobs or document status. If a tool returns an error or no match, say so plainly. ' +
    'Never claim you lack database access — use the tools. Respect permissions: the tools already ' +
    'enforce what this user is allowed to see; do not try to reveal other clients\' data to a client user. ' +
    'Use the app handbook as your source of truth about how the app works; do not invent features. ' +
    'For tax questions give general educational guidance only, not personal financial or legal advice. ' +
    'STAY ON TOPIC: you only help with this app (Successwa / Elite Client Hub), its features, the firm\'s ' +
    'clients/jobs/documents, and general Australian tax record-keeping. If the user asks anything unrelated ' +
    '(e.g. general trivia, coding, other companies, jokes, personal chit-chat, current events), politely ' +
    'decline in one short sentence and steer them back to what you can help with in the app. Do not answer ' +
    'off-topic requests even if asked repeatedly. ' +
    'Be concise. Always reply in ENGLISH, regardless of the language of the question.\n\n' +
    '=== APP HANDBOOK ===\n' + APP_KB + '\n' +
    '=== LIVE CONTEXT (where the user currently is) ===\n' + contextLines;

  // Build OpenAI-style messages: system + prior turns + the new question.
  const messages = [{ role: 'system', content: systemPrompt }];
  history.forEach((m) => {
    if (!m || !m.text) return;
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.text).slice(0, 2000) });
  });
  messages.push({ role: 'user', content: question });

  // OpenAI-style tool declarations (wrap our shared ASSISTANT_TOOLS).
  const tools = ASSISTANT_TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  async function callModel() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    const gr = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'HTTP-Referer': 'https://demo.kaiizen.ai',
        'X-Title': 'Successwa Client Hub',
      },
      body: JSON.stringify({ model: AI_MODEL, messages: messages, tools: tools, temperature: 0.3, max_tokens: 900 }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    if (!gr.ok) {
      const body = await gr.text().catch(() => '');
      console.error('[assistant] OpenRouter HTTP', gr.status, body.slice(0, 400));
      throw new Error('openrouter_http_' + gr.status);
    }
    return gr.json();
  }

  try {
    // Function-calling loop: let the model call tools (max 4 rounds), then answer.
    for (let round = 0; round < 4; round++) {
      const data = await callModel();
      const msg = (((data.choices || [])[0] || {}).message) || {};
      const toolCalls = msg.tool_calls || [];

      if (toolCalls.length) {
        // Record the assistant's tool-call turn, then append each tool result.
        messages.push(msg);
        for (const tc of toolCalls) {
          let args = {};
          try { args = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch (e) {}
          const result = await runAssistantTool(tc.function && tc.function.name, args, user);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
        }
        continue; // ask the model again with tool outputs
      }

      const answer = (msg.content || '').trim();
      if (answer) return res.json({ ok: true, answer });
      break;
    }
    return res.status(502).json({ error: 'No answer returned. Please rephrase and try again.' });
  } catch (e) {
    console.error('[assistant]', e && e.message);
    res.status(502).json({ error: 'AI request failed. Please try again.' });
  }
});


// Multer / generic error handler
app.use(function (err, req, res, next) {

  if (err) return res.status(400).json({ error: err.message });
  next();
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log('Successwa + Elite Client Hub server running on http://localhost:' + PORT));

// ================= BACKGROUND SCHEDULER =================
// Runs reminders + recurring-job generation on an interval. Cluster-safe: every
// individual send/generation is guarded by a DB lock so it happens exactly once
// even though PM2 runs several worker processes.
async function runScheduler() {
  try {
    const rem = await reminders.runReminders(pool, { notifyBg });
    const rec = await recurring.generateDueJobs(pool, { notifyBg });
    const parts = [];
    if (rem && !rem.skipped) Object.keys(rem).forEach((k) => { if (rem[k]) parts.push(k + '=' + rem[k]); });
    if (rec && rec.created) parts.push('recurring=' + rec.created);
    if (parts.length) console.log('[scheduler]', parts.join(' '));
  } catch (e) { console.error('[scheduler]', (e && e.message) || e); }
}
// First pass shortly after boot, then every 30 minutes.
setTimeout(runScheduler, 60 * 1000);
setInterval(runScheduler, 30 * 60 * 1000);

// Admin: run the reminder sweep immediately (handy for testing/demos).
app.post('/api/admin/run-reminders', requireAuth, requireRole('administrator'), async (req, res) => {
  try {
    const rem = await reminders.runReminders(pool, { notifyBg }, { force: true });
    const rec = await recurring.generateDueJobs(pool, { notifyBg });
    await audit(pool, req.user.email, 'scheduler.run', 'system', null, { rem, rec });
    res.json({ ok: true, reminders: rem, recurring: rec });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/*
 * Syraxx client portal — end-to-end API test harness.
 * Runs against the live dev server. Uses only global fetch (Node 18+).
 * Usage:  node qa/e2e_test.js
 * Routes/handlers were read from server.js before writing these assertions.
 */
'use strict';

const BASE = process.env.BASE || 'http://127.0.0.1:8000';

// ---- tiny test framework -------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];

function rec(ok, name, detail) {
  if (ok) {
    passed++;
    console.log('PASS  ' + name);
  } else {
    failed++;
    console.log('FAIL  ' + name + (detail ? '  -> ' + detail : ''));
    failures.push({ name, detail });
  }
}

function check(name, cond, detail) {
  rec(!!cond, name, cond ? '' : detail);
  return !!cond;
}

async function api(method, path, { token, body, raw } = {}) {
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res, text, json;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    text = await res.text();
    try { json = JSON.parse(text); } catch (e) { json = null; }
  } catch (e) {
    return { networkError: e.message, status: 0, json: null, text: '' };
  }
  return { status: res.status, json, text: raw ? text : undefined, ok: res.ok };
}

function fmt(r) {
  return 'HTTP ' + r.status + ' body=' + (r.text || JSON.stringify(r.json) || '').slice(0, 300);
}

// ---- credentials ---------------------------------------------------------
const STAFF_ACCOUNTS = [
  { key: 'admin', email: 'admin@successwa.com', password: 'admin123', role: 'administrator' },
  { key: 'supervisor', email: 'supervisor@successwa.com', password: 'super123', role: 'supervisor' },
  { key: 'accountant', email: 'accountant@successwa.com', password: 'acct123', role: 'accountant' },
  { key: 'reception', email: 'reception@successwa.com', password: 'recep123', role: 'reception' },
  { key: 'offshore1', email: 'offshore1@successwa.com', password: 'offshore123', role: 'accountant' },
];

const tokens = {};      // key -> token
const roles = {};       // key -> role reported by login

async function main() {
  console.log('=== Syraxx portal E2E API test ===');
  console.log('Target: ' + BASE);
  console.log('Time:   ' + new Date().toISOString());
  console.log('');

  // ===================================================================
  // 0. Server reachability
  // ===================================================================
  const ping = await api('GET', '/api/doc-categories', {});
  if (ping.networkError) {
    console.error('ENVIRONMENT FAILURE: server unreachable at ' + BASE + ' (' + ping.networkError + ')');
    process.exit(2);
  }

  // ===================================================================
  // 1. AUTH — all staff roles
  // ===================================================================
  console.log('\n--- 1. Authentication (staff roles) ---');
  for (const acc of STAFF_ACCOUNTS) {
    const r = await api('POST', '/api/login', { body: { email: acc.email, password: acc.password } });
    const gotToken = r.json && typeof r.json.token === 'string' && r.json.token.length > 0;
    check('login ' + acc.key + ' returns token', r.status === 200 && gotToken, fmt(r));
    if (gotToken) {
      tokens[acc.key] = r.json.token;
      roles[acc.key] = r.json.role;
      check('login ' + acc.key + ' role == ' + acc.role, r.json.role === acc.role,
        'expected ' + acc.role + ' got ' + r.json.role);
    }
  }

  // Wrong password rejected
  {
    const r = await api('POST', '/api/login', { body: { email: 'admin@successwa.com', password: 'wrongpw' } });
    check('login wrong password -> 401', r.status === 401, fmt(r));
  }
  // Missing creds rejected
  {
    const r = await api('POST', '/api/login', { body: { email: '', password: '' } });
    check('login empty creds -> 400', r.status === 400, fmt(r));
  }
  // Seed client with MFA returns mfaRequired (cannot complete via API)
  {
    const r = await api('POST', '/api/login', { body: { email: 'demo@successwa.com', password: 'demo123' } });
    check('login demo client -> mfaRequired', r.status === 200 && r.json && r.json.mfaRequired === true, fmt(r));
  }
  // No token -> 401 on protected route
  {
    const r = await api('GET', '/api/clients', {});
    check('protected route without token -> 401', r.status === 401, fmt(r));
  }
  // Bogus token -> 401
  {
    const r = await api('GET', '/api/clients', { token: 'not-a-real-token' });
    check('protected route with bogus token -> 401', r.status === 401, fmt(r));
  }

  const admin = tokens.admin;
  if (!admin) {
    console.error('CRITICAL: admin login failed; cannot continue staff tests.');
  }

  // ===================================================================
  // 2. CLIENT REGISTRATION + ONBOARDING FLOW
  // ===================================================================
  console.log('\n--- 2. Client registration + onboarding ---');
  const ts = Date.now();
  const clientEmail = 'qa+' + ts + '@example.com';
  const clientPass = 'demo1234';
  let clientToken = null;

  {
    const r = await api('POST', '/api/register', { body: { email: clientEmail, name: 'QA Tester', password: clientPass } });
    const gotToken = r.json && typeof r.json.token === 'string';
    check('register new client returns token', r.status === 200 && gotToken, fmt(r));
    check('register new client role == client', r.json && r.json.role === 'client', fmt(r));
    if (gotToken) clientToken = r.json.token;
  }
  // register short password rejected
  {
    const r = await api('POST', '/api/register', { body: { email: 'qa2+' + ts + '@example.com', name: 'X', password: '123' } });
    check('register short password -> 400', r.status === 400, fmt(r));
  }
  // register duplicate email rejected
  {
    const r = await api('POST', '/api/register', { body: { email: clientEmail, name: 'Dup', password: clientPass } });
    check('register duplicate email -> 409', r.status === 409, fmt(r));
  }

  // status should show incomplete profile initially
  {
    const r = await api('GET', '/api/portal/status', { token: clientToken });
    check('portal/status reachable as client', r.status === 200 && r.json && r.json.ok, fmt(r));
    check('portal/status profileComplete == false (fresh client)', r.json && r.json.profileComplete === false, fmt(r));
    check('portal/status mfaEnabled == false (fresh client)', r.json && r.json.mfaEnabled === false, fmt(r));
  }

  // profile/complete validation: reject each missing field with an English error
  const completeBase = {
    name: 'QA Tester', dob: '1990-05-15', mobile: '0400000000',
    address: '1 Test St, Perth WA', preferredContact: 'email',
  };
  async function expectCompleteReject(mutate, label, expectSnippet) {
    const body = Object.assign({}, completeBase);
    mutate(body);
    const r = await api('POST', '/api/portal/profile/complete', { token: clientToken, body });
    const msg = (r.json && r.json.error) || '';
    const englishOk = /[A-Za-z]/.test(msg) && msg.length > 4;
    check('profile/complete rejects ' + label + ' -> 400', r.status === 400, fmt(r));
    check('profile/complete ' + label + ' error is English text', englishOk && (!expectSnippet || msg.includes(expectSnippet)),
      'error="' + msg + '"');
  }
  await expectCompleteReject((b) => { b.name = ''; }, 'missing name', 'full name');
  await expectCompleteReject((b) => { b.dob = ''; }, 'missing dob', 'date of birth');
  await expectCompleteReject((b) => { b.dob = '15-05-1990'; }, 'bad dob format', 'date of birth');
  await expectCompleteReject((b) => { b.mobile = ''; }, 'missing mobile', 'mobile');
  await expectCompleteReject((b) => { b.address = ''; }, 'missing address', 'address');
  await expectCompleteReject((b) => { b.preferredContact = 'carrier-pigeon'; }, 'bad preferredContact', 'preferred contact');

  // profile/complete success
  {
    const r = await api('POST', '/api/portal/profile/complete', { token: clientToken, body: completeBase });
    check('profile/complete success', r.status === 200 && r.json && r.json.ok, fmt(r));
  }
  // status now complete
  {
    const r = await api('GET', '/api/portal/status', { token: clientToken });
    check('portal/status profileComplete == true after completion', r.json && r.json.profileComplete === true, fmt(r));
  }

  // ===================================================================
  // 3. PROFILE SAVE UPSERT (no 404)
  // ===================================================================
  console.log('\n--- 3. Profile save/upsert ---');
  {
    const r = await api('GET', '/api/portal/profile', { token: clientToken });
    check('GET portal/profile 200', r.status === 200 && r.json && r.json.profile, fmt(r));
    check('GET portal/profile reflects saved dob', r.json && r.json.profile && r.json.profile.dob === '1990-05-15', fmt(r));
  }
  {
    const r = await api('POST', '/api/portal/profile', {
      token: clientToken,
      body: { name: 'QA Tester Updated', address: '2 New Rd, Perth', mobile: '0411111111', preferredContact: 'mobile' },
    });
    check('POST portal/profile upsert returns 200 (no 404)', r.status === 200 && r.json && r.json.ok, fmt(r));
  }
  {
    const r = await api('GET', '/api/portal/profile', { token: clientToken });
    check('profile update persisted (mobile)', r.json && r.json.profile && r.json.profile.mobile === '0411111111', fmt(r));
    check('profile update persisted (preferredContact)', r.json && r.json.profile && r.json.profile.preferredContact === 'mobile', fmt(r));
  }

  // ===================================================================
  // 4. RBAC — negative + positive
  // ===================================================================
  console.log('\n--- 4. Role-based access control ---');
  // Client token rejected on staff-only routes
  {
    const r = await api('GET', '/api/clients', { token: clientToken });
    check('client token on GET /api/clients -> 403', r.status === 403, fmt(r));
  }
  {
    const r = await api('GET', '/api/jobs', { token: clientToken });
    check('client token on GET /api/jobs -> 403', r.status === 403, fmt(r));
  }
  {
    const r = await api('GET', '/api/admin/users', { token: clientToken });
    check('client token on GET /api/admin/users -> 403', r.status === 403, fmt(r));
  }
  // Staff token rejected on client-only routes
  {
    const r = await api('GET', '/api/portal/status', { token: admin });
    check('admin token on GET /api/portal/status -> 403', r.status === 403, fmt(r));
  }
  {
    const r = await api('GET', '/api/portal/summary', { token: admin });
    check('admin token on GET /api/portal/summary -> 403', r.status === 403, fmt(r));
  }
  // Non-admin staff rejected on admin-only route
  {
    const r = await api('GET', '/api/admin/users', { token: tokens.accountant });
    check('accountant token on GET /api/admin/users -> 403', r.status === 403, fmt(r));
  }
  // Positive: admin can list users
  {
    const r = await api('GET', '/api/admin/users', { token: admin });
    check('admin can GET /api/admin/users', r.status === 200 && r.json && r.json.ok, fmt(r));
  }
  // Positive: supervisor-only review queue
  {
    const r = await api('GET', '/api/review/queue', { token: tokens.supervisor });
    check('supervisor can GET /api/review/queue', r.status === 200, fmt(r));
    const r2 = await api('GET', '/api/review/queue', { token: tokens.accountant });
    check('accountant on /api/review/queue -> 403', r2.status === 403, fmt(r2));
  }
  // offshore1 (accountant role) can access staff jobs list but is scoped
  {
    const r = await api('GET', '/api/jobs', { token: tokens.offshore1 });
    check('offshore1 (accountant) can GET /api/jobs (200)', r.status === 200 && r.json && r.json.ok, fmt(r));
  }

  // ===================================================================
  // 5. STAFF CRUD — create client, create/list jobs, request documents
  // ===================================================================
  console.log('\n--- 5. Staff CRUD (clients / jobs / doc-requests) ---');
  let newClientId = null;
  const staffClientEmail = 'qaclient+' + ts + '@example.com';
  {
    const r = await api('POST', '/api/clients', { token: admin, body: { name: 'QA CRUD Client', email: staffClientEmail, phone: '0400123123' } });
    check('staff POST /api/clients creates client', r.status === 200 && r.json && r.json.id, fmt(r));
    if (r.json) newClientId = r.json.id;
  }
  // create client name-required validation
  {
    const r = await api('POST', '/api/clients', { token: admin, body: { name: '', email: 'x' + ts + '@e.com' } });
    check('staff POST /api/clients missing name -> 400', r.status === 400, fmt(r));
  }
  // list clients and find the one we created
  {
    const r = await api('GET', '/api/clients?q=' + encodeURIComponent(staffClientEmail), { token: admin });
    const found = r.json && r.json.clients && r.json.clients.some((c) => c.id === newClientId);
    check('staff GET /api/clients lists created client', r.status === 200 && found, fmt(r));
  }
  // create a job for the new client
  let newJobId = null;
  {
    const r = await api('POST', '/api/jobs', {
      token: admin,
      body: { clientId: newClientId, jobType: 'Individual Tax Return', financialYear: '2025-26', priority: 'normal' },
    });
    check('staff POST /api/jobs creates job', r.status === 200 && r.json && r.json.id, fmt(r));
    if (r.json) newJobId = r.json.id;
  }
  // job with missing clientId -> 400
  {
    const r = await api('POST', '/api/jobs', { token: admin, body: { jobType: 'X' } });
    check('staff POST /api/jobs missing clientId -> 400', r.status === 400, fmt(r));
  }
  // job with nonexistent client -> 404
  {
    const r = await api('POST', '/api/jobs', { token: admin, body: { clientId: 'CL-DOESNOTEXIST' } });
    check('staff POST /api/jobs nonexistent client -> 404', r.status === 404, fmt(r));
  }
  // list jobs & find ours
  {
    const r = await api('GET', '/api/jobs?clientId=' + encodeURIComponent(newClientId), { token: admin });
    const found = r.json && r.json.jobs && r.json.jobs.some((j) => j.id === newJobId);
    check('staff GET /api/jobs lists created job', r.status === 200 && found, fmt(r));
  }
  // get job detail
  {
    const r = await api('GET', '/api/jobs/' + newJobId, { token: admin });
    check('staff GET /api/jobs/:id detail 200', r.status === 200 && r.json && r.json.job, fmt(r));
    check('job detail includes checklist seeded from template', r.json && Array.isArray(r.json.checklist), fmt(r));
  }
  // request documents on the job
  let docReqOk = false;
  {
    const r = await api('POST', '/api/doc-requests', {
      token: admin,
      body: { jobId: newJobId, description: 'Please upload your PAYG summary', category: 'income' },
    });
    docReqOk = r.status === 200 && r.json && r.json.ok;
    check('staff POST /api/doc-requests creates request', docReqOk, fmt(r));
  }
  // doc-request missing fields -> 400
  {
    const r = await api('POST', '/api/doc-requests', { token: admin, body: { jobId: newJobId } });
    check('staff POST /api/doc-requests missing description -> 400', r.status === 400, fmt(r));
  }
  // verify the doc-request shows up in job detail
  {
    const r = await api('GET', '/api/jobs/' + newJobId, { token: admin });
    const has = r.json && r.json.docRequests && r.json.docRequests.some((d) => /PAYG summary/.test(d.description || ''));
    check('doc-request appears in job detail', !!has, fmt(r));
  }

  // ===================================================================
  // 6. MESSAGING round-trip (staff <-> client)
  // ===================================================================
  console.log('\n--- 6. Two-way messaging ---');
  // Find the client_id for our registered client (via staff clients search)
  let regClientId = null;
  {
    const r = await api('GET', '/api/clients?q=' + encodeURIComponent(clientEmail), { token: admin });
    const c = r.json && r.json.clients && r.json.clients.find((x) => (x.email || '').toLowerCase() === clientEmail);
    if (c) regClientId = c.id;
    check('staff can locate registered client id for messaging', !!regClientId, fmt(r));
  }
  const staffMsgBody = 'Hello from the firm ' + ts;
  const clientMsgBody = 'Hello from the client ' + ts;
  if (regClientId) {
    // Staff -> client
    {
      const r = await api('POST', '/api/clients/' + regClientId + '/messages', { token: admin, body: { body: staffMsgBody } });
      check('staff sends message to client', r.status === 200 && r.json && r.json.ok, fmt(r));
    }
    // Client sees it
    {
      const r = await api('GET', '/api/portal/messages', { token: clientToken });
      const seen = r.json && r.json.messages && r.json.messages.some((m) => m.body === staffMsgBody && m.direction === 'out');
      check('client sees staff message (direction out)', !!seen, fmt(r));
    }
    // Client replies
    {
      const r = await api('POST', '/api/portal/messages', { token: clientToken, body: { body: clientMsgBody } });
      check('client sends reply', r.status === 200 && r.json && r.json.ok, fmt(r));
    }
    // Staff sees client reply
    {
      const r = await api('GET', '/api/clients/' + regClientId + '/messages', { token: admin });
      const seen = r.json && r.json.messages && r.json.messages.some((m) => m.body === clientMsgBody && m.direction === 'in');
      check('staff sees client reply (direction in)', !!seen, fmt(r));
    }
    // empty message rejected (client)
    {
      const r = await api('POST', '/api/portal/messages', { token: clientToken, body: { body: '   ' } });
      check('client empty message -> 400', r.status === 400, fmt(r));
    }
  }

  // ===================================================================
  // 7. APPOINTMENTS — read-only (do NOT create real Setmore bookings)
  // ===================================================================
  console.log('\n--- 7. Appointments (read-only) ---');
  let apptConfigured = false;
  {
    const r = await api('GET', '/api/appointments/services', { token: clientToken });
    check('GET /api/appointments/services 200', r.status === 200 && r.json && r.json.ok, fmt(r));
    if (r.json) apptConfigured = !!r.json.configured;
    check('appointments/services returns services + staff arrays', r.json && Array.isArray(r.json.services) && Array.isArray(r.json.staff), fmt(r));
  }
  // services also available to staff
  {
    const r = await api('GET', '/api/appointments/services', { token: admin });
    check('appointments/services available to staff too', r.status === 200 && r.json && r.json.ok, fmt(r));
  }
  // slots validation (bad date) -> 400  (only meaningful when Setmore configured)
  {
    const r = await api('GET', '/api/appointments/slots?staffKey=x&serviceKey=y&date=notadate', { token: clientToken });
    if (apptConfigured) {
      check('appointments/slots bad date -> 400 (configured)', r.status === 400, fmt(r));
    } else {
      check('appointments/slots returns gracefully when Setmore not configured', r.status === 200, fmt(r) + ' (Setmore not configured)');
    }
  }
  // client's own appointments list
  {
    const r = await api('GET', '/api/portal/appointments', { token: clientToken });
    check('GET /api/portal/appointments returns upcoming+past', r.status === 200 && r.json && Array.isArray(r.json.upcoming) && Array.isArray(r.json.past), fmt(r));
  }
  console.log('NOTE: appointment booking (POST /api/portal/appointments) intentionally NOT exercised to avoid creating a real Setmore booking.');

  // ===================================================================
  // 8. SECURITY — client endpoints must not leak staff/internal data
  // ===================================================================
  console.log('\n--- 8. Security / data-leak checks ---');
  const sensitiveWords = ['tfn', 'bank', 'offshore', 'accountant_email', 'supervisor_email', 'internal', 'pass_hash', 'mfa_secret'];
  function leakScan(label, obj) {
    const s = JSON.stringify(obj || {}).toLowerCase();
    const hits = sensitiveWords.filter((w) => s.includes(w));
    check(label + ' does not leak sensitive fields', hits.length === 0, 'leaked: ' + hits.join(', '));
  }
  {
    const r = await api('GET', '/api/portal/summary', { token: clientToken });
    leakScan('portal/summary', r.json);
    // Explicitly: staff names/emails should not be exposed to client
    const s = JSON.stringify(r.json || {}).toLowerCase();
    check('portal/summary does not expose staff emails (@successwa.com)', !s.includes('@successwa.com'), 'body contained @successwa.com');
  }
  {
    const r = await api('GET', '/api/portal/profile', { token: clientToken });
    leakScan('portal/profile', r.json);
  }
  {
    const r = await api('GET', '/api/portal/messages', { token: clientToken });
    // client messages payload should not include sender_name / sender_email of staff
    const s = JSON.stringify(r.json || {}).toLowerCase();
    check('portal/messages does not expose sender_email/sender_name', !s.includes('sender_email') && !s.includes('sender_name'), fmt(r));
  }
  {
    const r = await api('GET', '/api/portal/jobs', { token: clientToken });
    leakScan('portal/jobs', r.json);
    const s = JSON.stringify(r.json || {}).toLowerCase();
    check('portal/jobs does not expose staff emails', !s.includes('@successwa.com'), 'body contained @successwa.com');
  }

  // ===================================================================
  // 9. SESSION / LOGOUT
  // ===================================================================
  console.log('\n--- 9. Session lifecycle ---');
  {
    const r = await api('GET', '/api/me', { token: clientToken });
    check('GET /api/me works with valid token', r.status === 200 && r.json && r.json.user, fmt(r));
  }

  // ===================================================================
  // SUMMARY
  // ===================================================================
  console.log('\n=========================================');
  console.log('SUMMARY: ' + passed + ' passed / ' + failed + ' failed (total ' + (passed + failed) + ')');
  if (failures.length) {
    console.log('\nFAILURES:');
    failures.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f.name + (f.detail ? '  -> ' + f.detail : '')));
  }
  console.log('=========================================');

  // machine-readable block for the report generator
  console.log('\n<<<JSON_RESULT>>>');
  console.log(JSON.stringify({ passed, failed, total: passed + failed, failures, apptConfigured, clientEmail }, null, 2));
  console.log('<<<END_JSON_RESULT>>>');

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('HARNESS CRASH: ' + (e && e.stack || e));
  process.exit(3);
});

// Gaps 1 & 6 test: appointment cancel (local) + ownership RBAC + sign consent validation.
// Uses a locally-inserted appointment with NO setmore_appt_key so Setmore is never called.
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const BASE = 'http://127.0.0.1:8000';
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m); } }
async function login(email, password) {
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const j = await r.json(); return j.token || null;
}
async function api(path, token, opts = {}) {
  const headers = {}; if (token) headers['Authorization'] = 'Bearer ' + token;
  if (opts.body) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j };
}

(async () => {
  // Register a fresh client and make sure a clients row exists for them.
  const cemail = 'qa+appt' + Date.now() + '@example.com';
  const reg = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: cemail, password: 'pass1234', name: 'QA Appt' }) });
  const regJson = await reg.json();
  const token = regJson.token;
  ok(token, 'client registered + token');

  // Find (or create) the client row id for this email.
  let cr = await pool.query('SELECT id FROM clients WHERE lower(email)=lower($1) LIMIT 1', [cemail]);
  if (!cr.rows.length) { await pool.query("INSERT INTO clients (id,name,email) VALUES ('CL-QA'||floor(random()*100000)::int, 'QA Appt', $1)", [cemail]); cr = await pool.query('SELECT id FROM clients WHERE lower(email)=lower($1) LIMIT 1', [cemail]); }
  const clientId = cr.rows[0].id;
  ok(clientId, 'client row id = ' + clientId);

  // Insert a future local appointment WITHOUT a setmore key (so cancel won't call Setmore).
  const future = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
  const ins = await pool.query(
    "INSERT INTO appointments (client_id, service_name, staff_name, start_time, status, booked_by) VALUES ($1,'QA Consult','Adviser A',$2,'booked',$3) RETURNING id",
    [clientId, future, cemail]);
  const apptId = ins.rows[0].id;
  ok(apptId, 'inserted local appt id = ' + apptId);

  // It should appear in the client's list.
  const list = await api('/api/portal/appointments', token);
  ok(list.status === 200 && (list.j.upcoming || []).some(a => a.id === apptId), 'appt appears in upcoming list');
  ok((list.j.upcoming || []).some(a => a.service_key !== undefined), 'list now returns service_key field');

  // Another client must NOT be able to cancel it.
  const otherEmail = 'qa+other' + Date.now() + '@example.com';
  const oReg = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: otherEmail, password: 'pass1234', name: 'QA Other' }) });
  const oToken = (await oReg.json()).token;
  const steal = await api('/api/portal/appointments/' + apptId + '/cancel', oToken, { method: 'POST' });
  ok(steal.status === 404, 'other client cannot cancel (404), got ' + steal.status);

  // Owner cancels successfully.
  const cancel = await api('/api/portal/appointments/' + apptId + '/cancel', token, { method: 'POST' });
  ok(cancel.status === 200 && cancel.j.ok, 'owner cancels appt ok');

  // Status is now cancelled in DB and no longer in upcoming.
  const after = await pool.query('SELECT status FROM appointments WHERE id=$1', [apptId]);
  ok(after.rows[0].status === 'cancelled', 'appt status = cancelled in DB');
  const list2 = await api('/api/portal/appointments', token);
  ok(!(list2.j.upcoming || []).some(a => a.id === apptId), 'cancelled appt gone from upcoming');

  // Cancelling again -> 400 (no longer active).
  const again = await api('/api/portal/appointments/' + apptId + '/cancel', token, { method: 'POST' });
  ok(again.status === 400, 're-cancel returns 400');

  // Sign consent validation: missing consent -> 400; nonexistent job stays 404.
  const signNoConsent = await api('/api/portal/jobs/JB-DOESNOTEXIST/sign', token, { method: 'POST', body: { name: 'Test' } });
  ok(signNoConsent.status === 400, 'sign without consent rejected 400 (got ' + signNoConsent.status + ')');
  const signNoName = await api('/api/portal/jobs/JB-DOESNOTEXIST/sign', token, { method: 'POST', body: { consent: true } });
  ok(signNoName.status === 400, 'sign without name rejected 400 (got ' + signNoName.status + ')');

  // Cleanup.
  await pool.query('DELETE FROM appointments WHERE id=$1', [apptId]);
  await pool.query('DELETE FROM clients WHERE id=$1', [clientId]);
  await pool.query('DELETE FROM users WHERE lower(email) IN (lower($1),lower($2))', [cemail, otherEmail]);
  console.log(JSON.stringify({ passed: pass, failed: fail, total: pass + fail }));
  await pool.end();
})();

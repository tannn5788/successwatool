/*
 * Multi-trigger automation engine — real end-to-end test.
 * Proves rules actually FIRE and produce side effects (job notes, action_required,
 * in-app bell notifications) when real events happen via the API.
 * Cleans up all rows it creates (rules + test client/job/notes/notifications) via pg.
 * Usage: node qa/automation_test.js
 */
'use strict';
require('dotenv').config();
const { Pool } = require('pg');

const BASE = process.env.BASE || 'http://127.0.0.1:8000';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
  return !!cond;
}

async function api(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null; const text = await res.text();
  try { json = JSON.parse(text); } catch (e) {}
  return { status: res.status, json, text };
}
async function login(email, password) {
  const r = await api('POST', '/api/login', { body: { email, password } });
  if (!r.json || !r.json.token) throw new Error('login failed for ' + email + ': ' + r.text);
  return r.json.token;
}

const MARK = 'AUTOTEST-' + Date.now();          // unique marker to find our rows
const JOBTYPE = 'AUTOTESTTYPE-' + Date.now();    // unique job type for trigger_key test
const createdRuleIds = [];
let clientId = null, jobId = null;

async function createRule(admin, body) {
  const r = await api('POST', '/api/admin/automations', { token: admin, body });
  if (r.json && r.json.id) createdRuleIds.push(r.json.id);
  return r;
}

(async () => {
  try {
    const admin = await login('admin@successwa.com', 'admin123');
    const acct = await login('accountant@successwa.com', 'acct123');

    // --- rules ---
    const rNote = await createRule(admin, { triggerType: 'job_created', triggerKey: JOBTYPE,
      action: 'add_note', config: { note: MARK + ' job-created note' } });
    check('create job_created rule', rNote.status === 200 && rNote.json.ok, rNote.text);

    const rBell = await createRule(admin, { triggerType: 'client_created',
      action: 'notify_staff', config: { email: 'accountant@successwa.com', note: MARK + ' new client' } });
    check('create client_created rule', rBell.status === 200 && rBell.json.ok, rBell.text);

    const rFlag = await createRule(admin, { triggerType: 'job_assigned',
      action: 'set_action_required', config: {} });
    check('create job_assigned rule', rFlag.status === 200 && rFlag.json.ok, rFlag.text);

    // negative: job-only action on client_created must be rejected
    const rBad = await api('POST', '/api/admin/automations', { token: admin,
      body: { triggerType: 'client_created', action: 'add_note', config: { note: 'x' } } });
    check('reject job-only action on client_created', rBad.status === 400, rBad.text);

    // negative: bad trigger
    const rBadTrig = await api('POST', '/api/admin/automations', { token: admin,
      body: { triggerType: 'nonsense', action: 'add_note' } });
    check('reject invalid trigger', rBadTrig.status === 400, rBadTrig.text);

    // --- bell baseline for accountant ---
    const before = await api('GET', '/api/my-notifications', { token: acct });
    const beforeCount = (before.json.notifications || []).filter((n) => (n.subject || '').indexOf(MARK) !== -1 || (n.body || '').indexOf(MARK) !== -1).length;

    // --- EVENT 1: create a client -> should fire client_created -> bell to accountant ---
    const cRes = await api('POST', '/api/clients', { token: admin, body: { name: MARK + ' Client', email: MARK.toLowerCase() + '@example.com' } });
    check('create client', cRes.status === 200 && cRes.json.id, cRes.text);
    clientId = cRes.json.id;

    const after = await api('GET', '/api/my-notifications', { token: acct });
    const afterMatches = (after.json.notifications || []).filter((n) => (n.body || '').indexOf(MARK) !== -1);
    check('client_created fired a staff bell', afterMatches.length > beforeCount,
      'before=' + beforeCount + ' after=' + afterMatches.length);

    // --- EVENT 2: create a job (matching type, assigned to accountant) ---
    //     should fire job_created(add_note) AND job_assigned(set_action_required)
    const jRes = await api('POST', '/api/jobs', { token: admin, body: {
      clientId: clientId, jobType: JOBTYPE, financialYear: '2025-26', accountant: 'accountant@successwa.com' } });
    check('create job', jRes.status === 200 && jRes.json.id, jRes.text);
    jobId = jRes.json.id;

    const notes = await api('GET', '/api/jobs/' + jobId + '/notes', { token: admin });
    const hasNote = (notes.json.notes || []).some((n) => (n.note || '').indexOf(MARK) !== -1);
    check('job_created added the internal note', hasNote, notes.text);

    const job = await api('GET', '/api/jobs/' + jobId, { token: admin });
    check('job_assigned set action_required=true', job.json.job && job.json.job.action_required === true,
      JSON.stringify(job.json.job && { ar: job.json.job.action_required }));

    // --- EVENT 3: trigger_key filter — a job of a DIFFERENT type must NOT get the note ---
    const jRes2 = await api('POST', '/api/jobs', { token: admin, body: {
      clientId: clientId, jobType: 'SOMETHING-ELSE', financialYear: '2025-26' } });
    const jobId2 = jRes2.json && jRes2.json.id;
    if (jobId2) {
      const notes2 = await api('GET', '/api/jobs/' + jobId2 + '/notes', { token: admin });
      const noNote = !(notes2.json.notes || []).some((n) => (n.note || '').indexOf(MARK) !== -1);
      check('trigger_key filter: other job type did NOT get the note', noNote, notes2.text);
      // track for cleanup
      global.__jobId2 = jobId2;
    }

    // --- disabled rule must not fire ---
    await api('PATCH', '/api/admin/automations/' + createdRuleIds[0], { token: admin, body: { enabled: false } });
    const jRes3 = await api('POST', '/api/jobs', { token: admin, body: {
      clientId: clientId, jobType: JOBTYPE, financialYear: '2025-26' } });
    const jobId3 = jRes3.json && jRes3.json.id;
    if (jobId3) {
      const notes3 = await api('GET', '/api/jobs/' + jobId3 + '/notes', { token: admin });
      const noNote3 = !(notes3.json.notes || []).some((n) => (n.note || '').indexOf(MARK) !== -1);
      check('disabled rule did NOT fire', noNote3, notes3.text);
      global.__jobId3 = jobId3;
    }
  } catch (e) {
    check('harness ran without throwing', false, e.message);
  } finally {
    // ---- cleanup everything we created ----
    try {
      const jobIds = [jobId, global.__jobId2, global.__jobId3].filter(Boolean);
      for (const jid of jobIds) {
        await pool.query('DELETE FROM job_notes WHERE job_id=$1', [jid]);
        await pool.query('DELETE FROM job_status_history WHERE job_id=$1', [jid]);
        await pool.query('DELETE FROM job_checklist_items WHERE job_id=$1', [jid]);
        await pool.query('DELETE FROM notifications WHERE job_id=$1', [jid]);
        await pool.query('DELETE FROM jobs WHERE id=$1', [jid]);
      }
      if (clientId) {
        await pool.query('DELETE FROM notifications WHERE lower(to_email)=$1', [MARK.toLowerCase() + '@example.com']);
        await pool.query('DELETE FROM clients WHERE id=$1', [clientId]);
      }
      // remove the bell notifications sent to the accountant that carry our marker
      await pool.query("DELETE FROM notifications WHERE body LIKE $1", ['%' + MARK + '%']);
      for (const id of createdRuleIds) await pool.query('DELETE FROM stage_automations WHERE id=$1', [id]);
      console.log('cleanup: removed ' + createdRuleIds.length + ' rules + test client/jobs');
    } catch (e) { console.log('cleanup error: ' + e.message); }
    await pool.end();
    console.log('SUMMARY: ' + passed + ' passed / ' + failed + ' failed (total ' + (passed + failed) + ')');
    process.exit(failed ? 1 : 0);
  }
})();

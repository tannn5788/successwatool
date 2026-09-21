// Wave 4A test: staff direct email to client + email log + RBAC. Uses Bearer token auth.
const BASE = 'http://127.0.0.1:8000';
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m); } }

async function login(email, password) {
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const j = await r.json();
  return j.token || null;
}
async function api(path, token, opts = {}) {
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (opts.body) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j };
}

(async () => {
  const admin = await login('admin@successwa.com', 'admin123');
  ok(admin, 'admin login');
  const clients = await api('/api/clients', admin);
  const withEmail = (clients.j.clients || clients.j || []).find(c => c.email);
  ok(withEmail, 'found a client with email: ' + (withEmail && withEmail.id + ' / ' + withEmail.email));
  if (!withEmail) { console.log(JSON.stringify({ passed: pass, failed: fail })); return; }

  const cid = withEmail.id;
  const before = await api('/api/clients/' + cid + '/emails', admin);
  ok(before.status === 200 && Array.isArray(before.j.emails), 'GET emails returns array (' + (before.j.emails || []).length + ')');
  const beforeCount = (before.j.emails || []).length;

  const noSubj = await api('/api/clients/' + cid + '/email', admin, { method: 'POST', body: { subject: '', body: 'x' } });
  ok(noSubj.status === 400, 'empty subject rejected 400');
  const noBody = await api('/api/clients/' + cid + '/email', admin, { method: 'POST', body: { subject: 'x', body: '' } });
  ok(noBody.status === 400, 'empty body rejected 400');

  const subj = 'QA Wave4 test ' + Date.now();
  const send = await api('/api/clients/' + cid + '/email', admin, { method: 'POST', body: { subject: subj, body: 'Hello from QA test.' } });
  ok(send.status === 200 && send.j.ok, 'send email ok status=' + (send.j && send.j.status));

  const after = await api('/api/clients/' + cid + '/emails', admin);
  const afterCount = (after.j.emails || []).length;
  ok(afterCount === beforeCount + 1, 'email log grew by 1 (' + beforeCount + '->' + afterCount + ')');
  ok((after.j.emails || []).some(e => e.subject === subj), 'sent subject appears in log');

  const recep = await login('reception@successwa.com', 'recep123');
  const recepView = await api('/api/clients/' + cid + '/emails', recep);
  ok(recepView.status === 200, 'reception can view email log');

  const cemail = 'qa+' + Date.now() + '@example.com';
  const reg = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: cemail, password: 'pass1234', name: 'QA Client' }) });
  const regJson = await reg.json();
  const clToken = regJson.token || null;
  if (clToken) {
    const clView = await api('/api/clients/' + cid + '/emails', clToken);
    ok(clView.status === 403 || clView.status === 401, 'client blocked from email log (status ' + clView.status + ')');
    const clSend = await api('/api/clients/' + cid + '/email', clToken, { method: 'POST', body: { subject: 'hack', body: 'hack' } });
    ok(clSend.status === 403 || clSend.status === 401, 'client blocked from sending email (status ' + clSend.status + ')');
  } else { ok(false, 'client register/login failed for RBAC test'); }

  console.log(JSON.stringify({ passed: pass, failed: fail, total: pass + fail }));
})();

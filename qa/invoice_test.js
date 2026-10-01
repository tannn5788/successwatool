// Invoice/payment feature test. Run: node qa/invoice_test.js  (server must be up on 127.0.0.1:8000)
require('dotenv').config();
const BASE = process.env.BASE || 'http://127.0.0.1:8000';
let pass = 0, fail = 0;
function ok(cond, label, extra) { if (cond) { pass++; console.log('PASS ' + label); } else { fail++; console.log('FAIL ' + label + (extra ? ' :: ' + extra : '')); } }
async function api(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch (e) {}
  return { status: res.status, json };
}
async function login(email, password) {
  const r = await api('POST', '/api/login', { body: { email, password } });
  return r.json && r.json.token;
}
(async () => {
  const admin = await login('admin@successwa.com', 'admin123');
  ok(!!admin, 'admin login');

  // Register a fresh client so we have a dedicated clients row with a known email.
  const email = 'inv' + Date.now() + '@example.com';
  const reg = await api('POST', '/api/register', { body: { email, name: 'Invoice QA', password: 'pass1234' } });
  const clientToken = reg.json && reg.json.token;
  ok(!!clientToken, 'client register');

  // Find this client's id via admin clients list.
  const cl = await api('GET', '/api/clients', { token: admin });
  const mine = (cl.json.clients || cl.json || []).find((c) => (c.email || '').toLowerCase() === email);
  ok(!!mine, 'client row exists', JSON.stringify(cl.json).slice(0, 120));
  const clientId = mine && mine.id;

  // Staff creates an invoice.
  const create = await api('POST', '/api/clients/' + clientId + '/invoices', { token: admin, body: { amount: 150.5, description: 'Tax return 2025' } });
  ok(create.status === 200 && create.json.id, 'staff create invoice', JSON.stringify(create.json));
  const invId = create.json.id;

  // Validation: zero/negative rejected.
  const bad = await api('POST', '/api/clients/' + clientId + '/invoices', { token: admin, body: { amount: 0 } });
  ok(bad.status === 400, 'reject zero amount', String(bad.status));

  // Staff list shows it with correct cents.
  const list = await api('GET', '/api/clients/' + clientId + '/invoices', { token: admin });
  const row = (list.json.invoices || []).find((i) => i.id === invId);
  ok(row && Number(row.amount_cents) === 15050, 'amount stored as cents (15050)', row && String(row.amount_cents));

  // Client sees own invoice.
  const cList = await api('GET', '/api/portal/invoices', { token: clientToken });
  const cRow = (cList.json.invoices || []).find((i) => i.id === invId);
  ok(!!cRow && cRow.status === 'unpaid', 'client sees own unpaid invoice');
  ok(cRow && Number(cRow.amount_cents) === 15050, 'client sees amount');

  // Pay Now placeholder.
  const pay = await api('POST', '/api/portal/invoices/' + invId + '/pay', { token: clientToken });
  ok(pay.status === 200 && pay.json.status === 'unpaid' && /coming soon/i.test(pay.json.message || ''), 'pay now placeholder', JSON.stringify(pay.json));

  // Staff marks paid.
  const paid = await api('POST', '/api/invoices/' + invId + '/paid', { token: admin, body: { method: 'manual' } });
  ok(paid.status === 200 && paid.json.status === 'paid', 'staff mark paid');

  // Client now sees paid.
  const cList2 = await api('GET', '/api/portal/invoices', { token: clientToken });
  const cRow2 = (cList2.json.invoices || []).find((i) => i.id === invId);
  ok(cRow2 && cRow2.status === 'paid' && cRow2.paid_at, 'client sees paid status');

  // RBAC: client cannot hit staff invoice endpoints.
  const leak = await api('GET', '/api/clients/' + clientId + '/invoices', { token: clientToken });
  ok(leak.status === 403, 'client blocked from staff invoice list (403)', String(leak.status));
  const leak2 = await api('POST', '/api/invoices/' + invId + '/paid', { token: clientToken });
  ok(leak2.status === 403, 'client blocked from mark-paid (403)', String(leak2.status));

  // Void + confirm hidden from client.
  const create2 = await api('POST', '/api/clients/' + clientId + '/invoices', { token: admin, body: { amount: 99 } });
  const voidRes = await api('POST', '/api/invoices/' + create2.json.id + '/void', { token: admin });
  ok(voidRes.status === 200 && voidRes.json.status === 'void', 'staff void invoice');
  const cList3 = await api('GET', '/api/portal/invoices', { token: clientToken });
  ok(!(cList3.json.invoices || []).some((i) => i.id === create2.json.id), 'voided invoice hidden from client');

  console.log('\nSUMMARY: ' + pass + ' passed / ' + fail + ' failed (total ' + (pass + fail) + ')');
  process.exit(fail ? 1 : 0);
})();

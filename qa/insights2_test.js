// Quick smoke test for Insights 2.0 aggregations.
require('dotenv').config();
const BASE = 'http://127.0.0.1:8000';
(async () => {
  const login = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@successwa.com', password: 'admin123' })
  }).then(r => r.json());
  if (!login.token) { console.error('LOGIN FAILED', login); process.exit(1); }
  const res = await fetch(BASE + '/api/insights/summary', {
    headers: { Authorization: 'Bearer ' + login.token }
  }).then(r => r.json());
  const need = ['deltas','stageByPriority','avgStageDuration','cycleBox','ageHist','activity','workloadByStage','staffBubble','apptsByService','outstandingByStage','stageOrder'];
  let ok = 0;
  need.forEach(k => {
    const present = res[k] !== undefined;
    if (present) ok++;
    console.log((present ? 'PASS ' : 'FAIL ') + k + ' = ' + JSON.stringify(res[k]).slice(0, 120));
  });
  console.log('\ndeltas:', JSON.stringify(res.deltas));
  console.log(`\n${ok}/${need.length} fields present`);
  // scoped test: accountant should get no staff-level leak in workloadByStage
  const alogin = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'accountant@successwa.com', password: 'acct123' })
  }).then(r => r.json());
  const ares = await fetch(BASE + '/api/insights/summary', {
    headers: { Authorization: 'Bearer ' + alogin.token }
  }).then(r => r.json());
  console.log('\naccountant scoped=' + ares.scoped +
    ' workloadByStage=' + (ares.workloadByStage || []).length +
    ' staffBubble=' + (ares.staffBubble || []).length + ' (both should be 0 — no cross-staff leak)');
  process.exit(ok === need.length ? 0 : 1);
})();

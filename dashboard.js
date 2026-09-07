// dashboard.js — staff job dashboard with filters + search.
(function () {
  var auth = Nav.guard(Nav.STAFF);
  if (!auth) return;
  Nav.renderNav('dashboard.html');

  var $ = function (id) { return document.getElementById(id); };
  var esc = Nav.esc;

  Hub.guide('dashboard', auth.role, {
    administrator: { em: '⚙️', title: 'Administrator — full overview', text: 'You can see every job here. Use <b>Clients</b> to create clients/jobs, and <b>Admin</b> to manage users, templates and the audit trail. Click any row to open a job.' },
    supervisor: { em: '✅', title: 'Supervisor — keep an eye on reviews', text: 'This board shows all active jobs. Jobs waiting for you are in the <b>Review Queue</b> (see the count in the top nav). Click any row to open a job.' },
    reception: { em: '🗂️', title: 'Reception — start here', text: 'Click <b>+ New Job</b> or go to <b>Clients</b> to add a client and open a job. Use search and filters to find any job, then click a row to open it.' },
    accountant: { em: '🧮', title: 'Accountant — your jobs', text: 'You only see jobs assigned to you. Click a row to open a job, request documents from the client, and move it to <b>Supervisor review</b> when ready.' },
  });

  // Populate stage filter.
  Hub.STAGES.forEach(function (s) {
    var o = document.createElement('option'); o.value = s[0]; o.textContent = s[1];
    $('fStage').appendChild(o);
  });

  // Reception + admin can create jobs.
  if (auth.role === 'reception' || auth.role === 'administrator') {
    $('newJobBtn').style.display = '';
    $('newJobBtn').addEventListener('click', function () { location.href = 'clients.html'; });
  }

  // Accountants only ever see their own jobs, so the "All staff / Assigned to me"
  // filter is meaningless for them — hide it.
  if (auth.role === 'accountant' && $('fMine')) $('fMine').style.display = 'none';

  var timer = null;
  function debounce(fn) { clearTimeout(timer); timer = setTimeout(fn, 250); }

  function load() {
    var params = [];
    if ($('q').value.trim()) params.push('q=' + encodeURIComponent($('q').value.trim()));
    if ($('fStage').value) params.push('stage=' + encodeURIComponent($('fStage').value));
    if ($('fMine').value === 'mine') {
      params.push('accountant=' + encodeURIComponent(auth.email));
    }
    var url = '/api/jobs' + (params.length ? '?' + params.join('&') : '');
    Nav.api(url).then(render).catch(function (e) {
      $('tableWrap').innerHTML = '<p class="muted">Error: ' + esc(e.message) + '</p>';
    });
  }

  function render(res) {
    var jobs = res.jobs || [];
    $('subLine').textContent = jobs.length + ' job' + (jobs.length === 1 ? '' : 's');
    renderStats(jobs);
    if (!jobs.length) { $('tableWrap').innerHTML = '<div class="card"><p class="muted">No jobs match your filters.</p></div>'; return; }
    var rows = jobs.map(function (j) {
      var cs = Hub.clientStatusFromStage(j.stage, j.on_hold, j.action_required);
      var flags = '';
      if (j.on_hold) flags += '<span class="flag flag-hold">ON HOLD</span>';
      if (j.action_required && !j.on_hold) flags += '<span class="flag flag-action">ACTION</span>';
      var days = Number(j.days_in_stage) || 0;
      var dayCls = days >= 7 ? 'day-pill day-hot' : (days >= 3 ? 'day-pill day-warn' : 'day-pill');
      var pill = Hub.pillClass(cs);
      var rowTint = (pill.split(' ')[1] || 'pill-inprogress').replace('pill-', 'row-');
      var rowCls = ' class="' + rowTint + '"';
      return '<tr data-id="' + esc(j.id) + '"' + rowCls + '>' +
        '<td><strong>' + esc(j.client_name) + '</strong><br><span class="muted small">' + esc(j.client_id) + '</span></td>' +
        '<td><span class="job-tag">' + esc(j.id) + '</span><br><span class="muted small">' + esc(j.job_type || '') + '</span></td>' +
        '<td class="small">' + esc(j.accountant_name || j.accountant_email || '—') + '</td>' +
        '<td class="small">' + esc(j.supervisor_name || j.supervisor_email || '—') + '</td>' +
        '<td><span class="' + Hub.pillClass(cs) + '">' + esc(cs) + '</span>' + flags + '<br><span class="muted small">' + esc(j.stage_label) + '</span></td>' +
        '<td><span class="' + dayCls + '">' + days + 'd</span></td>' +
        '<td class="small next-action">' + esc(j.next_action) + '</td>' +
        '</tr>';
    }).join('');
    $('tableWrap').innerHTML =
      '<div class="card" style="padding:0;overflow:hidden">' +
      '<table class="hub-table dash-table"><thead><tr>' +
      '<th>Client</th><th>Job</th><th>Accountant</th><th>Supervisor</th><th>Status</th><th>Days</th><th>Next Action</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
    Array.prototype.forEach.call($('tableWrap').querySelectorAll('tr[data-id]'), function (tr) {
      tr.addEventListener('click', function () { location.href = 'job.html?id=' + encodeURIComponent(tr.getAttribute('data-id')); });
    });
  }

  function renderStats(jobs) {
    var total = jobs.length;
    var action = 0, hold = 0, review = 0, overdue = 0;
    jobs.forEach(function (j) {
      if (j.on_hold) hold++;
      else if (j.action_required) action++;
      if (j.stage === '05_supervisor_review') review++;
      if ((Number(j.days_in_stage) || 0) >= 7) overdue++;
    });
    var cards = [
      { n: total, l: 'Total jobs', cls: 'sc-total' },
      { n: action, l: 'Action required', cls: 'sc-action' },
      { n: hold, l: 'On hold', cls: 'sc-hold' },
      { n: review, l: 'In review', cls: 'sc-review' },
      { n: overdue, l: 'Overdue (7d+)', cls: 'sc-overdue' },
    ];
    $('statCards').innerHTML = cards.map(function (c) {
      return '<div class="stat-card ' + c.cls + '"><div class="sc-num">' + c.n + '</div><div class="sc-label">' + c.l + '</div></div>';
    }).join('');
  }

  $('q').addEventListener('input', function () { debounce(load); });
  $('fStage').addEventListener('change', load);
  $('fMine').addEventListener('change', load);
  load();
})();

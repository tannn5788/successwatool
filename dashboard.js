// dashboard.js — staff job dashboard with filters + search.
(function () {
  var auth = Nav.guard(Nav.STAFF);
  if (!auth) return;
  Nav.renderNav('dashboard.html');

  var $ = function (id) { return document.getElementById(id); };
  var esc = Nav.esc;
  var isAccountant = auth.role === 'accountant';

  Hub.guide('dashboard', auth.role, {
    administrator: { em: '⚙️', title: 'Administrator — full overview', text: 'You can see every job here. Use <b>Clients</b> to create clients/jobs, and <b>Admin</b> to manage users, templates and the audit trail. Click any row to open a job.' },
    supervisor: { em: '✅', title: 'Supervisor — keep an eye on reviews', text: 'This board shows all active jobs. Jobs waiting for you are in the <b>Review Queue</b> (see the count in the top nav). Click any row to open a job.' },
    reception: { em: '🗂️', title: 'Reception — start here', text: 'Click <b>+ New Job</b> or go to <b>Clients</b> to add a client and open a job. Use search and filters to find any job, then click a row to open it.' },
    accountant: { em: '🧮', title: 'Accountant — your jobs', text: 'Your jobs are grouped by deadline: Overdue, Due Today, Due This Week and Upcoming. Click a row to open a job, work the checklist, then move it to <b>Supervisor review</b> when ready.' },
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

  // ---- Shared helpers ----
  function isDone(j) { return j.stage === '09_completed'; }

  // Days until due (negative = overdue). null if no due date.
  function daysToDue(j) {
    if (!j.due_date) return null;
    var t0 = new Date(); t0.setHours(0, 0, 0, 0);
    var dd = new Date((j.due_date || '').slice(0, 10) + 'T00:00:00');
    return Math.round((dd - t0) / 86400000);
  }

  // Bucket a job by its deadline: overdue | today | week | upcoming | none.
  function dueBucket(j) {
    var d = daysToDue(j);
    if (d === null) return 'none';
    if (isDone(j)) return 'upcoming';
    if (d < 0) return 'overdue';
    if (d === 0) return 'today';
    if (d <= 7) return 'week';
    return 'upcoming';
  }

  function priorityPill(pri) {
    var p = (pri || 'normal').toLowerCase();
    var label = { high: 'High', normal: 'Normal', low: 'Low' }[p] || 'Normal';
    return '<span class="pri-pill pri-' + p + '">' + label + '</span>';
  }

  function dueCellHtml(j) {
    if (!j.due_date) return '<span class="muted small">—</span>';
    var d = daysToDue(j);
    var cls = (!isDone(j) && d < 0) ? 'day-pill day-hot' : ((!isDone(j) && d <= 3) ? 'day-pill day-warn' : 'muted small');
    return '<span class="' + cls + '">' + Hub.fmtDate(j.due_date) + '</span>';
  }

  function rowHtml(j) {
    var cs = Hub.clientStatusFromStage(j.stage, j.on_hold, j.action_required);
    var flags = '';
    if (j.on_hold) flags += '<span class="flag flag-hold">ON HOLD</span>';
    if (j.action_required && !j.on_hold) flags += '<span class="flag flag-action">ACTION</span>';
    var days = Number(j.days_in_stage) || 0;
    var dayCls = days >= 7 ? 'day-pill day-hot' : (days >= 3 ? 'day-pill day-warn' : 'day-pill');
    var pill = Hub.pillClass(cs);
    var rowTint = (pill.split(' ')[1] || 'pill-inprogress').replace('pill-', 'row-');
    var chk = (j.checklist_total != null && Number(j.checklist_total) > 0)
      ? '<br><span class="muted small">☑ ' + (j.checklist_done || 0) + '/' + j.checklist_total + '</span>' : '';
    return '<tr data-id="' + esc(j.id) + '" class="' + rowTint + '">' +
      '<td><strong>' + esc(j.client_name) + '</strong><br><span class="muted small">' + esc(j.client_id) + '</span></td>' +
      '<td><span class="job-tag">' + esc(j.id) + '</span><br><span class="muted small">' + esc(j.job_type || '') + '</span></td>' +
      '<td>' + priorityPill(j.priority) + '</td>' +
      '<td class="small">' + esc(j.accountant_name || j.accountant_email || '—') + '</td>' +
      '<td class="small">' + esc(j.supervisor_name || j.supervisor_email || '—') + '</td>' +
      '<td><span class="' + Hub.pillClass(cs) + '">' + esc(cs) + '</span>' + flags + '<br><span class="muted small">' + esc(j.stage_label) + '</span>' + chk + '</td>' +
      '<td><span class="' + dayCls + '">' + days + 'd</span></td>' +
      '<td>' + dueCellHtml(j) + '</td>' +
      '<td class="small next-action">' + esc(j.next_action) + '</td>' +
      '</tr>';
  }

  function tableHtml(jobs) {
    var rows = jobs.map(rowHtml).join('');
    return '<div class="card" style="padding:0;overflow:hidden">' +
      '<table class="hub-table dash-table"><thead><tr>' +
      '<th>Client</th><th>Job</th><th>Priority</th><th>Accountant</th><th>Supervisor</th><th>Status</th><th>Days</th><th>Due</th><th>Next Action</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function bindRows() {
    Array.prototype.forEach.call($('tableWrap').querySelectorAll('tr[data-id]'), function (tr) {
      tr.addEventListener('click', function () { location.href = 'job.html?id=' + encodeURIComponent(tr.getAttribute('data-id')); });
    });
  }

  function render(res) {
    var jobs = res.jobs || [];
    $('subLine').textContent = jobs.length + ' job' + (jobs.length === 1 ? '' : 's');
    if (isAccountant) { renderStatsAccountant(jobs); renderAccountant(jobs); }
    else { renderStatsAdmin(jobs); renderFlat(jobs); }
  }

  // ---- Admin / supervisor / reception: flat table ----
  function renderFlat(jobs) {
    if (!jobs.length) { $('tableWrap').innerHTML = '<div class="card"><p class="muted">No jobs match your filters.</p></div>'; return; }
    $('tableWrap').innerHTML = tableHtml(jobs);
    bindRows();
  }

  // ---- Accountant: grouped by due bucket ----
  function renderAccountant(jobs) {
    if (!jobs.length) { $('tableWrap').innerHTML = '<div class="card"><p class="muted">No jobs assigned to you.</p></div>'; return; }
    var groups = { overdue: [], today: [], week: [], upcoming: [], none: [] };
    jobs.forEach(function (j) { groups[dueBucket(j)].push(j); });
    // Sort each group by due date ascending (nulls last handled by group).
    function byDue(a, b) {
      var da = a.due_date || '9999-12-31', db = b.due_date || '9999-12-31';
      return da < db ? -1 : (da > db ? 1 : 0);
    }
    var order = [
      ['overdue', '⏰ Overdue', 'grp-overdue'],
      ['today', '📅 Due Today', 'grp-today'],
      ['week', '🗓️ Due This Week', 'grp-week'],
      ['upcoming', '📌 Upcoming', 'grp-upcoming'],
      ['none', '— No due date', 'grp-none'],
    ];
    var html = order.map(function (g) {
      var list = groups[g[0]].sort(byDue);
      if (!list.length) return '';
      return '<div class="due-group ' + g[2] + '">' +
        '<div class="due-group-head">' + g[1] + ' <span class="due-group-count">' + list.length + '</span></div>' +
        tableHtml(list) + '</div>';
    }).join('');
    $('tableWrap').innerHTML = html || '<div class="card"><p class="muted">No jobs assigned to you.</p></div>';
    bindRows();
  }

  // ---- Stat cards: accountant (own jobs) ----
  function renderStatsAccountant(jobs) {
    var overdue = 0, today = 0, week = 0, action = 0;
    jobs.forEach(function (j) {
      var b = dueBucket(j);
      if (b === 'overdue') overdue++;
      else if (b === 'today') today++;
      else if (b === 'week') week++;
      if (j.action_required && !j.on_hold) action++;
    });
    var hero = [
      { n: overdue, l: 'Overdue', cls: 'hero-overdue' },
      { n: today, l: 'Due today', cls: 'hero-today' },
      { n: week, l: 'Due this week', cls: 'hero-week' },
      { n: action, l: 'Waiting on client', cls: 'hero-wait' },
    ];
    var strip = [{ n: jobs.length, l: 'My jobs' }];
    paintStats(hero, strip);
    $('workloadWrap') && ($('workloadWrap').innerHTML = '');
  }

  // ---- Stat cards + workload: admin / supervisor / reception ----
  function renderStatsAdmin(jobs) {
    var total = jobs.length;
    var action = 0, hold = 0, review = 0, signature = 0, lodgement = 0, completed = 0;
    var overdue = 0, dueToday = 0, dueWeek = 0;
    var workload = {}; // accountant -> active count
    jobs.forEach(function (j) {
      if (j.on_hold) hold++;
      else if (j.action_required) action++;
      if (j.stage === '05_supervisor_review') review++;
      if (j.stage === '06_awaiting_signature') signature++;
      if (j.stage === '07_ready_lodgement') lodgement++;
      if (j.stage === '09_completed') completed++;
      var b = dueBucket(j);
      if (b === 'overdue') overdue++;
      else if (b === 'today') dueToday++;
      else if (b === 'week') dueWeek++;
      // Workload = active (not completed/lodged) jobs per accountant.
      if (j.stage !== '09_completed' && j.stage !== '08_lodged') {
        var who = j.accountant_name || j.accountant_email || 'Unassigned';
        workload[who] = (workload[who] || 0) + 1;
      }
    });
    // Tier 1 — needs attention (deadlines + waiting on clients).
    var hero = [
      { n: overdue, l: 'Overdue', cls: 'hero-overdue' },
      { n: dueToday, l: 'Due today', cls: 'hero-today' },
      { n: dueWeek, l: 'Due this week', cls: 'hero-week' },
      { n: action, l: 'Waiting on clients', cls: 'hero-wait' },
    ];
    // Tier 2 — pipeline snapshot (compact chips).
    var strip = [
      { n: total, l: 'Total', cls: 'chip-total' },
      { n: review, l: 'In review', cls: 'chip-review' },
      { n: signature, l: 'Awaiting signature', cls: 'chip-sign' },
      { n: lodgement, l: 'Ready to lodge', cls: 'chip-lodge' },
      { n: hold, l: 'On hold', cls: 'chip-hold' },
      { n: completed, l: 'Completed', cls: 'chip-done' },
    ];
    paintStats(hero, strip);
    renderWorkload(workload);
  }

  // Render the two-tier stats: big "attention" cards + a compact pipeline strip.
  function paintStats(hero, strip) {
    var heroHtml = '<div class="stat-hero">' + hero.map(function (c) {
      return '<div class="hero-card ' + c.cls + (c.n > 0 ? ' hero-on' : '') + '">' +
        '<div class="hero-num">' + c.n + '</div><div class="hero-label">' + c.l + '</div></div>';
    }).join('') + '</div>';
    var stripHtml = '<div class="stat-strip">' + strip.map(function (c) {
      return '<div class="strip-chip ' + (c.cls || '') + '"><span class="strip-num">' + c.n + '</span>' +
        '<span class="strip-label">' + c.l + '</span></div>';
    }).join('') + '</div>';
    $('statCards').innerHTML = heroHtml + stripHtml;
  }

  function renderWorkload(workload) {
    var wrap = $('workloadWrap');
    if (!wrap) return;
    var names = Object.keys(workload);
    if (!names.length) { wrap.innerHTML = ''; return; }
    names.sort(function (a, b) { return workload[b] - workload[a]; });
    var max = workload[names[0]] || 1;
    var rows = names.map(function (n) {
      var pct = Math.round((workload[n] / max) * 100);
      return '<div class="wl-row"><div class="wl-name">' + esc(n) + '</div>' +
        '<div class="wl-bar"><div class="wl-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="wl-num">' + workload[n] + '</div></div>';
    }).join('');
    wrap.innerHTML = '<div class="section-title">Workload by staff <span class="muted small">(active jobs)</span></div>' +
      '<div class="card">' + rows + '</div>';
  }

  $('q').addEventListener('input', function () { debounce(load); });
  $('fStage').addEventListener('change', load);
  $('fMine').addEventListener('change', load);
  load();
})();

// home.js — Syraxx client Home dashboard.
// Shows: Welcome, Next Appointment (Setmore — wired in a later stage), an
// "Action Required" widget aggregated across jobs, a Current Work summary, and
// Recent Messages. All data comes from /api/portal/summary in one call.
(function () {
  var auth = Nav.guard(['client']);
  if (!auth) return;
  Nav.renderNav('home.html');
  var esc = Nav.esc;
  var wrap = document.getElementById('wrap');

  Hub.guide('home', auth.role, {
    client: { em: '👋', title: 'Welcome to Syraxx', text: 'This is your home base. <b>Action Required</b> shows anything we need from you. <b>Current Work</b> tracks each job\u2019s progress. Use the top menu to manage documents, appointments and messages.' },
  });

  function firstName(name, email) {
    if (name && name.trim()) return name.trim().split(/\s+/)[0];
    return (email || '').split('@')[0];
  }

  function actionCard(actions) {
    var head = '<div class="section-title" style="display:flex;align-items:center;gap:8px">' +
      'Action Required' + (actions.length ? ' <span class="oc-badge">' + actions.length + '</span>' : '') + '</div>';
    if (!actions.length) {
      return '<div class="card" style="margin-bottom:16px">' + head +
        '<p class="outstanding-empty">✓ Nothing needs your attention right now.</p></div>';
    }
    var items = actions.map(function (a) {
      var go = a.type === 'sign'
        ? 'portal.html?job=' + encodeURIComponent(a.jobId)
        : 'portal.html?job=' + encodeURIComponent(a.jobId);
      var icon = a.type === 'sign' ? '✍️' : '📄';
      return '<li><span class="oi-dot"></span>' +
        '<span><span class="oi-title">' + icon + ' ' + esc(a.label) + '</span></span>' +
        '<a class="btn btn-primary btn-xs" href="' + go + '" style="margin-left:auto">' +
        (a.type === 'sign' ? 'Review & Sign' : 'Upload') + '</a></li>';
    }).join('');
    return '<div class="card action-home" style="margin-bottom:16px;border-color:var(--red)">' + head +
      '<ul class="outstanding-list">' + items + '</ul></div>';
  }

  function apptCard(next) {
    var body = next
      ? '<p><b>' + esc(next.service_name || 'Appointment') + '</b><br>' +
        '<span class="muted">' + Hub.fmtDateTime(next.start_time) + (next.staff_name ? ' · with ' + esc(next.staff_name) : '') + '</span></p>'
      : '<p class="muted">No upcoming appointment scheduled.</p>';
    return '<div class="card" style="margin-bottom:16px">' +
      '<div class="section-title">Next Appointment</div>' + body +
      '<div style="margin-top:8px"><a class="btn btn-outline btn-sm" href="appointments.html">' +
        (next ? 'Manage appointments' : 'Book an appointment') + '</a></div>' +
      '</div>';
  }

  function stepperMini(pct, label) {
    return '<div class="progress"><i style="width:' + (pct || 0) + '%"></i></div>' +
      '<p class="small" style="margin-top:4px">' + esc(label || '') + '</p>';
  }

  function workCard(jobs) {
    var head = '<div class="section-title">Current Work</div>';
    if (!jobs.length) {
      return '<div class="card" style="margin-bottom:16px">' + head +
        '<p class="muted">You have no active work right now.</p></div>';
    }
    var rows = jobs.map(function (j) {
      var pill = Hub.pillClass(j.clientStatus);
      return '<div class="job-mini" style="padding:12px 0;border-top:1px solid var(--border)">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">' +
        '<div><b>' + esc(j.jobType || 'Tax Job') + '</b> ' +
        '<span class="muted small">' + esc(j.financialYear || '') + '</span></div>' +
        '<span class="' + pill + '">' + esc(j.clientStatus) + '</span></div>' +
        stepperMini(j.progressPct, j.clientStepLabel + ' — ' + (j.clientStepExplain || j.clientMessage)) +
        '<div style="margin-top:6px"><a class="btn btn-outline btn-xs" href="portal.html?job=' +
        encodeURIComponent(j.id) + '">View details</a></div>' +
        '</div>';
    }).join('');
    return '<div class="card" style="margin-bottom:16px">' + head + rows + '</div>';
  }

  function messagesCard(msgs) {
    var head = '<div class="section-title">Recent Messages</div>';
    if (!msgs.length) {
      return '<div class="card" style="margin-bottom:16px">' + head +
        '<p class="muted">No recent messages.</p></div>';
    }
    var rows = msgs.map(function (m) {
      return '<div style="padding:9px 0;border-top:1px solid var(--border)">' +
        '<div style="display:flex;justify-content:space-between;gap:10px">' +
        '<b class="small">' + esc(m.subject || 'Update') + '</b>' +
        '<span class="muted small">' + Hub.fmtDate(m.created_at) + '</span></div>' +
        (m.body ? '<p class="muted small" style="margin:2px 0 0">' + esc(String(m.body).slice(0, 140)) + '</p>' : '') +
        '</div>';
    }).join('');
    return '<div class="card" style="margin-bottom:16px">' + head + rows +
      '<div style="margin-top:8px"><a class="btn btn-ghost btn-sm" href="messages.html">See all messages</a></div></div>';
  }

  function announcementCard(a) {
    if (!a || (!a.title && !a.body)) return '';
    return '<div class="card" style="margin-bottom:16px;border-color:var(--gold,#e0b34d);background:var(--gold-tint,#fff8e8)">' +
      '<div class="section-title">📣 ' + esc(a.title || 'Announcement') + '</div>' +
      (a.body ? '<p class="small" style="margin:2px 0 0;white-space:pre-wrap">' + esc(a.body) + '</p>' : '') +
      '</div>';
  }

  function quickLinksCard() {
    var links = [
      { href: 'documents.html', icon: '📤', label: 'Upload files' },
      { href: 'appointments.html', icon: '📅', label: 'Book appointment' },
      { href: 'messages.html', icon: '💬', label: 'Send a message' },
      { href: 'previous.html', icon: '🗂️', label: 'Previous work' },
    ];
    var rows = links.map(function (l) {
      return '<a class="ql-link" href="' + l.href + '" ' +
        'style="display:flex;align-items:center;gap:8px;padding:9px 0;border-top:1px solid var(--border);text-decoration:none;color:inherit">' +
        '<span>' + l.icon + '</span><span class="small"><b>' + esc(l.label) + '</b></span>' +
        '<span style="margin-left:auto;color:var(--muted)">›</span></a>';
    }).join('');
    return '<div class="card" style="margin-bottom:16px">' +
      '<div class="section-title">Quick links</div>' + rows + '</div>';
  }

  function completedCard(jobs) {
    if (!jobs || !jobs.length) return '';
    var head = '<div class="section-title">Recently Completed</div>';
    var rows = jobs.map(function (j) {
      var meta = [j.entityName, j.financialYear].filter(Boolean).map(esc).join(' · ');
      return '<div style="padding:10px 0;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">' +
        '<div><b>' + esc(j.jobType || 'Tax Job') + '</b> ' +
        (meta ? '<span class="muted small">' + meta + '</span>' : '') +
        '<br><span class="muted small">Completed ' + Hub.fmtDate(j.completedAt) + '</span></div>' +
        '<span class="pill pill-completed">✓ Completed</span>' +
        '</div>';
    }).join('');
    return '<div class="card" style="margin-bottom:16px">' + head + rows +
      '<div style="margin-top:8px"><a class="btn btn-ghost btn-sm" href="previous.html">See all previous work</a></div></div>';
  }

  function render(res) {
    document.getElementById('welcome').textContent = 'Welcome, ' + firstName(res.clientName, auth.email);
    wrap.innerHTML =
      announcementCard(res.announcement) +
      '<div class="home-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start">' +
        '<div>' + actionCard(res.actions || []) + workCard(res.jobs || []) + completedCard(res.completedJobs || []) + '</div>' +
        '<div>' + apptCard(res.nextAppointment) + quickLinksCard() + messagesCard(res.messages || []) + '</div>' +
      '</div>';
  }

  function load() {
    Nav.api('/api/portal/summary').then(render).catch(function (e) {
      wrap.innerHTML = '<p class="muted">Error: ' + esc(e.message) + '</p>';
    });
  }

  load();
})();

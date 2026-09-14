// recurring-page.js — manage recurring job schedules (list / pause / resume / run now / delete).
(function () {
  var auth = Nav.guard(['reception', 'supervisor', 'administrator']);
  if (!auth) return;
  Nav.renderNav('recurring.html');
  var esc = Nav.esc;
  var $ = function (id) { return document.getElementById(id); };

  Hub.guide('recurring', auth.role, {
    reception: { em: '🔁', title: 'Recurring jobs', text: 'These schedules create jobs automatically on a cycle (monthly, quarterly, annually). Use <b>Run now</b> to generate the next job immediately, or <b>Pause</b> to stop a schedule.' },
    supervisor: { em: '🔁', title: 'Recurring jobs', text: 'Schedules that auto-create jobs. Pause, resume, run now or delete as needed.' },
    administrator: { em: '🔁', title: 'Recurring jobs', text: 'Schedules that auto-create jobs. Pause, resume, run now or delete as needed.' },
  });

  var FREQ = { monthly: 'Monthly', quarterly: 'Quarterly', annually: 'Annually' };

  function load() {
    Nav.api('/api/recurring').then(render).catch(function (e) {
      $('wrap').innerHTML = '<p class="muted">Error: ' + esc(e.message) + '</p>';
    });
  }

  function render(res) {
    var list = res.schedules || [];
    if (!list.length) {
      $('wrap').innerHTML = '<div class="card"><p class="muted">No recurring schedules yet. Create one from <a href="clients.html">Clients → + Job</a> by choosing a <b>Repeat</b> frequency.</p></div>';
      return;
    }
    var rows = list.map(function (s) {
      var pri = (s.priority || 'normal').toLowerCase();
      var priLabel = { high: 'High', normal: 'Normal', low: 'Low' }[pri] || 'Normal';
      var statusPill = s.active
        ? '<span class="pill pill-completed">Active</span>'
        : '<span class="pill pill-hold">Paused</span>';
      return '<tr' + (s.active ? '' : ' class="row-hold"') + '>' +
        '<td><span class="job-tag">' + esc(s.id) + '</span></td>' +
        '<td><strong>' + esc(s.client_name) + '</strong><br><span class="muted small">' + esc(s.client_id) + (s.entity_name ? ' · ' + esc(s.entity_name) : '') + '</span></td>' +
        '<td>' + esc(s.job_type || '—') + '<br><span class="muted small">' + esc(s.financial_year || '') + '</span></td>' +
        '<td><span class="freq-pill">' + (FREQ[s.frequency] || s.frequency) + '</span></td>' +
        '<td><span class="pri-pill pri-' + pri + '">' + priLabel + '</span></td>' +
        '<td>' + esc(Hub.fmtDate(s.next_run_date)) + '<br><span class="muted small">lead ' + (s.lead_days != null ? s.lead_days : 14) + 'd</span></td>' +
        '<td class="small">' + esc(s.accountant_name || s.accountant_email || '—') + '</td>' +
        '<td>' + statusPill + (s.last_job_id ? '<br><span class="muted small">last: ' + esc(s.last_job_id) + '</span>' : '') + '</td>' +
        '<td style="white-space:nowrap">' +
          '<button class="btn btn-xs" data-run="' + esc(s.id) + '" data-tip="Generate the next job from this schedule immediately.">Run now</button> ' +
          '<button class="btn btn-xs" data-toggle="' + esc(s.id) + '" data-active="' + (s.active ? '1' : '0') + '">' + (s.active ? 'Pause' : 'Resume') + '</button> ' +
          '<button class="btn btn-xs danger" data-del="' + esc(s.id) + '">Delete</button>' +
        '</td></tr>';
    }).join('');
    $('wrap').innerHTML =
      '<div class="card" style="padding:0;overflow:hidden"><table class="hub-table"><thead><tr>' +
      '<th>ID</th><th>Client</th><th>Job type</th><th>Frequency</th><th>Priority</th><th>Next job due</th><th>Accountant</th><th>Status</th><th></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
    bind();
  }

  function bind() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-run]'), function (b) {
      b.addEventListener('click', function () {
        Hub.busy(b, Nav.api('/api/recurring/' + b.getAttribute('data-run') + '/run-now', { method: 'POST' }))
          .then(function (r) { Hub.toast('Created job ' + r.jobId); load(); })
          .catch(function (e) { Hub.toast(e.message); });
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-toggle]'), function (b) {
      b.addEventListener('click', function () {
        var makeActive = b.getAttribute('data-active') !== '1';
        Nav.api('/api/recurring/' + b.getAttribute('data-toggle'), { method: 'PATCH', body: { active: makeActive } })
          .then(function () { Hub.toast(makeActive ? 'Resumed' : 'Paused'); load(); })
          .catch(function (e) { Hub.toast(e.message); });
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-del]'), function (b) {
      b.addEventListener('click', function () {
        if (!confirm('Delete this recurring schedule? Jobs already created are not affected.')) return;
        Nav.api('/api/recurring/' + b.getAttribute('data-del'), { method: 'DELETE' })
          .then(function () { Hub.toast('Schedule deleted'); load(); })
          .catch(function (e) { Hub.toast(e.message); });
      });
    });
  }

  load();
})();

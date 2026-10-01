// pipeline.js — staff Kanban board. Columns = the 9 workflow stages; cards = jobs.
// Drag a card to another column to change its stage (POST /api/jobs/:id/stage).
(function () {
  var auth = Nav.guard(Nav.STAFF);
  if (!auth) return;
  Nav.renderNav('pipeline.html');
  var esc = Nav.esc;
  var board = document.getElementById('board');
  var dragId = null;

  Hub.guide('pipeline', auth.role, {
    administrator: { em: '🗂️', title: 'Pipeline board', text: 'Every job as a card in its current stage. <b>Drag a card</b> to another column to move the job. Overdue cards (past their stage time limit) are outlined in red.' },
    supervisor: { em: '🗂️', title: 'Pipeline board', text: 'Drag a job card between stages to progress it. Overdue cards are highlighted.' },
    reception: { em: '🗂️', title: 'Pipeline board', text: 'Drag a job card between stages to progress it.' },
    accountant: { em: '🗂️', title: 'Your pipeline', text: 'Your assigned jobs as cards. Drag one to a new stage when you progress it.' },
  });

  function injectStyles() {
    if (document.getElementById('pl-styles')) return;
    var css = '' +
      '.pl-wrap{display:flex;gap:12px;overflow-x:auto;padding-bottom:12px}' +
      '.pl-col{flex:0 0 250px;background:var(--panel,#f6f7f9);border:1px solid var(--border,#e7eaee);border-radius:10px;padding:8px;min-height:120px}' +
      '.pl-col.drop{outline:2px dashed var(--accent,#3167b0);outline-offset:-4px}' +
      '.pl-col-head{font-family:var(--mono);font-size:11px;font-weight:700;color:#556;padding:4px 6px;display:flex;justify-content:space-between;align-items:center}' +
      '.pl-card{background:#fff;border:1px solid var(--border,#e2e5e9);border-radius:8px;padding:9px 10px;margin:6px 0;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.04)}' +
      '.pl-card:hover{border-color:var(--blue,#96701a)}' +
      '.pl-card:active{cursor:grabbing}' +
      '.pl-card.overdue{border-color:var(--red,#c0392b);box-shadow:0 0 0 1px var(--red,#c0392b) inset}' +
      '.pl-card .t{font-weight:700;font-size:13px}' +
      '.pl-card .m{color:#667;font-size:11px;margin-top:2px}' +
      '.pl-badges{display:flex;flex-wrap:wrap;gap:3px;margin-top:5px}' +
      '.jm-id{font-family:var(--mono);font-size:13px;color:var(--muted);font-weight:500}' +
      '.jm-stage{font-family:var(--mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--blue,#96701a);font-weight:700;margin-bottom:8px}' +
      '.jm-flags{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:12px}' +
      '.jm-row{display:flex;justify-content:space-between;gap:16px;padding:6px 0;border-bottom:1px solid var(--border-soft,#eee);font-size:13px}' +
      '.jm-row .jm-k{color:var(--muted)}' +
      '.jm-row .jm-v{text-align:right;font-weight:600}' +
      '.jm-sec{font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:14px 0 6px}' +
      '.jm-note{font-size:13px;padding:6px 0;border-bottom:1px solid var(--border-soft,#eee)}' +
      '.jm-note .muted{font-size:11px;margin-left:6px}' +
      '.jm-hist{display:flex;justify-content:space-between;font-size:12px;padding:4px 0}' +
      '.jm-actions{margin-top:16px;display:flex;justify-content:flex-end}';
    var s = document.createElement('style'); s.id = 'pl-styles'; s.textContent = css; document.head.appendChild(s);
  }

  function prioBadge(p) {
    if (p === 'high') return '<span class="pill pill-action">High</span>';
    if (p === 'low') return '<span class="pill pill-hold">Low</span>';
    return '';
  }

  function card(j) {
    var meta = [j.client_name, j.entity_name].filter(Boolean).map(esc).join(' · ');
    var due = j.due_date ? '<span class="pill ' + (j.overdue ? 'pill-action' : 'pill-received') + '">Due ' + Hub.fmtDate(j.due_date) + '</span>' : '';
    var badges = [prioBadge(j.priority), due,
      j.on_hold ? '<span class="pill pill-hold">On hold</span>' : '',
      j.action_required ? '<span class="pill pill-action">Action</span>' : ''].filter(Boolean).join('');
    return '<div class="pl-card' + (j.overdue ? ' overdue' : '') + '" draggable="true" data-id="' + esc(j.id) + '">' +
      '<div class="t">' + esc(j.job_type || 'Tax Job') + ' <span class="m">' + esc(j.id) + '</span></div>' +
      (meta ? '<div class="m">' + meta + '</div>' : '') +
      (j.accountant_name ? '<div class="m" style="display:flex;align-items:center;gap:5px"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>' + esc(j.accountant_name) + '</div>' : '') +
      (badges ? '<div class="pl-badges">' + badges + '</div>' : '') +
      '</div>';
  }

  function render(res) {
    injectStyles();
    var stages = res.stages || [];
    var map = res.stageMap || {};
    var byStage = {};
    stages.forEach(function (s) { byStage[s] = []; });
    jobsById = {};
    (res.jobs || []).forEach(function (j) { jobsById[j.id] = j; (byStage[j.stage] = byStage[j.stage] || []).push(j); });

    var cols = stages.map(function (s) {
      var label = (map[s] && map[s].internalLabel) || s;
      var list = byStage[s] || [];
      return '<div class="pl-col" data-stage="' + esc(s) + '">' +
        '<div class="pl-col-head"><span>' + esc(label) + '</span><span>' + list.length + '</span></div>' +
        '<div class="pl-col-body">' + list.map(card).join('') + '</div>' +
        '</div>';
    }).join('');
    board.innerHTML = '<div class="pl-wrap">' + cols + '</div>';
    bindDnd();
  }

  function bindDnd() {
    Array.prototype.forEach.call(board.querySelectorAll('.pl-card'), function (c) {
      var didDrag = false;
      c.addEventListener('dragstart', function () { didDrag = true; dragId = c.getAttribute('data-id'); c.style.opacity = '0.5'; });
      c.addEventListener('dragend', function () { c.style.opacity = ''; });
      // Click (not drag) opens a job-detail popup on this screen.
      c.addEventListener('click', function () {
        if (didDrag) { didDrag = false; return; }
        openJobModal(c.getAttribute('data-id'));
      });
    });
    Array.prototype.forEach.call(board.querySelectorAll('.pl-col'), function (col) {
      col.addEventListener('dragover', function (e) { e.preventDefault(); col.classList.add('drop'); });
      col.addEventListener('dragleave', function () { col.classList.remove('drop'); });
      col.addEventListener('drop', function (e) {
        e.preventDefault(); col.classList.remove('drop');
        var toStage = col.getAttribute('data-stage');
        if (!dragId) return;
        var id = dragId; dragId = null;
        Nav.api('/api/jobs/' + encodeURIComponent(id) + '/stage', { method: 'POST', body: { stage: toStage } })
          .then(function () { Hub.toast(id + ' → ' + ((res_stageMap[toStage] && res_stageMap[toStage].internalLabel) || toStage)); load(); })
          .catch(function (err) { Hub.toast(err.message); load(); });
      });
    });
  }

  var res_stageMap = {};
  var jobsById = {};

  // Popup job detail — shown on the pipeline screen (no page change).
  function row(label, val) {
    if (!val) return '';
    return '<div class="jm-row"><span class="jm-k">' + esc(label) + '</span><span class="jm-v">' + val + '</span></div>';
  }
  function openJobModal(id) {
    var j0 = jobsById[id] || { id: id };
    var m = Hub.modal(esc(j0.job_type || 'Tax Job') + ' <span class="jm-id">' + esc(id) + '</span>',
      '<div id="jmBody" class="jm-body"><p class="muted">Loading…</p></div>');
    Nav.api('/api/jobs/' + encodeURIComponent(id)).then(function (res) {
      var j = res.job || j0;
      var sl = (res_stageMap[j.stage] && res_stageMap[j.stage].internalLabel) || j.stage;
      var flags = [
        j.priority === 'high' ? '<span class="pill pill-action">High priority</span>' : '',
        j.on_hold ? '<span class="pill pill-hold">On hold</span>' : '',
        j.action_required ? '<span class="pill pill-action">Action required</span>' : '',
        (j.due_date && j0.overdue) ? '<span class="pill pill-action">Overdue</span>' : ''
      ].filter(Boolean).join(' ');
      var chk = res.checklist || [];
      var done = chk.filter(function (c) { return c.checked; }).length;
      var notes = (res.notes || []).slice(0, 3).map(function (n) {
        return '<div class="jm-note"><b>' + esc(n.author_name || n.created_by || 'Staff') + '</b> ' +
          '<span class="muted">' + Hub.fmtDate(n.created_at) + '</span><div>' + esc(n.note || '') + '</div></div>';
      }).join('') || '<p class="muted">No internal notes yet.</p>';
      var hist = (res.history || []).slice(-4).reverse().map(function (h) {
        var to = (res_stageMap[h.to_stage] && res_stageMap[h.to_stage].internalLabel) || h.to_stage;
        return '<div class="jm-hist"><span>' + esc(to) + '</span><span class="muted">' + Hub.fmtDate(h.created_at) + '</span></div>';
      }).join('');
      var html =
        '<div class="jm-stage">' + esc(sl) + '</div>' +
        (flags ? '<div class="jm-flags">' + flags + '</div>' : '') +
        row('Client', esc(j.client_name || '')) +
        row('Entity', esc((j.entity_name || '') + (j.entity_type ? ' · ' + j.entity_type : ''))) +
        row('Financial year', esc(j.financial_year || '')) +
        row('Accountant', esc(j.accountant_name || j.accountant_email || '')) +
        row('Supervisor', esc(j.supervisor_name || j.supervisor_email || '')) +
        row('Due date', j.due_date ? Hub.fmtDate(j.due_date) : '') +
        row('Next action', esc(j.next_action || '')) +
        row('Checklist', chk.length ? (done + ' / ' + chk.length + ' done') : '') +
        '<div class="jm-sec">Recent notes</div>' + notes +
        (hist ? '<div class="jm-sec">Recent activity</div>' + hist : '') +
        '<div class="jm-actions"><a class="btn btn-primary btn-sm" href="job.html?id=' + encodeURIComponent(id) + '">Open full job</a></div>';
      var body = m.q('#jmBody'); if (body) body.innerHTML = html;
    }).catch(function (e) {
      var body = m.q('#jmBody'); if (body) body.innerHTML = '<p class="muted">Could not load: ' + esc(e.message) + '</p>';
    });
  }

  function load() {
    Nav.api('/api/pipeline').then(function (res) { res_stageMap = res.stageMap || {}; render(res); })
      .catch(function (e) { board.innerHTML = '<p class="muted">Error: ' + esc(e.message) + '</p>'; });
  }

  load();
})();

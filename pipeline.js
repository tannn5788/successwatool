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
      '.pl-card{background:#fff;border:1px solid var(--border,#e2e5e9);border-radius:8px;padding:9px 10px;margin:6px 0;cursor:grab;box-shadow:0 1px 2px rgba(0,0,0,.04)}' +
      '.pl-card:active{cursor:grabbing}' +
      '.pl-card.overdue{border-color:var(--red,#c0392b);box-shadow:0 0 0 1px var(--red,#c0392b) inset}' +
      '.pl-card .t{font-weight:700;font-size:13px}' +
      '.pl-card .m{color:#667;font-size:11px;margin-top:2px}' +
      '.pl-badges{display:flex;flex-wrap:wrap;gap:3px;margin-top:5px}';
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
      (j.accountant_name ? '<div class="m">👤 ' + esc(j.accountant_name) + '</div>' : '') +
      (badges ? '<div class="pl-badges">' + badges + '</div>' : '') +
      '</div>';
  }

  function render(res) {
    injectStyles();
    var stages = res.stages || [];
    var map = res.stageMap || {};
    var byStage = {};
    stages.forEach(function (s) { byStage[s] = []; });
    (res.jobs || []).forEach(function (j) { (byStage[j.stage] = byStage[j.stage] || []).push(j); });

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
      c.addEventListener('dragstart', function () { dragId = c.getAttribute('data-id'); c.style.opacity = '0.5'; });
      c.addEventListener('dragend', function () { c.style.opacity = ''; });
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
  function load() {
    Nav.api('/api/pipeline').then(function (res) { res_stageMap = res.stageMap || {}; render(res); })
      .catch(function (e) { board.innerHTML = '<p class="muted">Error: ' + esc(e.message) + '</p>'; });
  }

  load();
})();

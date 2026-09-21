// admin.js — user/role management, email templates, audit log.
(function () {
  var auth = Nav.guard(['administrator']);
  if (!auth) return;
  Nav.renderNav('admin.html');
  var esc = Nav.esc;
  var ROLES = ['administrator', 'supervisor', 'accountant', 'reception', 'client'];
  var panel = document.getElementById('panel');

  Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (b) {
    b.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      show(b.getAttribute('data-tab'));
    });
  });

  function show(tab) {
    if (tab === 'users') return loadUsers();
    if (tab === 'announcement') return loadAnnouncement();
    if (tab === 'automations') return loadAutomations();
    if (tab === 'templates') return loadTemplates();
    if (tab === 'audit') return loadAudit();
    if (tab === 'integrations') return loadIntegrations();
  }

  // ---- Users ----
  function loadUsers() {
    panel.innerHTML = '<p class="muted">Loading…</p>';
    Nav.api('/api/admin/users').then(function (res) {
      var rows = res.users.map(function (u) {
        var roleSel = '<select class="role-select" data-role="' + esc(u.email) + '">' + ROLES.map(function (r) {
          return '<option' + (r === u.role ? ' selected' : '') + '>' + r + '</option>'; }).join('') + '</select>';
        var isSelf = u.email.toLowerCase() === auth.email.toLowerCase();
        return '<tr><td>' + esc(u.name || '') + '<br><span class="muted small">' + esc(u.email) + '</span></td>' +
          '<td>' + roleSel + '</td>' +
          '<td>' + (u.active ? '<span class="pill pill-completed">active</span>' : '<span class="pill pill-hold">disabled</span>') + '</td>' +
          '<td><button class="btn btn-xs" data-toggle="' + esc(u.email) + '|' + (u.active ? '0' : '1') + '">' + (u.active ? 'Disable' : 'Enable') + '</button>' +
          ' <button class="btn btn-xs" data-reset="' + esc(u.email) + '">Reset PW</button>' +
          (isSelf ? '' : ' <button class="btn btn-xs danger" data-del="' + esc(u.email) + '">Delete</button>') + '</td></tr>';
      }).join('');
      panel.innerHTML = '<div class="hub-head"><div></div><button class="btn btn-primary btn-sm" id="addUser">+ New User</button></div>' +
        '<table class="hub-table"><thead><tr><th>User</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
      document.getElementById('addUser').addEventListener('click', addUserModal);
      Array.prototype.forEach.call(panel.querySelectorAll('[data-role]'), function (s) {
        s.addEventListener('change', function () {
          Nav.api('/api/admin/users/' + encodeURIComponent(s.getAttribute('data-role')), { method: 'PATCH', body: { role: s.value } })
            .then(function () { Hub.toast('Role updated'); }).catch(function (e) { Hub.toast(e.message); });
        });
      });
      Array.prototype.forEach.call(panel.querySelectorAll('[data-toggle]'), function (b) {
        b.addEventListener('click', function () {
          var p = b.getAttribute('data-toggle').split('|');
          Nav.api('/api/admin/users/' + encodeURIComponent(p[0]), { method: 'PATCH', body: { active: p[1] === '1' } })
            .then(function () { Hub.toast('Updated'); loadUsers(); }).catch(function (e) { Hub.toast(e.message); });
        });
      });
      Array.prototype.forEach.call(panel.querySelectorAll('[data-del]'), function (b) {
        b.addEventListener('click', function () {
          var email = b.getAttribute('data-del');
          var m = Hub.modal('Delete user',
            '<p>Permanently delete <b>' + esc(email) + '</b>? This removes their login and cannot be undone. ' +
            'Their clients, jobs and documents are not deleted.</p>' +
            '<div class="modal-actions"><button class="btn btn-ghost" id="dCancel">Cancel</button>' +
            '<button class="btn btn-primary danger" id="dOk">Delete</button></div>');
          m.q('#dCancel').addEventListener('click', m.close);
          m.q('#dOk').addEventListener('click', function () {
            Hub.busy(m.q('#dOk'), Nav.api('/api/admin/users/' + encodeURIComponent(email), { method: 'DELETE' }))
              .then(function () { m.close(); Hub.toast('User deleted'); loadUsers(); })
              .catch(function (e) { Hub.toast(e.message); });
          });
        });
      });
      Array.prototype.forEach.call(panel.querySelectorAll('[data-reset]'), function (b) {
        b.addEventListener('click', function () {
          var email = b.getAttribute('data-reset');
          var m = Hub.modal('Send password reset',
            '<p>Email a password-reset link to <b>' + esc(email) + '</b>? ' +
            'The link lets them choose a new password and expires in 60 minutes.</p>' +
            '<div class="modal-actions"><button class="btn btn-ghost" id="rCancel">Cancel</button>' +
            '<button class="btn btn-primary" id="rOk">Send reset link</button></div>');
          m.q('#rCancel').addEventListener('click', m.close);
          m.q('#rOk').addEventListener('click', function () {
            Hub.busy(m.q('#rOk'), Nav.api('/api/admin/users/' + encodeURIComponent(email) + '/reset', { method: 'POST' }))
              .then(function () { m.close(); Hub.toast('Reset link sent'); })
              .catch(function (e) { Hub.toast(e.message); });
          });
        });
      });
    }).catch(function (e) { panel.innerHTML = '<p class="muted">Error: ' + esc(e.message) + '</p>'; });
  }

  function addUserModal() {
    var roleOpts = ROLES.map(function (r) { return '<option>' + r + '</option>'; }).join('');
    var m = Hub.modal('New User',
      '<div class="field"><label>Name</label><input id="uName"/></div>' +
      '<div class="field"><label>Email</label><input id="uEmail"/></div>' +
      '<div class="field"><label>Temporary password</label><input id="uPass"/></div>' +
      '<div class="field"><label>Role</label><select id="uRole">' + roleOpts + '</select></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" id="uCancel">Cancel</button><button class="btn btn-primary" id="uSave">Create</button></div>');
    m.q('#uCancel').addEventListener('click', m.close);
    m.q('#uSave').addEventListener('click', function () {
      Nav.api('/api/admin/users', { method: 'POST', body: {
        name: m.q('#uName').value.trim(), email: m.q('#uEmail').value.trim(),
        password: m.q('#uPass').value, role: m.q('#uRole').value } })
        .then(function () { m.close(); Hub.toast('User created'); loadUsers(); }).catch(function (e) { Hub.toast(e.message); });
    });
  }

  // ---- Templates ----
  function loadTemplates() {
    panel.innerHTML = '<p class="muted">Loading…</p>';
    Nav.api('/api/admin/templates').then(function (res) {
      panel.innerHTML = res.templates.map(function (t) {
        return '<div class="card"><h3>' + esc(t.key) + '</h3>' +
          '<div class="field"><label>Subject</label><input data-sub="' + esc(t.key) + '" value="' + esc(t.subject) + '"/></div>' +
          '<div class="field"><label>Body — use {{clientName}}, {{jobId}}, {{clientStatus}}</label><textarea data-body="' + esc(t.key) + '">' + esc(t.body) + '</textarea></div>' +
          '<button class="btn btn-primary btn-sm" data-save="' + esc(t.key) + '">Save</button></div>';
      }).join('') || '<p class="muted">No templates.</p>';
      Array.prototype.forEach.call(panel.querySelectorAll('[data-save]'), function (b) {
        b.addEventListener('click', function () {
          var k = b.getAttribute('data-save');
          Nav.api('/api/admin/templates/' + encodeURIComponent(k), { method: 'PUT', body: {
            subject: panel.querySelector('[data-sub="' + k + '"]').value,
            body: panel.querySelector('[data-body="' + k + '"]').value } })
            .then(function () { Hub.toast('Template saved'); }).catch(function (e) { Hub.toast(e.message); });
        });
      });
    }).catch(function (e) { panel.innerHTML = '<p class="muted">Error: ' + esc(e.message) + '</p>'; });
  }

  // ---- Announcement (client Home banner) ----
  function loadAnnouncement() {
    panel.innerHTML = '<p class="muted">Loading…</p>';
    Nav.api('/api/admin/announcement').then(function (res) {
      var a = res.announcement || { enabled: false, title: '', body: '' };
      panel.innerHTML =
        '<div class="card" style="max-width:640px">' +
        '<div class="section-title">Client Home announcement</div>' +
        '<p class="muted small">Shown as a banner on every client\u2019s Home page. Leave disabled to hide it.</p>' +
        '<label style="display:flex;align-items:center;gap:8px;margin:10px 0">' +
        '<input type="checkbox" id="anEnabled"' + (a.enabled ? ' checked' : '') + '> <b>Show this announcement to clients</b></label>' +
        '<label class="field"><span>Title</span>' +
        '<input type="text" id="anTitle" maxlength="200" value="' + esc(a.title || '') + '" placeholder="e.g. Tax season deadlines"></label>' +
        '<label class="field" style="margin-top:10px"><span>Message</span>' +
        '<textarea id="anBody" rows="5" maxlength="2000" placeholder="Write your announcement here…">' + esc(a.body || '') + '</textarea></label>' +
        '<div class="modal-actions" style="justify-content:flex-start;margin-top:12px">' +
        '<button class="btn btn-primary btn-sm" id="anSave">Save announcement</button></div>' +
        '</div>';
      document.getElementById('anSave').addEventListener('click', function () {
        Nav.api('/api/admin/announcement', { method: 'PUT', body: {
          enabled: document.getElementById('anEnabled').checked,
          title: document.getElementById('anTitle').value,
          body: document.getElementById('anBody').value } })
          .then(function () { Hub.toast('Announcement saved'); }).catch(function (e) { Hub.toast(e.message); });
      });
    }).catch(function (e) { panel.innerHTML = '<p class="muted">Error: ' + esc(e.message) + '</p>'; });
  }

  // ---- Automations (multi-trigger rules + SLA limits) ----
  var ACTION_LABELS = {
    notify_client: 'Email the client (template) — email pending',
    set_action_required: 'Flag job as Action Required',
    clear_action_required: 'Clear Action Required flag',
    add_note: 'Add an internal note',
    notify_staff: 'Notify a staff member (bell)',
  };
  var JOB_ONLY_ACTIONS = ['set_action_required', 'clear_action_required', 'add_note'];
  function loadAutomations() {
    panel.innerHTML = '<p class="muted">Loading…</p>';
    Nav.api('/api/admin/automations').then(function (res) {
      var stages = res.stages || [];
      var map = res.stageMap || {};
      var triggers = res.triggers || [{ type: 'stage_enter', label: 'Job enters a stage', key: 'stage' }];
      var triggerLabel = {}; triggers.forEach(function (t) { triggerLabel[t.type] = t.label; });
      var limitByStage = {}; (res.limits || []).forEach(function (l) { limitByStage[l.stage] = l.limit_days; });
      var stageOpts = stages.map(function (s) {
        return '<option value="' + esc(s) + '">' + esc((map[s] && map[s].internalLabel) || s) + '</option>';
      }).join('');
      var triggerOpts = triggers.map(function (t) {
        return '<option value="' + esc(t.type) + '">' + esc(t.label) + '</option>';
      }).join('');
      var actionOpts = Object.keys(ACTION_LABELS).map(function (a) {
        return '<option value="' + a + '">' + esc(ACTION_LABELS[a]) + '</option>';
      }).join('');

      // Human description of what fires a rule.
      function triggerDesc(r) {
        var tt = r.trigger_type || 'stage_enter';
        if (tt === 'stage_enter') {
          var s = r.trigger_key || r.stage;
          return esc(triggerLabel[tt] || tt) + ' · ' + esc((map[s] && map[s].internalLabel) || s || '?');
        }
        if (tt === 'job_created' && r.trigger_key) return esc(triggerLabel[tt] || tt) + ' · ' + esc(r.trigger_key);
        return esc(triggerLabel[tt] || tt);
      }

      var ruleRows = (res.rules || []).map(function (r) {
        var cfg = r.config || {};
        var detail = r.action === 'add_note' ? esc(cfg.note || '')
          : r.action === 'notify_staff' ? esc((cfg.email || '') + (cfg.note ? ' — ' + cfg.note : ''))
          : r.action === 'notify_client' ? esc('template: ' + (cfg.templateKey || '')) : '';
        return '<tr><td>' + triggerDesc(r) + '</td>' +
          '<td>' + esc(ACTION_LABELS[r.action] || r.action) + '<div class="muted small">' + detail + '</div></td>' +
          '<td>' + (r.enabled ? '<span class="pill pill-completed">on</span>' : '<span class="pill pill-hold">off</span>') + '</td>' +
          '<td><button class="btn btn-xs" data-toggle-rule="' + r.id + '|' + (r.enabled ? '0' : '1') + '">' + (r.enabled ? 'Disable' : 'Enable') + '</button> ' +
          '<button class="btn btn-xs danger" data-del-rule="' + r.id + '">Delete</button></td></tr>';
      }).join('') || '<tr><td colspan="4" class="muted small">No automation rules yet.</td></tr>';

      var limitRows = stages.map(function (s) {
        return '<tr><td>' + esc((map[s] && map[s].internalLabel) || s) + '</td>' +
          '<td><input type="number" min="0" class="lim-input" data-stage="' + esc(s) + '" value="' + (limitByStage[s] || 0) + '" style="width:80px"> days</td>' +
          '<td><button class="btn btn-xs" data-save-lim="' + esc(s) + '">Save</button></td></tr>';
      }).join('');

      panel.innerHTML =
        '<div class="card" style="margin-bottom:16px">' +
          '<div class="section-title">Automation rules</div>' +
          '<p class="muted small">When the chosen <b>event</b> happens, run these actions automatically.</p>' +
          '<table class="hub-table"><thead><tr><th>Trigger</th><th>Action</th><th>Status</th><th></th></tr></thead><tbody>' + ruleRows + '</tbody></table>' +
          '<div style="margin-top:14px;border-top:1px solid var(--border);padding-top:12px">' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">' +
              '<label class="field" style="margin:0"><span>Trigger</span><select id="arTrigger">' + triggerOpts + '</select></label>' +
              '<label class="field" style="margin:0" id="arStageWrap"><span id="arKeyLabel">Stage</span><select id="arStage">' + stageOpts + '</select></label>' +
              '<label class="field" style="margin:0;display:none" id="arKeyWrap"><span>Job type (optional)</span><input type="text" id="arKey" placeholder="blank = any"></label>' +
              '<label class="field" style="margin:0"><span>Action</span><select id="arAction">' + actionOpts + '</select></label>' +
              '<label class="field" style="margin:0;flex:1;min-width:200px"><span id="arCfgLabel">Detail</span><input type="text" id="arCfg" placeholder="note text / staff email / template key"></label>' +
              '<button class="btn btn-primary btn-sm" id="arAdd">Add rule</button>' +
            '</div>' +
            '<p class="muted small" id="arWarn" style="margin-top:8px;display:none;color:var(--red)"></p>' +
          '</div>' +
        '</div>' +
        '<div class="card">' +
          '<div class="section-title">Stage time limits (SLA)</div>' +
          '<p class="muted small">If a job sits in a stage longer than this many days, it is highlighted as overdue on the Pipeline board. 0 = no limit.</p>' +
          '<table class="hub-table"><thead><tr><th>Stage</th><th>Limit</th><th></th></tr></thead><tbody>' + limitRows + '</tbody></table>' +
        '</div>';

      // Show the right "key" field for the selected trigger.
      var triggerHint = function () {
        var tt = document.getElementById('arTrigger').value;
        document.getElementById('arStageWrap').style.display = (tt === 'stage_enter') ? '' : 'none';
        document.getElementById('arKeyWrap').style.display = (tt === 'job_created') ? '' : 'none';
      };
      document.getElementById('arTrigger').addEventListener('change', function () { triggerHint(); actionWarn(); });

      var cfgHint = function () {
        var a = document.getElementById('arAction').value;
        var lbl = document.getElementById('arCfgLabel');
        var inp = document.getElementById('arCfg');
        if (a === 'add_note') { lbl.textContent = 'Note text'; inp.placeholder = 'e.g. Auto: prep started'; inp.style.display = ''; }
        else if (a === 'notify_staff') { lbl.textContent = 'Staff email'; inp.placeholder = 'e.g. supervisor@successwa.com'; inp.style.display = ''; }
        else if (a === 'notify_client') { lbl.textContent = 'Template key'; inp.placeholder = 'e.g. documents_received'; inp.style.display = ''; }
        else { lbl.textContent = 'No detail needed'; inp.value = ''; inp.style.display = 'none'; }
      };
      // Warn when a job-only action is picked with the client_created trigger.
      var actionWarn = function () {
        var tt = document.getElementById('arTrigger').value;
        var a = document.getElementById('arAction').value;
        var warn = document.getElementById('arWarn');
        if (tt === 'client_created' && JOB_ONLY_ACTIONS.indexOf(a) !== -1) {
          warn.textContent = 'That action needs a job. On "Client is created", use "Notify a staff member".';
          warn.style.display = '';
        } else { warn.style.display = 'none'; }
      };
      document.getElementById('arAction').addEventListener('change', function () { cfgHint(); actionWarn(); });
      triggerHint(); cfgHint();

      document.getElementById('arAdd').addEventListener('click', function () {
        var triggerType = document.getElementById('arTrigger').value;
        var action = document.getElementById('arAction').value;
        var val = document.getElementById('arCfg').value;
        var config = {};
        if (action === 'add_note') config.note = val;
        else if (action === 'notify_staff') config.email = val;
        else if (action === 'notify_client') config.templateKey = val;
        var triggerKey = triggerType === 'stage_enter' ? document.getElementById('arStage').value
          : triggerType === 'job_created' ? document.getElementById('arKey').value : '';
        Nav.api('/api/admin/automations', { method: 'POST', body: {
          triggerType: triggerType, triggerKey: triggerKey, action: action, config: config } })
          .then(function () { Hub.toast('Rule added'); loadAutomations(); }).catch(function (e) { Hub.toast(e.message); });
      });
      Array.prototype.forEach.call(panel.querySelectorAll('[data-toggle-rule]'), function (b) {
        b.addEventListener('click', function () {
          var p = b.getAttribute('data-toggle-rule').split('|');
          Nav.api('/api/admin/automations/' + p[0], { method: 'PATCH', body: { enabled: p[1] === '1' } })
            .then(function () { loadAutomations(); }).catch(function (e) { Hub.toast(e.message); });
        });
      });
      Array.prototype.forEach.call(panel.querySelectorAll('[data-del-rule]'), function (b) {
        b.addEventListener('click', function () {
          Nav.api('/api/admin/automations/' + b.getAttribute('data-del-rule'), { method: 'DELETE' })
            .then(function () { Hub.toast('Rule deleted'); loadAutomations(); }).catch(function (e) { Hub.toast(e.message); });
        });
      });
      Array.prototype.forEach.call(panel.querySelectorAll('[data-save-lim]'), function (b) {
        b.addEventListener('click', function () {
          var s = b.getAttribute('data-save-lim');
          var inp = panel.querySelector('.lim-input[data-stage="' + s + '"]');
          Nav.api('/api/admin/stage-limits/' + encodeURIComponent(s), { method: 'PUT', body: { limitDays: Number(inp.value) || 0 } })
            .then(function () { Hub.toast('Limit saved'); }).catch(function (e) { Hub.toast(e.message); });
        });
      });
    }).catch(function (e) { panel.innerHTML = '<p class="muted">Error: ' + esc(e.message) + '</p>'; });
  }

  // ---- Audit ----
  function loadAudit() {
    panel.innerHTML = '<p class="muted">Loading…</p>';
    Nav.api('/api/admin/audit').then(function (res) {
      var rows = (res.audit || []).map(function (a) {
        return '<tr><td class="muted small">' + Hub.fmtDate(a.created_at) + '</td><td>' + esc(a.actor_email || 'system') + '</td>' +
          '<td>' + esc(a.action) + '</td><td class="muted small">' + esc((a.entity_type || '') + ' ' + (a.entity_id || '')) + '</td></tr>';
      }).join('');
      panel.innerHTML = '<table class="hub-table"><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }).catch(function (e) { panel.innerHTML = '<p class="muted">Error: ' + esc(e.message) + '</p>'; });
  }

  // ---- Integrations (Google Drive) ----
  function loadIntegrations() {
    panel.innerHTML = '<p class="muted">Loading…</p>';
    Nav.api('/api/google/status').then(function (res) {
      var s = res.status || {};
      var body;
      if (!s.configured) {
        body = '<p class="muted">Google Drive is not configured on the server yet. ' +
          'Add <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code> and ' +
          '<code>GOOGLE_REDIRECT_URI</code> to the server environment, then reload.</p>';
      } else if (s.connected) {
        body = '<p><span class="pill pill-completed">Connected</span>' +
          (s.email ? ' as <b>' + esc(s.email) + '</b>' : '') + '</p>' +
          '<p class="muted small">Uploaded documents are backed up to the Google Drive folder ' +
          '<b>' + esc(s.folderName || 'Successwa Documents') + '</b>, grouped by client.</p>' +
          '<div class="modal-actions" style="justify-content:flex-start"><button class="btn btn-sm danger" id="gdDisc">Disconnect</button></div>';
      } else {
        body = '<p><span class="pill pill-hold">Not connected</span></p>' +
          '<p class="muted small">Connect the firm\u2019s Google account once. New uploads will then be ' +
          'automatically backed up to Google Drive.</p>' +
          '<div class="modal-actions" style="justify-content:flex-start"><button class="btn btn-primary btn-sm" id="gdConn">Connect Google Drive</button></div>';
      }
      panel.innerHTML = '<div class="card" style="max-width:640px"><h3 style="margin-top:0">Google Drive</h3>' + body + '</div>';

      var conn = document.getElementById('gdConn');
      if (conn) conn.addEventListener('click', function () {
        Hub.busy(conn, Nav.api('/api/google/auth-url')).then(function (r) {
          window.location.href = r.url;
        }).catch(function (e) { Hub.toast(e.message); });
      });
      var disc = document.getElementById('gdDisc');
      if (disc) disc.addEventListener('click', function () {
        var m = Hub.modal('Disconnect Google Drive',
          '<p>Stop backing up new uploads to Google Drive? Existing files on Drive are not removed.</p>' +
          '<div class="modal-actions"><button class="btn btn-ghost" id="dCancel">Cancel</button>' +
          '<button class="btn danger" id="dOk">Disconnect</button></div>');
        m.q('#dCancel').addEventListener('click', m.close);
        m.q('#dOk').addEventListener('click', function () {
          Hub.busy(m.q('#dOk'), Nav.api('/api/google/disconnect', { method: 'POST' }))
            .then(function () { m.close(); Hub.toast('Disconnected'); loadIntegrations(); })
            .catch(function (e) { Hub.toast(e.message); });
        });
      });
    }).catch(function (e) { panel.innerHTML = '<p class="muted">Error: ' + esc(e.message) + '</p>'; });
  }

  // Handle the OAuth callback redirect (/admin?drive=connected|error): open the tab + toast.
  (function () {
    var m = /[?&]drive=([^&]+)/.exec(window.location.search);
    if (!m) return;
    var status = m[1];
    // Clean the URL so a refresh doesn't repeat the toast.
    try { history.replaceState(null, '', window.location.pathname); } catch (e) {}
    var btn = document.querySelector('[data-tab="integrations"]');
    if (btn) btn.click();
    if (status === 'connected') Hub.toast('Google Drive connected');
    else Hub.toast('Google Drive connection failed');
  })();

  loadUsers();
})();

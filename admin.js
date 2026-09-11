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

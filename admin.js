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
  }

  // ---- Users ----
  function loadUsers() {
    panel.innerHTML = '<p class="muted">Loading…</p>';
    Nav.api('/api/admin/users').then(function (res) {
      var rows = res.users.map(function (u) {
        var roleSel = '<select data-role="' + esc(u.email) + '">' + ROLES.map(function (r) {
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

  loadUsers();
})();

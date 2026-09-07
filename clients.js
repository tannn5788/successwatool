// clients.js — manage clients + entities, create jobs.
(function () {
  var auth = Nav.guard(Nav.STAFF);
  if (!auth) return;
  Nav.renderNav('clients.html');

  var $ = function (id) { return document.getElementById(id); };
  var esc = Nav.esc;
  var canCreateJob = auth.role === 'reception' || auth.role === 'administrator';

  Hub.guide('clients', auth.role, {
    reception: { em: '🗂️', title: 'Reception — manage clients & open jobs', text: 'Use <b>+ New Client</b> to add a client (their email is their portal login). Add entities with <b>+ Entity</b>, then click <b>+ Job</b> on an entity to open a job and assign an accountant & supervisor. Expand an entity to see its jobs.' },
    administrator: { em: '⚙️', title: 'Administrator — clients & jobs', text: 'Add and edit clients/entities, and open jobs with <b>+ Job</b> (assign an accountant & supervisor). Expand an entity to see its jobs and who is working on them.' },
    supervisor: { em: '✅', title: 'Supervisor — client overview', text: 'Browse clients and expand any entity to see its jobs and assigned staff. Open a job to review or reassign staff.' },
    accountant: { em: '🧮', title: 'Accountant — client reference', text: 'Look up client and entity details here. Expand an entity to see its jobs; open a job assigned to you to keep working on it.' },
  });

  var timer = null;
  function debounce(fn) { clearTimeout(timer); timer = setTimeout(fn, 250); }

  function load() {
    var q = $('q').value.trim();
    Nav.api('/api/clients' + (q ? '?q=' + encodeURIComponent(q) : ''))
      .then(function (res) { return renderClients(res.clients || []); })
      .catch(function (e) { $('listWrap').innerHTML = '<p class="muted">Error: ' + esc(e.message) + '</p>'; });
  }

  function renderClients(clients) {
    if (!clients.length) { $('listWrap').innerHTML = '<div class="card"><p class="muted">No clients yet.</p></div>'; return; }
    Promise.all(clients.map(function (c) {
      return Promise.all([
        Nav.api('/api/entities?clientId=' + encodeURIComponent(c.id)),
        Nav.api('/api/jobs?clientId=' + encodeURIComponent(c.id))
      ]).then(function (rs) {
        return { client: c, entities: rs[0].entities || [], jobs: rs[1].jobs || [] };
      });
    })).then(function (list) {
      $('listWrap').innerHTML = list.map(function (item) {
        var c = item.client;
        var jobsByEntity = {};
        (item.jobs || []).forEach(function (j) {
          (jobsByEntity[j.entity_id] = jobsByEntity[j.entity_id] || []).push(j);
        });
        function jobRows(entId) {
          var js = jobsByEntity[entId] || [];
          if (!js.length) return '';
          var rows = js.map(function (j) {
            var acc = j.accountant_name || j.accountant_email || '—';
            var sup = j.supervisor_name || j.supervisor_email || '—';
            return '<div class="job-line">' +
              '<a href="job.html?id=' + esc(j.id) + '" class="job-tag">' + esc(j.id) + '</a>' +
              '<span class="job-line-type">' + esc(j.job_type || '—') + '</span>' +
              '<span class="muted small">Acc: ' + esc(acc) + ' · Sup: ' + esc(sup) + '</span>' +
              '<span class="' + Hub.pillClass(j.stage_label || '') + '" style="margin-left:auto">' + esc(j.stage_label || j.stage || '') + '</span>' +
              '</div>';
          }).join('');
          return '<tr class="job-subrow" id="jobs-' + esc(entId) + '" style="display:none"><td colspan="5" style="padding:4px 12px 10px 24px;border-top:none">' + rows + '</td></tr>';
        }
        var ents = item.entities.map(function (e) {
          var jc = (jobsByEntity[e.id] || []).length;
          var toggle = jc ?
            '<button class="btn btn-ghost btn-xs job-toggle" data-toggle="' + esc(e.id) + '" data-tip="Show or hide the jobs for this entity, including who is assigned.">▸ ' + jc + ' job' + (jc > 1 ? 's' : '') + '</button>'
            : '<span class="muted small">No jobs</span>';
          return '<tr><td>' + esc(e.id) + '</td>' +
            '<td>' + esc(e.entity_name) + ' ' + toggle + '</td>' +
            '<td><span class="pill pill-inprogress">' + esc(e.entity_type) + '</span></td>' +
            '<td>' + esc(e.abn || '—') + '</td>' +
            (canCreateJob ? '<td><button class="btn btn-xs" data-job="' + esc(c.id) + '|' + esc(e.id) + '" data-tip="Open a new job for this entity and assign an accountant & supervisor.">+ Job</button></td>' : '<td></td>') +
            '</tr>' + jobRows(e.id);
        }).join('');
        return '<div class="card"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">' +
          '<div><h3>' + esc(c.name) + ' <span class="muted small">' + esc(c.id) + '</span></h3>' +
          '<p class="muted small">' + esc(c.email || 'no email') + ' · ' + esc(c.phone || 'no phone') + '</p></div>' +
          '<div style="display:flex;gap:8px">' +
          '<button class="btn btn-ghost btn-sm" data-editclient="' + esc(c.id) + '" data-tip="Edit this client\'s name, email and phone. The email is their portal login.">Edit</button>' +
          '<button class="btn btn-outline btn-sm" data-ent="' + esc(c.id) + '" data-tip="Add another entity (individual, company, trust) under this client.">+ Entity</button></div></div>' +
          (item.entities.length ?
            '<table class="hub-table" style="margin-top:12px"><thead><tr><th>Entity ID</th><th>Name</th><th>Type</th><th>ABN</th><th></th></tr></thead><tbody>' + ents + '</tbody></table>'
            : '<p class="muted small" style="margin-top:10px">No entities yet.</p>') +
          '</div>';
      }).join('');
      bindRowButtons(list);
    });
  }

  function bindRowButtons(list) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-ent]'), function (b) {
      b.addEventListener('click', function () { entityModal(b.getAttribute('data-ent')); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-toggle]'), function (b) {
      b.addEventListener('click', function () {
        var row = document.getElementById('jobs-' + b.getAttribute('data-toggle'));
        if (!row) return;
        var open = row.style.display === 'none';
        row.style.display = open ? 'table-row' : 'none';
        b.textContent = (open ? '▾ ' : '▸ ') + b.textContent.replace(/^[▸▾]\s*/, '');
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-job]'), function (b) {
      b.addEventListener('click', function () {
        var parts = b.getAttribute('data-job').split('|');
        jobModal(parts[0], parts[1]);
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-editclient]'), function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-editclient');
        var found = null;
        (list || []).forEach(function (it) { if (it.client.id === id) found = it.client; });
        if (found) editClientModal(found);
      });
    });
  }

  // ---- Edit client ----
  function editClientModal(c) {
    var m = Hub.modal('Edit Client ' + c.id,
      '<div class="field"><label>Full name / business name</label><input id="uName" value="' + esc(c.name || '') + '"/></div>' +
      '<div class="field"><label>Email (used for their portal login &amp; notifications)</label><input id="uEmail" value="' + esc(c.email || '') + '"/></div>' +
      '<div class="field"><label>Phone</label><input id="uPhone" value="' + esc(c.phone || '') + '"/></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" id="uCancel">Cancel</button><button class="btn btn-primary" id="uSave">Save changes</button></div>');
    m.q('#uCancel').addEventListener('click', m.close);
    m.q('#uSave').addEventListener('click', function () {
      var name = m.q('#uName').value.trim();
      if (!name) { Hub.toast('Name required'); return; }
      Hub.busy(m.q('#uSave'), Nav.api('/api/clients/' + encodeURIComponent(c.id), { method: 'PATCH', body: {
        name: name, email: m.q('#uEmail').value.trim(), phone: m.q('#uPhone').value.trim() } }))
        .then(function () { m.close(); Hub.toast('Client updated'); load(); })
        .catch(function (e) { Hub.toast(e.message); });
    });
  }

  // ---- New client ----
  $('newClientBtn').addEventListener('click', function () {
    var m = Hub.modal('New Client',
      '<div class="field"><label>Full name / business name</label><input id="cName" placeholder="Jane Smith"/></div>' +
      '<div class="field"><label>Email (used for their portal login)</label><input id="cEmail" placeholder="jane@example.com"/></div>' +
      '<div class="field"><label>Phone</label><input id="cPhone" placeholder="0400 000 000"/></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" id="cCancel">Cancel</button><button class="btn btn-primary" id="cSave">Create</button></div>');
    m.q('#cCancel').addEventListener('click', m.close);
    m.q('#cSave').addEventListener('click', function () {
      var name = m.q('#cName').value.trim();
      if (!name) { Hub.toast('Name required'); return; }
      Nav.api('/api/clients', { method: 'POST', body: { name: name, email: m.q('#cEmail').value.trim(), phone: m.q('#cPhone').value.trim() } })
        .then(function () { m.close(); Hub.toast('Client created'); load(); })
        .catch(function (e) { Hub.toast(e.message); });
    });
  });

  // ---- New entity ----
  function entityModal(clientId) {
    var opts = ['individual', 'company', 'trust', 'smsf'].map(function (t) { return '<option value="' + t + '">' + t + '</option>'; }).join('');
    var m = Hub.modal('New Entity for ' + clientId,
      '<div class="field"><label>Entity name</label><input id="eName" placeholder="Smith Family Trust"/></div>' +
      '<div class="field"><label>Entity type</label><select id="eType">' + opts + '</select></div>' +
      '<div class="field-row"><div class="field"><label>ABN</label><input id="eAbn"/></div>' +
      '<div class="field"><label>TFN</label><input id="eTfn"/></div></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" id="eCancel">Cancel</button><button class="btn btn-primary" id="eSave">Create</button></div>');
    m.q('#eCancel').addEventListener('click', m.close);
    m.q('#eSave').addEventListener('click', function () {
      var name = m.q('#eName').value.trim();
      if (!name) { Hub.toast('Entity name required'); return; }
      Nav.api('/api/entities', { method: 'POST', body: {
        clientId: clientId, entityName: name, entityType: m.q('#eType').value,
        abn: m.q('#eAbn').value.trim(), tfn: m.q('#eTfn').value.trim() } })
        .then(function () { m.close(); Hub.toast('Entity created'); load(); })
        .catch(function (e) { Hub.toast(e.message); });
    });
  }

  // ---- New job ----
  function jobModal(clientId, entityId) {
    Nav.api('/api/staff').then(function (res) {
      var staff = res.staff || [];
      function opts(roles) {
        var list = staff.filter(function (s) { return roles.indexOf(s.role) !== -1; });
        return '<option value="">— Unassigned —</option>' + list.map(function (s) {
          return '<option value="' + esc(s.email) + '">' + esc((s.name ? s.name + ' · ' : '') + s.email + ' (' + s.role + ')') + '</option>';
        }).join('');
      }
      var m = Hub.modal('New Job',
        '<p class="muted small">Client ' + clientId + ' · Entity ' + entityId + '</p>' +
        '<div class="field"><label>Job type</label><input id="jType" placeholder="Individual Tax Return"/></div>' +
        '<div class="field"><label>Financial year</label><input id="jFy" placeholder="FY2024-25"/></div>' +
        '<div class="field"><label>Accountant</label><select id="jAcc">' + opts(['accountant']) + '</select></div>' +
        '<div class="field"><label>Supervisor</label><select id="jSup">' + opts(['supervisor']) + '</select></div>' +
        '<div class="modal-actions"><button class="btn btn-ghost" id="jCancel">Cancel</button><button class="btn btn-primary" id="jSave">Create Job</button></div>');
      m.q('#jCancel').addEventListener('click', m.close);
      m.q('#jSave').addEventListener('click', function () {
        Hub.busy(m.q('#jSave'), Nav.api('/api/jobs', { method: 'POST', body: {
          clientId: clientId, entityId: entityId, jobType: m.q('#jType').value.trim(),
          financialYear: m.q('#jFy').value.trim(), accountant: m.q('#jAcc').value, supervisor: m.q('#jSup').value } }))
          .then(function (r) { m.close(); Hub.toast('Job ' + r.id + ' created'); location.href = 'job.html?id=' + encodeURIComponent(r.id); })
          .catch(function (e) { Hub.toast(e.message); });
      });
    }).catch(function (e) { Hub.toast(e.message); });
  }

  $('q').addEventListener('input', function () { debounce(load); });
  load();
})();

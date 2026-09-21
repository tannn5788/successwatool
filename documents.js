// documents.js — client-only document library organised into folders.
// The firm pre-creates a tax-year root ("2027 Tax") with standard sub-folders
// (Income, Deductions, Rental Property, Shares & Crypto, Business, Other).
// Clients can open a folder, upload files into it, create their own sub-folders
// (within limits) and delete only their own custom folders. Standard folders are
// protected. NEVER shows staff names, internal notes or other clients' data.
(function () {
  var auth = Nav.guard(['client']);
  if (!auth) return;
  Nav.renderNav('documents.html');
  var esc = Nav.esc;
  var panel = document.getElementById('panel');

  Hub.guide('documents', auth.role, {
    client: {
      em: '📁',
      title: 'Your document library',
      text: 'Your documents are organised into folders by tax year. Open a folder to view or upload files. You can also create your own sub-folders to keep things tidy.',
    },
  });

  var folders = [];          // flat list from the server
  var current = null;        // currently opened folder id (null = top / root view)

  function byId(id) { for (var i = 0; i < folders.length; i++) { if (folders[i].id === id) return folders[i]; } return null; }
  function childrenOf(pid) { return folders.filter(function (f) { return f.parent_id === pid; }); }
  function rootFolder() { return folders.filter(function (f) { return f.parent_id === null; })[0] || null; }

  function icon(f) { return f.is_system ? '📁' : '🗂️'; }

  // ---------- rendering ----------
  function crumbTrail(folder) {
    // Build path from root down to folder.
    var chain = [];
    var cur = folder;
    while (cur) { chain.unshift(cur); cur = cur.parent_id ? byId(cur.parent_id) : null; }
    var parts = ['<a href="#" data-nav="root">Library</a>'];
    for (var i = 0; i < chain.length; i++) {
      var f = chain[i];
      if (i === chain.length - 1) parts.push('<span>' + esc(f.name) + '</span>');
      else parts.push('<a href="#" data-nav="' + f.id + '">' + esc(f.name) + '</a>');
    }
    return '<div class="crumbs" style="margin-bottom:14px;font-size:14px;color:var(--muted,#667)">' +
      parts.join(' <span style="opacity:.5">/</span> ') + '</div>';
  }

  function folderCard(f) {
    return '<button class="folder-card" data-open="' + f.id + '" ' +
      'style="display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:var(--surface-2,#f6f7f9);' +
      'border:1px solid var(--border,#e5e7eb);border-radius:12px;padding:14px 16px;cursor:pointer;margin-bottom:10px">' +
      '<span style="font-size:22px">' + icon(f) + '</span>' +
      '<span style="flex:1"><b style="display:block">' + esc(f.name) + '</b>' +
        '<span class="muted small">' + f.doc_count + ' file' + (f.doc_count === 1 ? '' : 's') + '</span></span>' +
      '<span style="opacity:.4;font-size:18px">›</span>' +
      '</button>';
  }

  function renderRoot() {
    current = null;
    var root = rootFolder();
    if (!root) { panel.innerHTML = '<div class="card"><p class="muted">No folders yet.</p></div>'; return; }
    var kids = childrenOf(root.id);
    var html = '<div class="card">' +
      '<div class="hub-head" style="margin-bottom:6px"><div><h2 style="margin:0">' + esc(root.name) + '</h2>' +
        '<p class="page-sub" style="margin:2px 0 0">Standard folders for this tax year</p></div>' +
        '<button class="btn btn-outline btn-sm" data-open="' + root.id + '">Open</button></div>' +
      '<div style="margin-top:14px">' + kids.map(folderCard).join('') + '</div>' +
      '</div>';
    panel.innerHTML = html;
    bind();
  }

  function renderFolder(id) {
    current = id;
    var f = byId(id);
    if (!f) { renderRoot(); return; }
    panel.innerHTML = crumbTrail(f) +
      '<div class="card"><p class="muted">Loading…</p></div>';
    Nav.api('/api/portal/folders/' + id + '/documents').then(function (r) {
      var docs = r.documents || [];
      var subs = childrenOf(id);
      var html = crumbTrail(f);
      html += '<div class="card">';
      html += '<div class="hub-head" style="margin-bottom:6px"><div><h2 style="margin:0">' + icon(f) + ' ' + esc(f.name) + '</h2>' +
        '<p class="page-sub" style="margin:2px 0 0">' + docs.length + ' file' + (docs.length === 1 ? '' : 's') +
        (subs.length ? ' · ' + subs.length + ' sub-folder' + (subs.length === 1 ? '' : 's') : '') + '</p></div>' +
        '<div style="display:flex;gap:8px">' +
          '<button class="btn btn-outline btn-sm" id="newSub">+ Sub-folder</button>' +
          '<button class="btn btn-primary btn-sm" id="uploadBtn">Upload file</button>' +
          (f.is_system ? '' : '<button class="btn btn-ghost btn-sm" id="delFolder" style="color:#c0392b">Delete folder</button>') +
        '</div></div>';

      // sub-folders
      if (subs.length) html += '<div style="margin-top:14px">' + subs.map(folderCard).join('') + '</div>';

      // documents
      html += '<div style="margin-top:14px">';
      if (!docs.length) {
        html += '<p class="muted small">No files in this folder yet.</p>';
      } else {
        html += '<div class="doc-list">';
        docs.forEach(function (d) {
          html += '<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--border,#eef0f2)">' +
            '<span style="font-size:20px">📄</span>' +
            '<span style="flex:1"><b style="display:block;word-break:break-all">' + esc(d.filename) + '</b>' +
              '<span class="muted small">' + esc(d.category || 'Other') + ' · ' + Hub.fmtDateTime(d.created_at) + '</span></span>' +
            '<span class="pill pill-info" style="text-transform:capitalize">' + esc(d.status || 'received') + '</span>' +
            '</div>';
        });
        html += '</div>';
      }
      html += '</div></div>';
      panel.innerHTML = html;
      bind();
    }).catch(function (e) {
      panel.innerHTML = crumbTrail(f) + '<div class="card"><p class="muted">Error: ' + esc(e.message) + '</p></div>';
      bind();
    });
  }

  // ---------- actions ----------
  function uploadModal(folderId) {
    var cats = Hub.DOC_CATEGORIES.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('');
    var m = Hub.modal('Upload a file', '' +
      '<div class="field"><label>Category</label><select id="mCat">' + cats + '</select></div>' +
      '<div class="field"><label>File</label><input id="mFile" type="file"/></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancel</button>' +
        '<button class="btn btn-primary" id="mSend">Upload</button></div>');
    m.q('#mCancel').addEventListener('click', m.close);
    m.q('#mSend').addEventListener('click', function (ev) {
      var fileEl = m.q('#mFile');
      if (!fileEl.files || !fileEl.files.length) { Hub.toast('Please choose a file'); return; }
      var fd = new FormData();
      fd.append('file', fileEl.files[0]);
      fd.append('category', m.q('#mCat').value);
      var p = fetch('/api/portal/folders/' + folderId + '/upload', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + auth.token },
        body: fd,
      }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Upload failed'); return j; }); });
      Hub.busy(ev.target, p).then(function () {
        m.close(); Hub.toast('File uploaded'); reload(function () { renderFolder(folderId); });
      }).catch(function (e) { Hub.toast(e.message); });
    });
  }

  function newSubModal(parentId) {
    var m = Hub.modal('New sub-folder', '' +
      '<div class="field"><label>Folder name</label><input id="mName" type="text" placeholder="e.g. 2027 Payslips" maxlength="60"/></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancel</button>' +
        '<button class="btn btn-primary" id="mSave">Create</button></div>');
    m.q('#mCancel').addEventListener('click', m.close);
    m.q('#mSave').addEventListener('click', function (ev) {
      var name = m.q('#mName').value.trim();
      if (!name) { Hub.toast('Please enter a name'); return; }
      var p = Nav.api('/api/portal/folders', { method: 'POST', body: { parentId: parentId, name: name } });
      Hub.busy(ev.target, p).then(function () {
        m.close(); Hub.toast('Folder created'); reload(function () { renderFolder(parentId); });
      }).catch(function (e) { Hub.toast(e.message); });
    });
  }

  function deleteFolder(id) {
    var f = byId(id);
    if (!f) return;
    var m = Hub.modal('Delete folder', '' +
      '<p>Delete <b>' + esc(f.name) + '</b>? Any files inside will be kept and moved out of the folder.</p>' +
      '<div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancel</button>' +
        '<button class="btn btn-primary" id="mDel" style="background:#c0392b">Delete</button></div>');
    m.q('#mCancel').addEventListener('click', m.close);
    m.q('#mDel').addEventListener('click', function (ev) {
      var p = Nav.api('/api/portal/folders/' + id, { method: 'DELETE' });
      Hub.busy(ev.target, p).then(function () {
        m.close(); Hub.toast('Folder deleted');
        var parent = f.parent_id;
        reload(function () { parent ? renderFolder(parent) : renderRoot(); });
      }).catch(function (e) { Hub.toast(e.message); });
    });
  }

  // ---------- wiring ----------
  function bind() {
    Array.prototype.forEach.call(panel.querySelectorAll('[data-open]'), function (b) {
      b.addEventListener('click', function () { renderFolder(Number(b.getAttribute('data-open'))); });
    });
    Array.prototype.forEach.call(panel.querySelectorAll('[data-nav]'), function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        var v = a.getAttribute('data-nav');
        if (v === 'root') renderRoot(); else renderFolder(Number(v));
      });
    });
    var up = panel.querySelector('#uploadBtn'); if (up) up.addEventListener('click', function () { uploadModal(current); });
    var ns = panel.querySelector('#newSub'); if (ns) ns.addEventListener('click', function () { newSubModal(current); });
    var df = panel.querySelector('#delFolder'); if (df) df.addEventListener('click', function () { deleteFolder(current); });
  }

  function reload(then) {
    Nav.api('/api/portal/folders').then(function (r) {
      folders = r.folders || [];
      if (then) then();
    }).catch(function (e) {
      panel.innerHTML = '<div class="card"><p class="muted">Error: ' + esc(e.message) + '</p></div>';
    });
  }

  reload(renderRoot);
})();

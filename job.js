// job.js — staff job detail: stage control, documents, doc requests, audit trail.
(function () {
  var auth = Nav.guard(Nav.STAFF);
  if (!auth) return;
  Nav.renderNav('dashboard.html');

  var esc = Nav.esc;
  var jobId = new URLSearchParams(location.search).get('id');
  if (!jobId) { document.getElementById('main').innerHTML = '<p class="muted">No job specified.</p>'; return; }

  var guideShown = false;
  function showGuide() {
    if (guideShown) return; guideShown = true;
    Hub.guide('job', auth.role, {
      accountant: { em: '🧮', title: 'Working this job', text: 'Request documents from the client below (this flags the job as <b>Action required</b>), upload working files, then use <b>Change stage</b> to move it to <b>Supervisor review</b> when ready.' },
      supervisor: { em: '✅', title: 'Reviewing this job', text: 'Check the work and documents. Use <b>Approve → Signature</b> to pass it on, or <b>Return to accountant</b> with a reason. You can also <b>Reassign staff</b>.' },
      reception: { em: '🗂️', title: 'Managing this job', text: 'Use <b>Reassign staff</b> to change the accountant or supervisor. Change the stage or put the job <b>On hold</b> if needed.' },
      administrator: { em: '⚙️', title: 'Job controls', text: 'You can change the stage, put the job on hold, reassign staff, and see the full audit trail, documents and notifications below.' },
    });
  }

  function load() {
    Nav.api('/api/jobs/' + encodeURIComponent(jobId)).then(render).catch(function (e) {
      document.getElementById('main').innerHTML = '<p class="muted">Error: ' + esc(e.message) + '</p>';
    });
  }

  function render(res) {
    var j = res.job;
    var cs = Hub.clientStatusFromStage(j.stage, j.on_hold, j.action_required);
    var stageOpts = Hub.STAGES.map(function (s) {
      return '<option value="' + s[0] + '"' + (s[0] === j.stage ? ' selected' : '') + '>' + s[1] + '</option>';
    }).join('');

    var docStatusPill = function (s) {
      var map = { received: 'pill-inprogress', verified: 'pill-completed', incorrect: 'pill-action', info_required: 'pill-action' };
      var label = { received: 'received', verified: 'verified', incorrect: 'incorrect', info_required: 'info required' };
      return '<span class="pill ' + (map[s] || 'pill-inprogress') + '">' + (label[s] || s || 'received') + '</span>';
    };
    var docStatusOpts = function (cur) {
      return ['received', 'verified', 'incorrect', 'info_required'].map(function (s) {
        var label = s === 'info_required' ? 'Info required' : (s.charAt(0).toUpperCase() + s.slice(1));
        return '<option value="' + s + '"' + ((cur || 'received') === s ? ' selected' : '') + '>' + label + '</option>';
      }).join('');
    };
    var docsHtml = (res.documents || []).length ? res.documents.map(function (d) {
      var canPreview = /\.(pdf|jpe?g|png|gif|webp|heic|heif|txt)$/i.test(d.filename || '') ||
        /^(image\/|application\/pdf|text\/)/.test(d.mime || '');
      return '<tr><td><span class="pill pill-inprogress">' + esc(d.category) + '</span></td>' +
        '<td>' + esc(d.filename) + '</td><td class="muted small">' + esc(d.uploaded_by || '') + '</td>' +
        '<td class="muted small">' + Hub.fmtDate(d.created_at) + '</td>' +
        '<td>' + docStatusPill(d.status) +
          (d.review_note ? '<div class="muted small" style="margin-top:2px">' + esc(d.review_note) + '</div>' : '') +
          '<div style="margin-top:4px"><select class="doc-status" data-doc="' + d.id + '" data-tip="Verify this document. Marking it Incorrect or Info required notifies the client.">' + docStatusOpts(d.status) + '</select></div></td>' +
        '<td>' +
        (canPreview ? '<button class="btn btn-xs" data-preview="' + d.id + '" data-tip="Open this document in a new tab.">Preview</button> ' : '') +
        '<a class="btn btn-xs" href="/api/documents/' + d.id + '/download" data-dl="' + d.id + '" data-tip="Download this document to your computer.">Download</a> ' +
        '<button class="btn btn-xs danger" data-deldoc="' + d.id + '" data-tip="Permanently remove this document from the job.">Delete</button></td></tr>';
    }).join('') : '<tr><td colspan="6" class="muted small">No documents uploaded.</td></tr>';

    var reqHtml = (res.docRequests || []).length ? res.docRequests.map(function (r) {
      return '<tr><td>' + esc(r.description) + (r.category ? ' <span class="muted small">(' + esc(r.category) + ')</span>' : '') + '</td>' +
        '<td class="muted small">' + Hub.fmtDate(r.due_date) + '</td>' +
        '<td>' + (r.status === 'received' ? '<span class="pill pill-completed">received</span>' : '<span class="pill pill-action">pending</span>') + '</td>' +
        '<td>' + (r.status === 'pending' ? '<button class="btn btn-xs" data-recv="' + r.id + '" data-tip="Mark this request as received once the client provides the document. Clears Action required when all are done.">Mark received</button> ' : '') +
          '<button class="btn btn-xs danger" data-delreq="' + r.id + '" data-tip="Remove this document request.">Delete</button></td></tr>';
    }).join('') : '<tr><td colspan="4" class="muted small">No outstanding requests.</td></tr>';

    var histHtml = (res.history || []).slice().reverse().map(function (h) {
      return '<li>' + esc(Hub.STAGE_LABEL[h.to_stage] || h.to_stage) +
        (h.reason ? ' — ' + esc(h.reason) : '') +
        '<div class="t-meta">' + esc(h.changed_by || 'system') + ' · ' + Hub.fmtDate(h.created_at) + '</div></li>';
    }).join('');

    var notifHtml = (res.notifications || []).length ? res.notifications.map(function (n) {
      var st = n.status === 'simulated' ? 'sent' : n.status;
      return '<tr><td>' + esc(n.subject) + '</td><td class="muted small">' + esc(n.to_email) + '</td>' +
        '<td><span class="pill pill-' + (st === 'failed' ? 'action' : 'completed') + '">' + esc(st) + '</span></td>' +
        '<td class="muted small">' + Hub.fmtDate(n.created_at) + '</td>' +
        '<td><button class="btn btn-xs" data-resend="' + n.id + '" data-tip="Send this notification again to the recipient.">Resend</button></td></tr>';
    }).join('') : '<tr><td colspan="5" class="muted small">No notifications sent.</td></tr>';

    var meEmail = (auth.email || '').toLowerCase();
    var notesHtml = (res.notes || []).length ? res.notes.map(function (n) {
      var who = n.author_name || n.author || 'staff';
      var canDelete = (String(n.author || '').toLowerCase() === meEmail) || auth.role === 'administrator';
      return '<li>' +
        '<div style="white-space:pre-wrap">' + esc(n.note) + '</div>' +
        '<div class="t-meta">' + esc(who) + ' · ' + Hub.fmtDateTime(n.created_at) +
        (canDelete ? ' · <a href="#" class="note-del" data-note="' + n.id + '" style="color:#c0392b">Delete</a>' : '') +
        '</div></li>';
    }).join('') : '<li class="muted small">No internal notes yet.</li>';

    var catOpts = Hub.DOC_CATEGORIES.map(function (c) { return '<option>' + c + '</option>'; }).join('');
    var isSup = auth.role === 'supervisor' || auth.role === 'administrator';
    var canAssign = auth.role === 'reception' || auth.role === 'supervisor' || auth.role === 'administrator';

    // Overdue / due-soon badge shown next to the due-date editor.
    var dueBadge = '';
    if (j.due_date) {
      var today = new Date(); today.setHours(0, 0, 0, 0);
      var due = new Date((j.due_date || '').slice(0, 10) + 'T00:00:00');
      var days = Math.round((due - today) / 86400000);
      var done = j.stage === '09_completed';
      if (!done && days < 0) dueBadge = '<span class="pill pill-action">Overdue</span>';
      else if (!done && days <= 3) dueBadge = '<span class="pill pill-hold">Due soon</span>';
    }

    document.getElementById('main').innerHTML =
      '<div class="hub-head"><div>' +
        '<a href="dashboard.html" class="muted small">← Dashboard</a>' +
        '<h1>' + esc(j.id) + ' <span class="muted" style="font-size:16px">' + esc(j.job_type || '') + '</span></h1>' +
        '<p class="page-sub">' + esc(j.client_name) + ' (' + esc(j.client_id) + ')' +
          (j.entity_name ? ' · ' + esc(j.entity_name) : '') + ' · ' + esc(j.financial_year || '') + '</p>' +
      '</div></div>' +

      '<div class="card"><div class="stat-row">' +
        '<div class="stat" data-tip-below data-tip="The simplified status the client sees in their portal."><div class="n"><span class="' + Hub.pillClass(cs) + '">' + esc(cs) + '</span></div><div class="l">Client sees</div></div>' +
        '<div class="stat" data-tip-below data-tip="The detailed internal workflow stage — staff only."><div class="n small">' + esc(j.stage_label) + '</div><div class="l">Internal stage</div></div>' +
        '<div class="stat" data-tip-below data-tip="The accountant preparing this job."><div class="n small">' + esc(j.accountant_name || j.accountant_email || '—') + '</div><div class="l">Accountant</div></div>' +
        '<div class="stat" data-tip-below data-tip="The supervisor who reviews this job before signing."><div class="n small">' + esc(j.supervisor_name || j.supervisor_email || '—') + '</div><div class="l">Supervisor</div></div>' +
        '<div class="stat" data-tip-below data-tip="The internal deadline for this job. Overdue jobs are highlighted."><div class="n small"><input type="date" id="dueDateInput" value="' + esc((j.due_date || '').slice(0, 10)) + '" style="font-size:13px;padding:4px 6px" />' +
          (dueBadge ? ' ' + dueBadge : '') + '</div><div class="l">Due date</div></div>' +
      '</div>' +
      '<div class="field" style="margin-top:14px;margin-bottom:0;max-width:360px" data-tip-below data-tip="Move the job to another stage. The change applies immediately and is recorded in the audit trail."><label>Change stage (applies immediately)</label><select id="stageSel">' + stageOpts + '</select></div>' +
      '<div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">' +
        '<button class="btn btn-outline btn-sm" id="holdBtn" data-tip="Pause or resume this job. On-hold jobs are highlighted and excluded from normal progress.">' + (j.on_hold ? 'Remove ON HOLD' : 'Put ON HOLD') + '</button>' +
        (canAssign ? '<button class="btn btn-outline btn-sm" id="assignBtn" data-tip="Change the accountant or supervisor assigned to this job. Newly assigned staff get a notification.">Reassign staff</button>' : '') +
        (j.action_required && !j.on_hold ? '<span class="flag flag-action">ACTION REQUIRED</span><span class="muted small">Client has outstanding document requests</span>' : '') +
        (isSup && j.stage === '05_supervisor_review' ? '<button class="btn btn-primary btn-sm" id="approveBtn" data-tip="Approve the work and move the job to the client signature stage.">Approve → Signature</button><button class="btn btn-ghost btn-sm" id="returnBtn" data-tip="Send the job back to the accountant with a required reason.">Return to accountant</button>' : '') +
        (auth.role === 'administrator' ? '<button class="btn btn-sm danger" id="delJobBtn" style="margin-left:auto" data-tip="Permanently delete this job and all its documents, requests and history. This cannot be undone.">Delete job</button>' : '') +
      '</div>' +
      '<p class="muted small" style="margin-top:8px">Tip: "Action Required" turns on automatically when you request documents below, and clears once all are received.</p></div>' +

      (j.signed_by ?
        '<div class="sign-banner" style="margin-top:14px">' +
          '<div><strong>✓ Signed by client</strong><div class="muted small">' + esc(j.signed_by) + ' · ' + Hub.fmtDateTime(j.signed_at) + '</div></div>' +
          (j.stage === '07_ready_lodgement' ? '<span class="pill pill-completed">Ready for lodgement</span>' : '') +
        '</div>' : '') +

      '<div class="section-title">Documents' +
        (j.drive_folder_link ? ' <a href="' + esc(j.drive_folder_link) + '" target="_blank" rel="noopener" class="btn btn-xs" style="vertical-align:middle;margin-left:8px" data-tip="Open this client\u2019s Google Drive backup folder in a new tab.">📁 Open Drive folder</a>' : '') +
      '</div>' +
      '<div class="card">' +
        '<div class="field-row" style="align-items:end"><div class="field" style="margin-bottom:0" data-tip="Pick the category that best describes the file (e.g. Income, PAYG, Bank Statements)."><label>Category</label><select id="upCat">' + catOpts + '</select></div>' +
        '<div class="field" style="margin-bottom:0" data-tip="Choose a file to attach: PDF, image, or Office document."><label>File</label><input type="file" id="upFile" accept=".pdf,.jpg,.jpeg,.png,.heic,.heif,.doc,.docx,.xls,.xlsx,.csv,.txt"/></div></div>' +
        '<button class="btn btn-primary btn-sm" id="upBtn" style="margin-top:10px" data-tip="Attach a file to this job (PDF, image or Office doc). Both staff and the client can see uploaded documents.">Upload document</button>' +
        '<table class="hub-table" style="margin-top:14px"><thead><tr><th>Category</th><th>File</th><th>By</th><th>Date</th><th>Status</th><th></th></tr></thead><tbody>' + docsHtml + '</tbody></table>' +
      '</div>' +

      '<div class="section-title">Outstanding document requests</div>' +
      '<div class="card">' +
        '<div class="field-row" style="align-items:end"><div class="field" style="margin-bottom:0"><label>Description</label><input id="rqDesc" placeholder="e.g. 2024 PAYG summary"/></div>' +
        '<div class="field" style="margin-bottom:0"><label>Due date</label><input type="date" id="rqDue"/></div></div>' +
        '<button class="btn btn-primary btn-sm" id="rqBtn" style="margin-top:10px" data-tip="Ask the client to provide a document. This notifies them and flags the job as Action required until received.">Request from client</button>' +
        '<table class="hub-table" style="margin-top:14px"><thead><tr><th>Description</th><th>Due</th><th>Status</th><th></th></tr></thead><tbody>' + reqHtml + '</tbody></table>' +
      '</div>' +

      '<div class="section-title">Notifications</div>' +
      '<div class="card"><table class="hub-table"><thead><tr><th>Subject</th><th>To</th><th>Status</th><th>Date</th><th></th></tr></thead><tbody>' + notifHtml + '</tbody></table></div>' +

      '<div class="section-title">Internal notes</div>' +
      '<div class="card" data-tip-below data-tip="Private staff notes for this job. Clients never see these. Any staff member can add a note; only the author or an administrator can delete one.">' +
        '<div class="field" style="margin-bottom:8px"><textarea id="noteInput" rows="3" placeholder="Add an internal note for the team (e.g. offshore prep progress, questions for the supervisor)…"></textarea></div>' +
        '<button class="btn btn-primary btn-sm" id="noteBtn">Add note</button>' +
        '<ul class="timeline" style="margin-top:14px">' + notesHtml + '</ul>' +
      '</div>' +

      '<div class="section-title">Audit trail</div>' +
      '<div class="card"><ul class="timeline">' + histHtml + '</ul></div>';

    showGuide();
    bind(j);
  }

  function bind(j) {
    var $ = function (id) { return document.getElementById(id); };

    // ---- Internal notes ----
    if ($('noteBtn')) $('noteBtn').addEventListener('click', function () {
      var ta = $('noteInput');
      var text = (ta.value || '').trim();
      if (!text) { Hub.toast('Type a note first'); ta.focus(); return; }
      Hub.busy($('noteBtn'), Nav.api('/api/jobs/' + jobId + '/notes', { method: 'POST', body: { note: text } }))
        .then(function () { ta.value = ''; Hub.toast('Note added'); load(); })
        .catch(function (e) { Hub.toast(e.message); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.note-del'), function (a) {
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        var id = a.getAttribute('data-note');
        Nav.api('/api/jobs/' + jobId + '/notes/' + id, { method: 'DELETE' })
          .then(function () { Hub.toast('Note deleted'); load(); })
          .catch(function (e) { Hub.toast(e.message); });
      });
    });

    $('stageSel').addEventListener('change', function () {
      var sel = $('stageSel');
      var newStage = sel.value;
      var prev = j.stage;
      Hub.toast('Updating stage…');
      Nav.api('/api/jobs/' + jobId + '/stage', { method: 'POST', body: { stage: newStage } })
        .then(function () { Hub.toast('Stage updated'); load(); })
        .catch(function (e) { Hub.toast(e.message); sel.value = prev; });
    });
    $('holdBtn').addEventListener('click', function () {
      Nav.api('/api/jobs/' + jobId + '/flags', { method: 'POST', body: { onHold: !j.on_hold } })
        .then(function () { Hub.toast('Updated'); load(); }).catch(function (e) { Hub.toast(e.message); });
    });
    if ($('delJobBtn')) $('delJobBtn').addEventListener('click', function () {
      var m = Hub.modal('Delete job ' + j.id,
        '<p class="muted small">This permanently deletes <b>' + esc(j.id) + '</b> and all of its documents, document requests and history. Notifications are kept but detached. <b>This cannot be undone.</b></p>' +
        '<div class="field"><label>Type the job ID (<b>' + esc(j.id) + '</b>) to confirm</label><input id="delConfirm" placeholder="' + esc(j.id) + '" autocomplete="off"/></div>' +
        '<div class="modal-actions"><button class="btn btn-ghost" id="delCancel">Cancel</button><button class="btn danger" id="delDo">Delete job</button></div>');
      m.q('#delConfirm').focus();
      m.q('#delCancel').addEventListener('click', m.close);
      m.q('#delDo').addEventListener('click', function () {
        if (m.q('#delConfirm').value.trim().toUpperCase() !== String(j.id).toUpperCase()) { Hub.toast('Job ID does not match'); return; }
        Hub.busy(m.q('#delDo'), Nav.api('/api/jobs/' + jobId, { method: 'DELETE' }))
          .then(function () { m.close(); Hub.toast('Job deleted'); location.href = 'dashboard.html'; })
          .catch(function (e) { Hub.toast(e.message); });
      });
    });
    if ($('assignBtn')) $('assignBtn').addEventListener('click', function () { assignModal(j); });
    if ($('approveBtn')) $('approveBtn').addEventListener('click', function () {
      Nav.api('/api/review/' + jobId + '/approve', { method: 'POST' })
        .then(function () { Hub.toast('Approved'); load(); }).catch(function (e) { Hub.toast(e.message); });
    });
    if ($('returnBtn')) $('returnBtn').addEventListener('click', function () {
      var m = Hub.modal('Return to accountant',
        '<p class="muted small">Let the accountant know what needs fixing before it can be approved.</p>' +
        '<div class="field"><label>Reason for returning</label>' +
        '<textarea id="rReason" rows="4" placeholder="e.g. Wrong file attached — please re-upload the FY2024-25 PAYG summary."></textarea></div>' +
        '<div class="modal-actions"><button class="btn btn-ghost" id="rCancel">Cancel</button><button class="btn btn-primary" id="rDo">Return to accountant</button></div>');
      m.q('#rReason').focus();
      m.q('#rCancel').addEventListener('click', m.close);
      m.q('#rDo').addEventListener('click', function () {
        var reason = m.q('#rReason').value.trim();
        if (!reason) { Hub.toast('Please enter a reason'); return; }
        Hub.busy(m.q('#rDo'), Nav.api('/api/review/' + jobId + '/return', { method: 'POST', body: { reason: reason } }))
          .then(function () { m.close(); Hub.toast('Returned'); load(); })
          .catch(function (e) { Hub.toast(e.message); });
      });
    });
    $('upBtn').addEventListener('click', function () {
      var f = $('upFile').files[0];
      if (!f) { Hub.toast('Choose a file'); return; }
      var fd = new FormData();
      fd.append('file', f); fd.append('jobId', jobId); fd.append('category', $('upCat').value);
      Hub.busy($('upBtn'), Nav.api('/api/documents/upload', { method: 'POST', body: fd }))
        .then(function () { Hub.toast('Uploaded'); load(); }).catch(function (e) { Hub.toast(e.message); });
    });
    // Save the job due date whenever it changes.
    if ($('dueDateInput')) $('dueDateInput').addEventListener('change', function () {
      var val = $('dueDateInput').value || '';
      Nav.api('/api/jobs/' + jobId + '/due-date', { method: 'PATCH', body: { dueDate: val } })
        .then(function () { Hub.toast(val ? 'Due date set' : 'Due date cleared'); load(); })
        .catch(function (e) { Hub.toast(e.message); });
    });
    // Verify a document. Incorrect / Info required prompts for an optional note.
    Array.prototype.forEach.call(document.querySelectorAll('.doc-status'), function (sel) {
      sel.addEventListener('change', function () {
        var docId = sel.getAttribute('data-doc');
        var status = sel.value;
        var note = null;
        if (status === 'incorrect' || status === 'info_required') {
          note = prompt('Add a note for the client (optional):', '') || '';
        }
        Nav.api('/api/documents/' + docId + '/status', { method: 'PATCH', body: { status: status, note: note } })
          .then(function () { Hub.toast('Document ' + status.replace('_', ' ')); load(); })
          .catch(function (e) { Hub.toast(e.message); load(); });
      });
    });
    $('rqBtn').addEventListener('click', function () {
      var d = $('rqDesc').value.trim();
      if (!d) { Hub.toast('Description required'); return; }
      var due = $('rqDue').value || null;
      $('rqDesc').value = ''; $('rqDue').value = ''; // clear immediately
      Nav.api('/api/doc-requests', { method: 'POST', body: { jobId: jobId, description: d, dueDate: due } })
        .then(function () { Hub.toast('Requested'); load(); }).catch(function (e) { Hub.toast(e.message); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-recv]'), function (b) {
      b.addEventListener('click', function () {
        var td = b.closest('td');
        var statusCell = b.closest('tr').querySelector('td:nth-child(3)');
        // Optimistic: show received + remove the button immediately.
        if (statusCell) statusCell.innerHTML = '<span class="pill pill-completed">received</span>';
        b.remove();
        Nav.api('/api/doc-requests/' + b.getAttribute('data-recv') + '/received', { method: 'POST' })
          .then(function () { Hub.toast('Marked received'); }).catch(function (e) { Hub.toast(e.message); load(); });
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-delreq]'), function (b) {
      b.addEventListener('click', function () {
        if (!confirm('Delete this document request?')) return;
        var tr = b.closest('tr');
        tr.style.transition = 'opacity .15s'; tr.style.opacity = '0';
        setTimeout(function () { tr.remove(); }, 150); // remove row instantly (optimistic)
        Nav.api('/api/doc-requests/' + b.getAttribute('data-delreq'), { method: 'DELETE' })
          .then(function () { Hub.toast('Request deleted'); }).catch(function (e) { Hub.toast(e.message); load(); });
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-deldoc]'), function (b) {
      b.addEventListener('click', function () {
        if (!confirm('Delete this document?')) return;
        var tr = b.closest('tr');
        tr.style.transition = 'opacity .15s'; tr.style.opacity = '0';
        setTimeout(function () { tr.remove(); }, 150);
        Nav.api('/api/documents/' + b.getAttribute('data-deldoc'), { method: 'DELETE' })
          .then(function () { Hub.toast('Deleted'); }).catch(function (e) { Hub.toast(e.message); load(); });
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-resend]'), function (b) {
      b.addEventListener('click', function () {
        Hub.toast('Resending…');
        Nav.api('/api/notifications/' + b.getAttribute('data-resend') + '/resend', { method: 'POST' })
          .then(function () { Hub.toast('Resent'); load(); }).catch(function (e) { Hub.toast(e.message); });
      });
    });
    // Authenticated downloads (Bearer token can't ride on a plain <a href>).
    Array.prototype.forEach.call(document.querySelectorAll('[data-dl]'), function (a) {
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        var id = a.getAttribute('data-dl');
        fetch('/api/documents/' + id + '/download', { headers: { Authorization: 'Bearer ' + auth.token } })
          .then(function (r) { return r.blob().then(function (b) { return { r: r, b: b }; }); })
          .then(function (o) {
            if (!o.r.ok) { Hub.toast('Download failed'); return; }
            var url = URL.createObjectURL(o.b);
            var link = document.createElement('a'); link.href = url;
            link.download = a.textContent === 'Download' ? '' : '';
            var cd = o.r.headers.get('Content-Disposition') || '';
            var mm = /filename="?([^"]+)"?/.exec(cd); if (mm) link.download = mm[1];
            document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
          });
      });
    });
    // Preview: fetch inline with auth, open the blob in a new tab.
    Array.prototype.forEach.call(document.querySelectorAll('[data-preview]'), function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-preview');
        var w = window.open('', '_blank');
        fetch('/api/documents/' + id + '/download?inline=1', { headers: { Authorization: 'Bearer ' + auth.token } })
          .then(function (r) { if (!r.ok) throw new Error('Preview failed'); return r.blob(); })
          .then(function (blob) {
            var url = URL.createObjectURL(blob);
            if (w) { w.location = url; } else { window.open(url, '_blank'); }
            setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
          }).catch(function () { if (w) w.close(); Hub.toast('Preview failed'); });
      });
    });
  }

  // ---- Reassign staff ----
  function assignModal(j) {
    Nav.api('/api/staff').then(function (res) {
      var staff = res.staff || [];
      function opts(selected, roles) {
        var list = staff.filter(function (s) { return roles.indexOf(s.role) !== -1; });
        var o = '<option value="">— Unassigned —</option>';
        return o + list.map(function (s) {
          var val = s.email;
          return '<option value="' + esc(val) + '"' + (val === selected ? ' selected' : '') + '>' +
            esc((s.name ? s.name + ' · ' : '') + s.email + ' (' + s.role + ')') + '</option>';
        }).join('');
      }
      var m = Hub.modal('Reassign staff — ' + j.id,
        '<div class="field"><label>Accountant</label><select id="asAcc">' + opts(j.accountant_email, ['accountant']) + '</select></div>' +
        '<div class="field"><label>Supervisor</label><select id="asSup">' + opts(j.supervisor_email, ['supervisor']) + '</select></div>' +
        '<p class="muted small">Newly assigned staff will get a notification.</p>' +
        '<div class="modal-actions"><button class="btn btn-ghost" id="asCancel">Cancel</button><button class="btn btn-primary" id="asSave">Save</button></div>');
      m.q('#asCancel').addEventListener('click', m.close);
      m.q('#asSave').addEventListener('click', function () {
        Hub.busy(m.q('#asSave'), Nav.api('/api/jobs/' + jobId + '/assign', { method: 'POST', body: {
          accountant: m.q('#asAcc').value, supervisor: m.q('#asSup').value } }))
          .then(function () { m.close(); Hub.toast('Staff reassigned'); load(); })
          .catch(function (e) { Hub.toast(e.message); });
      });
    }).catch(function (e) { Hub.toast(e.message); });
  }

  load();
})();

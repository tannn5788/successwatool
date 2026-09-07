// portal.js — client-facing portal: job progress, outstanding items, uploads.
(function () {
  var auth = Nav.guard(['client']);
  if (!auth) return;
  Nav.renderNav('portal.html');
  var esc = Nav.esc;

  Hub.guide('portal', auth.role, {
    client: { em: '👤', title: 'Welcome to your portal', text: 'Each card below is one of your jobs and its current status. When we ask for a document, open the job and upload it. When a job is ready, a <b>Review &amp; Sign</b> banner will appear for you to approve.' },
  });

  function load() {
    Nav.api('/api/portal/jobs').then(render).catch(function (e) {
      document.getElementById('wrap').innerHTML = '<p class="muted">Error: ' + esc(e.message) + '</p>';
    });
  }

  function render(res) {
    var jobs = res.jobs || [];
    if (!jobs.length) {
      document.getElementById('wrap').innerHTML = '<div class="card"><h3>No jobs yet</h3>' +
        '<p class="muted">You have no active jobs. If you expect to see one, please contact our office. ' +
        'You can still use the <a href="personal.html">Tax Tracker</a> to keep your records.</p></div>';
      return;
    }
    document.getElementById('wrap').innerHTML = jobs.map(function (j) {
      var pill = Hub.pillClass(j.clientStatus);
      // Derive a matching faint card tint from the pill class (pill pill-xxx -> card-xxx).
      var cardTint = (pill.split(' ')[1] || 'pill-inprogress').replace('pill-', 'card-');
      var action = j.clientStatus === 'Action Required' || j.outstanding > 0;
      return '<div class="card job-card ' + cardTint + '" style="margin-bottom:16px">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap">' +
        '<div><h3>' + esc(j.jobType || 'Tax Job') + ' <span class="muted small">' + esc(j.id) + '</span></h3>' +
        '<p class="muted small">' + esc(j.entityName || '') + (j.financialYear ? ' · ' + esc(j.financialYear) : '') + '</p></div>' +
        '<span class="' + pill + '">' + esc(j.clientStatus) + '</span></div>' +
        '<div class="progress"><i style="width:' + j.progressPct + '%"></i></div>' +
        '<p class="small">' + esc(j.clientMessage) + '</p>' +
        (action ? '<p class="small" style="color:var(--red);font-weight:600">' +
          (j.outstanding > 0 ? j.outstanding + ' outstanding document(s) requested. ' : '') + esc(j.nextAction || '') + '</p>' : '') +
        '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="btn btn-outline btn-sm" data-view="' + esc(j.id) + '">View details</button>' +
        '<button class="btn btn-primary btn-sm" data-upload="' + esc(j.id) + '">Upload documents</button></div>' +
        '<div data-detail="' + esc(j.id) + '"></div></div>';
    }).join('');

    Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (b) {
      b.addEventListener('click', function () { viewDetail(b.getAttribute('data-view')); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-upload]'), function (b) {
      b.addEventListener('click', function () { uploadModal(b.getAttribute('data-upload')); });
    });

    // If arriving from a notification link (portal.html?job=JB-xxxx), auto-open that job.
    var wantJob = new URLSearchParams(location.search).get('job');
    if (wantJob) {
      var target = document.querySelector('[data-detail="' + wantJob + '"]');
      if (target) {
        viewDetail(wantJob);
        var card = target.closest('.card');
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }

  function viewDetail(id) {
    var box = document.querySelector('[data-detail="' + id + '"]');
    if (box.getAttribute('data-open') === '1') { box.innerHTML = ''; box.setAttribute('data-open', '0'); return; }
    Nav.api('/api/portal/jobs/' + encodeURIComponent(id)).then(function (res) {
      var reqs = (res.docRequests || []);
      var pending = reqs.filter(function (r) { return r.status === 'pending'; });
      var docs = (res.documents || []);
      box.setAttribute('data-open', '1');
      var canSign = res.job && res.job.canSign;
      box.innerHTML =
        (canSign ?
          '<div class="sign-banner">' +
            '<div><strong>Your return is ready to sign</strong><div class="muted small">Please review and confirm so we can proceed with lodgement.</div></div>' +
            '<button class="btn btn-primary" data-sign="' + id + '">Review &amp; Sign</button>' +
          '</div>' : '') +
        '<div class="section-title">Outstanding items</div>' +
        (pending.length ? '<ul class="timeline">' + pending.map(function (r) {
          return '<li>' + esc(r.description) + (r.due_date ? ' <span class="muted small">(due ' + Hub.fmtDate(r.due_date) + ')</span>' : '') + '</li>';
        }).join('') + '</ul>' : '<p class="muted small">Nothing outstanding right now.</p>') +
        '<div class="section-title">Your uploaded documents</div>' +
        (docs.length ? '<table class="hub-table"><thead><tr><th>File</th><th>Category</th><th>Uploaded</th><th></th></tr></thead><tbody>' + docs.map(function (d) {
          var mine = d.uploaded_by && auth.email && d.uploaded_by.toLowerCase() === auth.email.toLowerCase();
          var canPreview = /\.(pdf|jpe?g|png|gif|webp|heic|heif|txt)$/i.test(d.filename || '') ||
            /^(image\/|application\/pdf|text\/)/.test(d.mime || '');
          return '<tr><td style="word-break:break-all">' + esc(d.filename) + '</td>' +
            '<td class="muted small">' + esc(d.category) + '</td>' +
            '<td class="muted small">' + Hub.fmtDate(d.created_at) + '</td>' +
            '<td style="white-space:nowrap">' +
            (canPreview ? '<button class="btn btn-xs" data-preview="' + d.id + '">Preview</button> ' : '') +
            '<a class="btn btn-xs" href="/api/documents/' + d.id + '/download" data-dl="' + d.id + '">Download</a>' +
            (mine ? ' <button class="btn btn-xs danger" data-deldoc="' + d.id + '">Delete</button>' : '') +
            '</td></tr>';
        }).join('') + '</tbody></table>' : '<p class="muted small">No documents uploaded yet.</p>');
      var signBtn = box.querySelector('[data-sign]');
      if (signBtn) signBtn.addEventListener('click', function () { signModal(id); });
      // Authenticated downloads (Bearer token can't ride on a plain <a href>).
      Array.prototype.forEach.call(box.querySelectorAll('[data-dl]'), function (a) {
        a.addEventListener('click', function (ev) {
          ev.preventDefault();
          var did = a.getAttribute('data-dl');
          fetch('/api/documents/' + did + '/download', { headers: { Authorization: 'Bearer ' + auth.token } })
            .then(function (r) { return r.blob().then(function (b) { return { r: r, b: b }; }); })
            .then(function (o) {
              if (!o.r.ok) { Hub.toast('Download failed'); return; }
              var url = URL.createObjectURL(o.b);
              var link = document.createElement('a'); link.href = url; link.download = '';
              var cd = o.r.headers.get('Content-Disposition') || '';
              var mm = /filename="?([^"]+)"?/.exec(cd); if (mm) link.download = mm[1];
              document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
            }).catch(function () { Hub.toast('Download failed'); });
        });
      });
      // Preview: fetch inline with auth, open the blob in a new tab.
      Array.prototype.forEach.call(box.querySelectorAll('[data-preview]'), function (b) {
        b.addEventListener('click', function () {
          var did = b.getAttribute('data-preview');
          var w = window.open('', '_blank');
          fetch('/api/documents/' + did + '/download?inline=1', { headers: { Authorization: 'Bearer ' + auth.token } })
            .then(function (r) { if (!r.ok) throw new Error('Preview failed'); return r.blob(); })
            .then(function (blob) {
              var url = URL.createObjectURL(blob);
              if (w) { w.location = url; } else { window.open(url, '_blank'); }
              setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
            }).catch(function () { if (w) w.close(); Hub.toast('Preview failed'); });
        });
      });
      Array.prototype.forEach.call(box.querySelectorAll('[data-deldoc]'), function (b) {
        b.addEventListener('click', function () {
          var docId = b.getAttribute('data-deldoc');
          var m = Hub.modal('Delete document',
            '<p>Remove this document? This cannot be undone.</p>' +
            '<div class="modal-actions"><button class="btn btn-ghost" id="dCancel">Cancel</button><button class="btn btn-primary danger" id="dOk">Delete</button></div>');
          m.q('#dCancel').addEventListener('click', m.close);
          m.q('#dOk').addEventListener('click', function () {
            Hub.busy(m.q('#dOk'), Nav.api('/api/portal/documents/' + encodeURIComponent(docId), { method: 'DELETE' }))
              .then(function () { m.close(); Hub.toast('Document deleted'); viewDetail(id); viewDetail(id); })
              .catch(function (e) { Hub.toast(e.message); });
          });
        });
      });
    }).catch(function (e) { Hub.toast(e.message); });
  }

  function signModal(id) {
    var m = Hub.modal('Review & Sign',
      '<p class="muted small">By signing below, you confirm you have reviewed your return and authorise us to proceed with lodgement.</p>' +
      '<div class="field"><label>Full name (signature)</label><input type="text" id="pSign" placeholder="Type your full name"/></div>' +
      '<div class="field"><label><input type="checkbox" id="pAgree"/> I confirm the information is correct and authorise lodgement.</label></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" id="sCancel">Cancel</button><button class="btn btn-primary" id="sDo">Sign &amp; Submit</button></div>');
    m.q('#sCancel').addEventListener('click', m.close);
    m.q('#sDo').addEventListener('click', function () {
      if (!m.q('#pSign').value.trim()) { Hub.toast('Please type your full name'); return; }
      if (!m.q('#pAgree').checked) { Hub.toast('Please tick the confirmation box'); return; }
      Hub.busy(m.q('#sDo'), Nav.api('/api/portal/jobs/' + encodeURIComponent(id) + '/sign', { method: 'POST', body: { name: m.q('#pSign').value.trim() } }))
        .then(function () { m.close(); Hub.toast('Thank you! Your return has been signed.'); load(); })
        .catch(function (e) { Hub.toast(e.message); });
    });
  }

  function uploadModal(jobId) {
    var catOpts = Hub.DOC_CATEGORIES.map(function (c) { return '<option>' + c + '</option>'; }).join('');
    var m = Hub.modal('Upload documents',
      '<div class="field"><label>Category</label><select id="pCat">' + catOpts + '</select></div>' +
      '<div class="field"><label>Choose file or take a photo</label>' +
      '<input type="file" id="pFile" accept=".pdf,.jpg,.jpeg,.png,.heic,.heif,.doc,.docx,.xls,.xlsx,.csv,.txt,image/*" capture="environment"/></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" id="pCancel">Cancel</button><button class="btn btn-primary" id="pUp">Upload</button></div>');
    m.q('#pCancel').addEventListener('click', m.close);
    m.q('#pUp').addEventListener('click', function () {
      var f = m.q('#pFile').files[0];
      if (!f) { Hub.toast('Please choose a file'); return; }
      var fd = new FormData();
      fd.append('file', f); fd.append('jobId', jobId); fd.append('category', m.q('#pCat').value);
      Hub.busy(m.q('#pUp'), Nav.api('/api/documents/upload', { method: 'POST', body: fd }))
        .then(function () { m.close(); Hub.toast('Uploaded — thank you!'); load(); })
        .catch(function (e) { Hub.toast(e.message); });
    });
  }

  load();
})();

// review.js — supervisor approval queue.
(function () {
  var auth = Nav.guard(['supervisor']);
  if (!auth) return;
  Nav.renderNav('review.html');
  var esc = Nav.esc;

  Hub.guide('review', auth.role, {
    supervisor: { em: '✅', title: 'Supervisor Review Queue', text: 'These jobs are waiting for your approval. Open one to check the work, then <b>Approve</b> to send it to the client for signing, or <b>Return</b> it to the accountant with a reason.' },
  });

  function load() {
    Nav.api('/api/review/queue').then(render).catch(function (e) {
      document.getElementById('wrap').innerHTML = '<p class="muted">Error: ' + esc(e.message) + '</p>';
    });
  }

  function render(res) {
    var jobs = res.jobs || [];
    if (!jobs.length) { document.getElementById('wrap').innerHTML = '<div class="card"><p class="muted">Nothing waiting for review.</p></div>'; return; }
    document.getElementById('wrap').innerHTML = jobs.map(function (j) {
      var days = (j.days_in_review != null) ? j.days_in_review : 0;
      var isNew = days < 1;
      return '<div class="card" style="margin-bottom:16px"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">' +
        '<div><h3>' + esc(j.id) + ' · ' + esc(j.client_name) +
          (isNew ? ' <span class="pill pill-action" style="vertical-align:middle">NEW</span>' : '') + '</h3>' +
        '<p class="muted small">' + esc(j.entity_name || '') + (j.entity_name ? ' · ' : '') +
          esc(j.job_type || '') + ' · ' + esc(j.financial_year || '') + '</p>' +
        '<p class="muted small">Accountant: ' + esc(j.accountant_email || '—') + ' · ' + days + 'd in review · ' +
          (j.doc_count || 0) + ' document(s)' +
          (j.pending_reqs > 0 ? ' · <span style="color:var(--red)">' + j.pending_reqs + ' outstanding</span>' : '') + '</p></div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-outline btn-sm" data-detail="' + esc(j.id) + '">Review details</button>' +
        '<button class="btn btn-primary btn-sm" data-approve="' + esc(j.id) + '">Approve</button>' +
        '<button class="btn btn-outline btn-sm" data-reqinfo="' + esc(j.id) + '">Request info from client</button>' +
        '<button class="btn btn-ghost btn-sm" data-return="' + esc(j.id) + '">Return</button></div></div>' +
        '<div class="review-detail" data-panel="' + esc(j.id) + '"></div></div>';
    }).join('');

    Array.prototype.forEach.call(document.querySelectorAll('[data-detail]'), function (b) {
      b.addEventListener('click', function () { toggleDetail(b.getAttribute('data-detail')); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-approve]'), function (b) {
      b.addEventListener('click', function () {
        Nav.api('/api/review/' + b.getAttribute('data-approve') + '/approve', { method: 'POST' })
          .then(function () { Hub.toast('Approved → Awaiting Signature'); load(); }).catch(function (e) { Hub.toast(e.message); });
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-return]'), function (b) {
      b.addEventListener('click', function () {
        returnModal(b.getAttribute('data-return'));
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-reqinfo]'), function (b) {
      b.addEventListener('click', function () {
        requestInfoModal(b.getAttribute('data-reqinfo'));
      });
    });
  }

  function requestInfoModal(jobId) {
    var m = Hub.modal('Request more info from client',
      '<p class="muted small">Ask the client for extra information or documents. This keeps the job in review, flags it as <b>Action required</b> for the client, and emails them your message.</p>' +
      '<div class="field"><label>What do you need from the client?</label>' +
      '<textarea id="riMsg" rows="4" placeholder="e.g. Please confirm the purchase date of your rental property and upload the settlement statement."></textarea></div>' +
      '<div class="field"><label>Due date (optional)</label><input type="date" id="riDue"/></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" id="riCancel">Cancel</button><button class="btn btn-primary" id="riDo">Send request</button></div>');
    m.q('#riMsg').focus();
    m.q('#riCancel').addEventListener('click', m.close);
    m.q('#riDo').addEventListener('click', function () {
      var msg = m.q('#riMsg').value.trim();
      if (!msg) { Hub.toast('Please enter a message'); return; }
      var due = m.q('#riDue').value || null;
      Hub.busy(m.q('#riDo'), Nav.api('/api/review/' + jobId + '/request-info', { method: 'POST', body: { message: msg, dueDate: due } }))
        .then(function () { m.close(); Hub.toast('Request sent to client'); load(); })
        .catch(function (e) { Hub.toast(e.message); });
    });
  }

  function returnModal(jobId) {
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
        .then(function () { m.close(); Hub.toast('Returned to accountant'); load(); })
        .catch(function (e) { Hub.toast(e.message); });
    });
  }

  function toggleDetail(id) {
    var box = document.querySelector('[data-panel="' + id + '"]');
    if (box.getAttribute('data-open') === '1') { box.innerHTML = ''; box.setAttribute('data-open', '0'); return; }
    box.setAttribute('data-open', '1');
    box.innerHTML = '<p class="muted small" style="margin-top:12px">Loading…</p>';
    Nav.api('/api/jobs/' + encodeURIComponent(id)).then(function (r) {
      var docs = (r.documents || []);
      var reqs = (r.docRequests || []);
      var hist = (r.history || []).slice().reverse();
      var docsHtml = docs.length ? docs.map(function (d) {
        return '<li>' + esc(d.filename) + ' <span class="muted small">(' + esc(d.category) + ')</span> ' +
          '<a class="btn btn-xs" data-dl="' + d.id + '" href="#">Download</a></li>';
      }).join('') : '<li class="muted small">No documents uploaded.</li>';
      var reqHtml = reqs.length ? reqs.map(function (q) {
        return '<li>' + esc(q.description) + ' — ' + (q.status === 'received' ? '<span style="color:var(--ok)">received</span>' : '<span style="color:var(--red)">pending</span>') + '</li>';
      }).join('') : '<li class="muted small">None.</li>';
      var histHtml = hist.slice(0, 6).map(function (h) {
        return '<li>' + esc(Hub.STAGE_LABEL[h.to_stage] || h.to_stage) + (h.reason ? ' — ' + esc(h.reason) : '') +
          '<div class="t-meta">' + esc(h.changed_by || 'system') + ' · ' + Hub.fmtDate(h.created_at) + '</div></li>';
      }).join('');
      box.innerHTML =
        '<div class="section-title">Documents submitted</div><ul class="timeline">' + docsHtml + '</ul>' +
        '<div class="section-title">Outstanding items</div><ul class="timeline">' + reqHtml + '</ul>' +
        '<div class="section-title">Recent history</div><ul class="timeline">' + histHtml + '</ul>' +
        '<p class="small" style="margin-top:8px"><a href="job.html?id=' + esc(id) + '">Open full job page →</a></p>';
      // Authenticated downloads.
      Array.prototype.forEach.call(box.querySelectorAll('[data-dl]'), function (a) {
        a.addEventListener('click', function (ev) {
          ev.preventDefault();
          fetch('/api/documents/' + a.getAttribute('data-dl') + '/download', { headers: { Authorization: 'Bearer ' + auth.token } })
            .then(function (rr) { return rr.blob().then(function (bl) { return { rr: rr, bl: bl }; }); })
            .then(function (o) {
              if (!o.rr.ok) { Hub.toast('Download failed'); return; }
              var url = URL.createObjectURL(o.bl);
              var link = document.createElement('a'); link.href = url;
              var cd = o.rr.headers.get('Content-Disposition') || '';
              var mm = /filename="?([^"]+)"?/.exec(cd); if (mm) link.download = mm[1];
              document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
            });
        });
      });
    }).catch(function (e) { box.innerHTML = '<p class="muted small">Error: ' + esc(e.message) + '</p>'; });
  }
  load();
})();

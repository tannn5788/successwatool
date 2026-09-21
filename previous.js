// previous.js — client's read-only archive of completed work + shared documents.
// Shows only COMPLETED jobs. For each, lists the documents the client is allowed
// to see (their own uploads + firm deliverables shared with them). Read-only:
// no uploads, no status changes, no staff names or internal notes.
(function () {
  var auth = Nav.guard(['client']);
  if (!auth) return;
  Nav.renderNav('previous.html');
  var esc = Nav.esc;
  var panel = document.getElementById('panel');

  Hub.guide('previous', auth.role, {
    client: {
      em: '🗂️',
      title: 'Your completed work',
      text: 'A record of your finished jobs and the documents we have shared with you, such as final tax returns and notices of assessment. You can download these any time.',
    },
  });

  function docRow(d) {
    var tag = d.shared_by_firm
      ? '<span class="pill pill-completed" style="margin-left:8px">From Syraxx</span>'
      : '<span class="pill pill-inprogress" style="margin-left:8px">Your upload</span>';
    return '<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--border,#eef0f2)">' +
      '<span style="font-size:20px">📄</span>' +
      '<span style="flex:1"><b style="display:block;word-break:break-all">' + esc(d.filename) + '</b>' +
        '<span class="muted small">' + esc(d.category || 'Other') + ' · ' + Hub.fmtDate(d.created_at) + tag + '</span></span>' +
      '<a class="btn btn-sm btn-outline" href="/api/documents/' + d.id + '/download">Download</a>' +
      '</div>';
  }

  function jobCard(j) {
    var title = (j.jobType || 'Tax job') + (j.financialYear ? ' — ' + esc(j.financialYear) : '');
    var docs = j.documents || [];
    var html = '<div class="card" style="margin-bottom:16px">' +
      '<div class="hub-head" style="margin-bottom:6px"><div>' +
        '<h2 style="margin:0">' + esc(title) + '</h2>' +
        '<p class="page-sub" style="margin:2px 0 0">' +
          (j.entityName ? esc(j.entityName) + ' · ' : '') +
          'Completed ' + Hub.fmtDate(j.completedAt) + ' · ' + j.id + '</p></div>' +
        '<span class="pill pill-completed">Completed</span></div>';
    if (!docs.length) {
      html += '<p class="muted small" style="margin-top:10px">No documents shared for this job.</p>';
    } else {
      html += '<div style="margin-top:10px">' + docs.map(docRow).join('') + '</div>';
    }
    html += '</div>';
    return html;
  }

  function render(jobs) {
    if (!jobs.length) {
      panel.innerHTML = '<div class="card"><p class="muted">You have no completed work yet. Once a job is finished it will appear here with any documents we have shared.</p></div>';
      return;
    }
    panel.innerHTML = jobs.map(jobCard).join('');
  }

  Nav.api('/api/portal/previous').then(function (r) {
    render(r.jobs || []);
  }).catch(function (e) {
    panel.innerHTML = '<div class="card"><p class="muted">Error: ' + esc(e.message) + '</p></div>';
  });
})();

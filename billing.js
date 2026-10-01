// billing.js — client's own invoices + payment status (Phase 1 #13/#15, record-only).
// Shows amount + status only; no staff names or internal data. "Pay Now" is a
// placeholder until an online payment gateway is wired up.
(function () {
  var auth = Nav.guard(['client']);
  if (!auth) return;
  Nav.renderNav('billing.html');
  var esc = Nav.esc;
  var panel = document.getElementById('panel');

  function money(cents, currency) {
    var v = (Number(cents) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (currency === 'AUD' || !currency ? '$' : (currency + ' ')) + v;
  }
  function statusPill(s) {
    if (s === 'paid') return '<span class="pill pill-completed">Paid</span>';
    return '<span class="pill pill-inprogress">Unpaid</span>';
  }

  function row(inv) {
    var paid = inv.status === 'paid';
    var meta = (inv.description ? esc(inv.description) + ' · ' : '') + inv.id +
      ' · Issued ' + Hub.fmtDate(inv.issued_at) +
      (inv.due_date && !paid ? ' · Due ' + Hub.fmtDate(inv.due_date) : '') +
      (paid && inv.paid_at ? ' · Paid ' + Hub.fmtDate(inv.paid_at) : '');
    var action = paid
      ? ''
      : '<button class="btn btn-sm btn-primary" data-pay="' + inv.id + '">Pay Now</button>';
    return '<div style="display:flex;align-items:center;gap:12px;padding:14px 0;border-top:1px solid var(--border,#eef0f2)">' +
      '<span style="flex:1"><b style="display:block;font-size:17px">' + money(inv.amount_cents, inv.currency) + ' ' + statusPill(inv.status) + '</b>' +
        '<span class="muted small">' + meta + '</span></span>' +
      action +
      '</div>';
  }

  function render(invoices) {
    if (!invoices.length) {
      panel.innerHTML = '<div class="card"><p class="muted">You have no invoices yet. When we raise an invoice it will appear here with its payment status.</p></div>';
      return;
    }
    var outstanding = invoices.filter(function (i) { return i.status !== 'paid'; })
      .reduce(function (sum, i) { return sum + Number(i.amount_cents); }, 0);
    var head = outstanding > 0
      ? '<div class="card" style="margin-bottom:16px"><p class="muted small" style="margin:0">Outstanding balance</p><h2 style="margin:4px 0 0">' + money(outstanding, invoices[0].currency) + '</h2></div>'
      : '<div class="card" style="margin-bottom:16px"><p class="muted" style="margin:0">You are all paid up. Thank you!</p></div>';
    panel.innerHTML = head + '<div class="card">' + invoices.map(row).join('') + '</div>';

    panel.querySelectorAll('[data-pay]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        Hub.busy(btn, Nav.api('/api/portal/invoices/' + btn.getAttribute('data-pay') + '/pay', { method: 'POST' }))
          .then(function (r) { Hub.toast(r.message || 'Thank you.'); })
          .catch(function (e) { Hub.toast(e.message); });
      });
    });
  }

  Nav.api('/api/portal/invoices').then(function (r) {
    render(r.invoices || []);
  }).catch(function (e) {
    panel.innerHTML = '<div class="card"><p class="muted">Error: ' + esc(e.message) + '</p></div>';
  });
})();

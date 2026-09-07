// hub-common.js — shared UI helpers + stage metadata for Elite Client Hub pages.
(function () {
  var STAGES = [
    ['01_created', '01 Job Created'],
    ['02_waiting_docs', '02 Waiting for Documents'],
    ['03_docs_received', '03 Documents Received'],
    ['04_processing', '04 Accountant Processing'],
    ['05_supervisor_review', '05 Supervisor Review'],
    ['06_awaiting_signature', '06 Awaiting Client Signature'],
    ['07_ready_lodgement', '07 Ready for Lodgement'],
    ['08_lodged', '08 Lodged'],
    ['09_completed', '09 Completed'],
  ];
  var STAGE_LABEL = {};
  STAGES.forEach(function (s) { STAGE_LABEL[s[0]] = s[1]; });

  var DOC_CATEGORIES = ['Income', 'PAYG', 'Rental Property', 'Investments', 'Shares', 'Crypto',
    'Business', 'Motor Vehicle', 'Expenses', 'Superannuation', 'Private Health',
    'Bank Statements', 'Previous Tax Documents', 'Other'];

  // Map a client-facing status string to a pill CSS class.
  function pillClass(clientStatus) {
    var k = String(clientStatus || '').toLowerCase();
    if (k.indexOf('action') !== -1) return 'pill pill-action';
    if (k.indexOf('hold') !== -1) return 'pill pill-hold';
    if (k.indexOf('lodged') !== -1) return 'pill pill-lodged';
    if (k.indexOf('completed') !== -1) return 'pill pill-completed';
    if (k.indexOf('received') !== -1) return 'pill pill-received';
    return 'pill pill-inprogress';
  }

  // Derive a client-facing status label from an internal stage + flags (staff views).
  function clientStatusFromStage(stage, onHold, actionReq) {
    if (onHold) return 'On Hold';
    var map = {
      '01_created': 'Received', '02_waiting_docs': 'Action Required', '03_docs_received': 'In Progress',
      '04_processing': 'In Progress', '05_supervisor_review': 'In Progress', '06_awaiting_signature': 'Action Required',
      '07_ready_lodgement': 'In Progress', '08_lodged': 'Lodged', '09_completed': 'Completed',
    };
    var s = map[stage] || 'In Progress';
    if (actionReq && s !== 'Action Required') return 'Action Required';
    return s;
  }

  function fmtDate(d) {
    if (!d) return '—';
    try { return new Date(d).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }); }
    catch (e) { return d; }
  }

  // Date + time (e.g. "06 Sep 2026, 5:10 PM")
  function fmtDateTime(d) {
    if (!d) return '—';
    try {
      return new Date(d).toLocaleString('en-AU', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
      });
    } catch (e) { return d; }
  }

  // Simple modal builder. content = HTML string. Returns {close} and injects into body.
  function modal(title, contentHtml) {
    var back = document.createElement('div');
    back.className = 'hub-modal-back';
    back.innerHTML = '<div class="hub-modal"><h2>' + title + '</h2>' + contentHtml + '</div>';
    document.body.appendChild(back);
    function close() { back.remove(); }
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    return { el: back, close: close, q: function (sel) { return back.querySelector(sel); } };
  }

  function toast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#222;color:#fff;' +
      'padding:11px 18px;border-radius:10px;font-size:14px;z-index:200;box-shadow:0 8px 24px rgba(0,0,0,.3);animation:modalIn .2s ease';
    document.body.appendChild(t);
    setTimeout(function () { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 2200);
    setTimeout(function () { t.remove(); }, 2600);
  }

  // ---- Global top progress bar + centered loading overlay (auto-driven by any fetch) ----
  var barEl = null, inflight = 0, hideTimer = null;
  var overlayEl = null, showTimer = null;
  function ensureBar() {
    if (barEl) return barEl;
    barEl = document.createElement('div');
    barEl.id = 'topbar';
    document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(barEl); });
    if (document.body) document.body.appendChild(barEl);
    return barEl;
  }
  function ensureOverlay() {
    if (overlayEl) return overlayEl;
    overlayEl = document.createElement('div');
    overlayEl.id = 'loadOverlay';
    overlayEl.innerHTML = '<div class="load-spinner"><img src="logo.png?v=10" alt="Loading"/></div>';
    function attach() { if (document.body && overlayEl.parentNode !== document.body) document.body.appendChild(overlayEl); }
    document.addEventListener('DOMContentLoaded', attach);
    attach();
    return overlayEl;
  }
  function barStart() {
    ensureBar();
    inflight++;
    clearTimeout(hideTimer);
    barEl.classList.remove('done');
    barEl.classList.add('active');
    // Show the centered overlay only if the request takes longer than ~150ms
    // (avoids a distracting flash on fast calls).
    ensureOverlay();
    if (!showTimer) {
      showTimer = setTimeout(function () {
        showTimer = null;
        if (inflight > 0) overlayEl.classList.add('active');
      }, 150);
    }
  }
  function barStop() {
    inflight = Math.max(0, inflight - 1);
    if (inflight === 0) {
      clearTimeout(showTimer); showTimer = null;
      if (overlayEl) overlayEl.classList.remove('active');
      if (barEl) {
        barEl.classList.add('done');
        hideTimer = setTimeout(function () { barEl.classList.remove('active', 'done'); }, 250);
      }
    }
  }

  // Background polling endpoints should NOT trigger the visible loader
  // (they run on a timer and would otherwise flash the bar/overlay every 20s).
  var SILENT = ['/api/review/count', '/api/my-notifications/count'];
  function isSilent(url) {
    url = String(url || '');
    for (var i = 0; i < SILENT.length; i++) { if (url.indexOf(SILENT[i]) !== -1) return true; }
    return false;
  }

  // Wrap window.fetch so API calls drive the progress bar automatically,
  // except silent background polls.
  var _fetch = window.fetch;
  window.fetch = function () {
    var url = arguments[0];
    if (isSilent(url)) return _fetch.apply(this, arguments);
    barStart();
    return _fetch.apply(this, arguments).then(function (r) { barStop(); return r; },
      function (e) { barStop(); throw e; });
  };

  // Show an inline spinner + disable a button while an async action runs.
  // Usage: Hub.busy(btn, promise)  — returns the same promise.
  function busy(btn, promise) {
    if (!btn) return promise;
    var original = btn.innerHTML;
    btn.disabled = true;
    btn.classList.add('is-busy');
    btn.innerHTML = '<span class="btn-spinner"></span>' + original;
    function restore() { btn.disabled = false; btn.classList.remove('is-busy'); btn.innerHTML = original; }
    return promise.then(function (v) { restore(); return v; }, function (e) { restore(); throw e; });
  }

  // Guard against rapid repeated clicks (double/triple submit) WITHOUT disabling
  // the button — disabling made buttons grey-out and feel janky. Instead we swallow
  // a second click on the same button within a short window.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('button');
    if (!btn || btn.getAttribute('data-noguard') === '1') return;
    var now = Date.now();
    var last = Number(btn.getAttribute('data-lastclick') || 0);
    if (now - last < 500) { e.stopImmediatePropagation(); e.preventDefault(); return; }
    btn.setAttribute('data-lastclick', String(now));
  }, true); // capture phase: runs before the button's own handler

  // Role-based guide banner shown at the top of a page's <main>. Dismissible + remembered.
  // Usage: Hub.guide('dashboard', role, { administrator:{title,text}, accountant:{...}, ... })
  function guide(pageKey, role, byRole) {
    var info = byRole[role] || byRole['_default'];
    if (!info) return;
    var storeKey = 'guideHidden:' + pageKey + ':' + role;
    try { if (localStorage.getItem(storeKey) === '1') return; } catch (e) {}
    var main = document.querySelector('main.hub') || document.getElementById('main') || document.body;
    if (!main) return;
    var el = document.createElement('div');
    el.className = 'page-guide';
    el.innerHTML =
      '<span class="pg-em">' + (info.em || '💡') + '</span>' +
      '<div class="pg-body"><b>' + info.title + '</b><p>' + info.text + '</p></div>' +
      '<button class="pg-close" title="Dismiss" aria-label="Dismiss">×</button>';
    el.querySelector('.pg-close').addEventListener('click', function () {
      try { localStorage.setItem(storeKey, '1'); } catch (e) {}
      el.remove();
    });
    // Insert after the hub-head if present, otherwise at the very top.
    var head = main.querySelector('.hub-head');
    if (head && head.parentNode === main) main.insertBefore(el, head.nextSibling);
    else main.insertBefore(el, main.firstChild);
  }

  window.Hub = {
    STAGES: STAGES, STAGE_LABEL: STAGE_LABEL, DOC_CATEGORIES: DOC_CATEGORIES,
    pillClass: pillClass, clientStatusFromStage: clientStatusFromStage,
    fmtDate: fmtDate, fmtDateTime: fmtDateTime, modal: modal, toast: toast, busy: busy, guide: guide,
  };
})();

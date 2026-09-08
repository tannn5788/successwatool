// nav.js — shared auth + navigation helper for Elite Client Hub pages.
// Include with <script src="nav.js"></script> before a page's own script.
(function () {
  var AUTH_KEY = 'successwa.auth';

  function getAuth() {
    try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch (e) { return null; }
  }
  function setAuth(a) { localStorage.setItem(AUTH_KEY, JSON.stringify(a)); }
  function clearAuth() { localStorage.removeItem(AUTH_KEY); }

  function token() { var a = getAuth(); return a && a.token; }

  // Authenticated fetch wrapper. Adds Bearer token, parses JSON, throws on error.
  function api(path, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    if (!(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    var t = token();
    if (t) headers['Authorization'] = 'Bearer ' + t;
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401) { clearAuth(); location.href = 'login.html'; throw new Error('not authenticated'); }
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  var STAFF = ['administrator', 'supervisor', 'accountant', 'reception'];

  // Guard a page: require auth and (optionally) one of the given roles.
  function guard(allowedRoles) {
    var a = getAuth();
    if (!a || !a.token) { location.href = 'login.html'; return null; }
    if (allowedRoles && allowedRoles.indexOf(a.role) === -1) {
      // Redirect to the user's correct home instead of showing a forbidden page.
      location.href = homeFor(a.role);
      return null;
    }
    return a;
  }

  function homeFor(role) {
    return role === 'client' ? 'portal.html' : 'dashboard.html';
  }

  function logout() {
    api('/api/logout', { method: 'POST' }).catch(function () {}).then(function () {
      clearAuth(); location.href = 'login.html';
    });
  }

  // Render a top navigation bar into #topnav based on role.
  function renderNav(active) {
    var a = getAuth();
    if (!a) return;
    var links = [];
    if (a.role === 'client') {
      links = [
        ['portal.html', 'My Jobs'],
        ['personal.html', 'Tax Tracker'],
        ['help.html', 'Help'],
      ];
    } else {
      links = [['dashboard.html', 'Dashboard'], ['clients.html', 'Clients']];
      if (a.role === 'supervisor') links.push(['review.html', 'Review Queue']);
      if (a.role === 'administrator') links.push(['admin.html', 'Admin']);
      links.push(['help.html', 'Help']);
    }
    var el = document.getElementById('topnav');
    if (!el) return;
    var html = '<div class="nav-inner">' +
      '<a class="nav-brand" href="' + homeFor(a.role) + '">' +
        '<img src="logo.png?v=10" alt="Successwa"/>' +
        '<span class="nav-brand__sep" aria-hidden="true"></span>' +
        '<span class="nav-brand__label">Client Hub</span>' +
      '</a>' +
      '<nav class="nav-links">';
    links.forEach(function (l) {
      var isReview = l[0] === 'review.html';
      html += '<a href="' + l[0] + '"' + (l[0] === active ? ' class="active"' : '') +
        (isReview ? ' id="navReview"' : '') + '>' + l[1] +
        (isReview ? '<span class="nav-badge" id="navReviewBadge" style="display:none"></span>' : '') + '</a>';
    });
    html += '</nav>' +
      '<div class="nav-user">' +
      '<div class="nav-bell" id="navBell" title="Notifications">' +
        '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>' +
        '<span class="nav-badge bell-badge" id="navBellBadge" style="display:none"></span>' +
        '<div class="bell-panel" id="navBellPanel" style="display:none"></div>' +
      '</div>' +
      '<span class="nav-role role-' + a.role + '">' + a.role + '</span>' +
      '<span class="nav-email">' + (a.name || a.email) + '</span>' +
      '<button class="btn btn-ghost btn-sm" id="navLogout">Sign out</button></div>' +
      '</div>';
    el.innerHTML = html;
    var lo = document.getElementById('navLogout');
    if (lo) lo.addEventListener('click', logout);

    // Live badge: number of jobs awaiting supervisor review.
    if (a.role === 'supervisor') {
      var updateBadge = function () {
        api('/api/review/count').then(function (r) {
          var b = document.getElementById('navReviewBadge');
          if (!b) return;
          if (r.count > 0) { b.textContent = r.count; b.style.display = 'inline-flex'; }
          else { b.style.display = 'none'; }
        }).catch(function () {});
      };
      updateBadge();
      // Refresh every 20s so a supervisor sees new items without reloading.
      setInterval(updateBadge, 20000);
    }

    // ---- Notification bell (all users) ----
    var bell = document.getElementById('navBell');
    if (bell) {
      var badge = document.getElementById('navBellBadge');
      var panel = document.getElementById('navBellPanel');
      var panelOpen = false;

      var updateBell = function () {
        api('/api/my-notifications/count').then(function (r) {
          if (!badge) return;
          if (r.count > 0) { badge.textContent = r.count > 99 ? '99+' : r.count; badge.style.display = 'inline-flex'; }
          else { badge.style.display = 'none'; }
        }).catch(function () {});
      };

      var fmt = function (d) {
        try { return new Date(d).toLocaleString('en-AU', { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }); }
        catch (e) { return ''; }
      };

      var jobUrl = function (jobId) {
        if (!jobId) return null;
        // Clients don't have a per-job staff page; send them to their portal.
        return a.role === 'client' ? ('portal.html?job=' + encodeURIComponent(jobId))
          : ('job.html?id=' + encodeURIComponent(jobId));
      };

      var renderPanel = function (list) {
        var head = '<div class="bell-head"><span>Notifications</span>' +
          (list.length ? '<button class="bell-clear" id="bellClear">Clear all</button>' : '') + '</div>';
        if (!list.length) { panel.innerHTML = head + '<div class="bell-empty">No notifications yet.</div>'; return; }
        panel.innerHTML = head + list.map(function (n) {
          var url = jobUrl(n.job_id);
          return '<div class="bell-item' + (n.read_at ? '' : ' unread') + (url ? ' clickable' : '') + '"' +
            (url ? ' data-goto="' + esc(url) + '"' : '') + '>' +
            (n.job_id ? '<span class="bell-job">' + esc(n.job_id) + '</span>' : '') +
            '<div class="bell-subj">' + esc(n.subject || 'Notification') + '</div>' +
            '<div class="bell-body">' + esc(n.body || '') + '</div>' +
            '<div class="bell-time">' + fmt(n.created_at) + '</div>' +
          '</div>';
        }).join('');
        // Click a notification -> jump to the job.
        Array.prototype.forEach.call(panel.querySelectorAll('[data-goto]'), function (item) {
          item.addEventListener('click', function () { location.href = item.getAttribute('data-goto'); });
        });
        // Clear all button.
        var clr = panel.querySelector('#bellClear');
        if (clr) clr.addEventListener('click', function (e) {
          e.stopPropagation();
          api('/api/my-notifications/clear', { method: 'POST' }).then(function () {
            renderPanel([]);
            if (badge) badge.style.display = 'none';
          }).catch(function () {});
        });
      };

      var closePanel = function () { panel.style.display = 'none'; panelOpen = false; };
      var openPanel = function () {
        panel.innerHTML = '<div class="bell-empty">Loading…</div>';
        panel.style.display = 'block'; panelOpen = true;
        api('/api/my-notifications').then(function (r) {
          renderPanel(r.notifications || []);
          // Mark all read once the user has opened the panel.
          api('/api/my-notifications/read', { method: 'POST' }).then(function () {
            if (badge) badge.style.display = 'none';
          }).catch(function () {});
        }).catch(function () { panel.innerHTML = '<div class="bell-empty">Could not load.</div>'; });
      };

      bell.addEventListener('click', function (e) {
        e.stopPropagation();
        if (panelOpen) closePanel(); else openPanel();
      });
      document.addEventListener('click', function (e) {
        if (panelOpen && !panel.contains(e.target) && !bell.contains(e.target)) closePanel();
      });

      updateBell();
      setInterval(updateBell, 20000);
    }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  window.Nav = {
    getAuth: getAuth, setAuth: setAuth, clearAuth: clearAuth,
    api: api, guard: guard, logout: logout, renderNav: renderNav,
    homeFor: homeFor, STAFF: STAFF, esc: esc,
  };
})();

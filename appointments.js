// appointments.js — client online booking via Setmore + list of their bookings.
// Flow: pick a service → pick a staff member → pick a date (calendar) → pick a free slot → book.
// All Setmore calls go through our server so the token never touches the browser.
(function () {
  var auth = Nav.guard(['client']);
  if (!auth) return;
  Nav.renderNav('appointments.html');
  var esc = Nav.esc;
  var panel = document.getElementById('panel');

  Hub.guide('appointments', auth.role, {
    client: {
      em: '📅',
      title: 'Book an appointment',
      text: 'Choose a service, pick who you would like to see and a time that suits you. You will get a confirmation from our booking system.',
    },
  });

  injectStyles();

  var now = new Date();
  var state = {
    services: [], staff: [],
    service: null, staffMember: null,
    date: '', slots: [], slot: '',
    calY: now.getFullYear(), calM: now.getMonth(), // month shown in calendar
    loadingSlots: false,
    listData: { upcoming: [], past: [] },
  };

  var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var DOW = ['Su','Mo','Tu','We','Th','Fr','Sa'];

  function staffById(key) { for (var i = 0; i < state.staff.length; i++) { if (state.staff[i].key === key) return state.staff[i]; } return null; }

  function isoOf(y, m, d) {
    return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }
  function todayISO() { var d = new Date(); return isoOf(d.getFullYear(), d.getMonth(), d.getDate()); }

  function money(s) {
    if (!s.cost || Number(s.cost) === 0) return 'Free';
    return (s.currency ? s.currency + ' ' : '$') + Number(s.cost).toFixed(2);
  }

  function initial(name) { name = (name || '').trim(); return name ? name.charAt(0).toUpperCase() : '?'; }

  // ---------- appointments list ----------
  function apptItem(a, isUpcoming) {
    var actions = isUpcoming ?
      '<span style="display:flex;gap:6px;flex-shrink:0">' +
        '<button class="btn btn-ghost btn-xs" data-resched="' + esc(String(a.id)) + '">Reschedule</button>' +
        '<button class="btn btn-ghost btn-xs" data-cancelappt="' + esc(String(a.id)) + '">Cancel</button>' +
      '</span>' : '';
    return '<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--border,#eef0f2)">' +
      '<span style="font-size:20px">📅</span>' +
      '<span style="flex:1"><b style="display:block">' + esc(a.service_name || 'Appointment') + '</b>' +
        '<span class="muted small">' + Hub.fmtDateTime(a.start_time) + (a.staff_name ? ' · with ' + esc(a.staff_name) : '') + '</span></span>' +
      actions +
      '</div>';
  }

  function renderList() {
    var data = state.listData || {};
    var up = data.upcoming || [], past = data.past || [];
    var html = '<div class="card"><div class="section-title" style="margin-top:0">Your appointments</div>';
    if (!up.length && !past.length) {
      html += '<p class="muted small">No appointments yet. Book one below.</p>';
    } else {
      if (up.length) html += '<div style="margin-bottom:10px"><p class="small" style="font-weight:600;margin:0 0 2px">Upcoming</p>' + up.map(function (a) { return apptItem(a, true); }).join('') + '</div>';
      if (past.length) html += '<div><p class="small muted" style="font-weight:600;margin:8px 0 2px">Past</p>' + past.map(function (a) { return apptItem(a, false); }).join('') + '</div>';
    }
    html += '</div>';
    return html;
  }

  // ---------- step chips ----------
  function stepChips() {
    var steps = [
      { n: 1, label: 'Service', done: !!state.service },
      { n: 2, label: 'Staff', done: !!state.staffMember },
      { n: 3, label: 'Date', done: !!state.date },
      { n: 4, label: 'Time', done: !!state.slot },
    ];
    var cur = state.service ? (state.staffMember ? (state.date ? (state.slot ? 4 : 4) : 3) : 2) : 1;
    return '<div class="bk-steps">' + steps.map(function (s) {
      var cls = s.done ? 'done' : (s.n === cur ? 'active' : '');
      return '<span class="bk-step ' + cls + '"><i>' + (s.done ? '✓' : s.n) + '</i>' + s.label + '</span>';
    }).join('<span class="bk-sep"></span>') + '</div>';
  }

  // ---------- service cards ----------
  function renderServiceCards() {
    return '<div class="bk-grid">' + state.services.map(function (s) {
      var active = state.service && state.service.key === s.key;
      return '<button class="bk-card' + (active ? ' active' : '') + '" data-svc="' + esc(s.key) + '">' +
        '<span class="bk-card-title">' + esc(s.name) + '</span>' +
        '<span class="bk-card-meta">' + money(s) + (s.durationMins ? ' · ' + s.durationMins + ' min' : '') + '</span>' +
        (s.description ? '<span class="bk-card-desc">' + esc(s.description) + '</span>' : '') +
      '</button>';
    }).join('') + '</div>';
  }

  // ---------- staff cards ----------
  function renderStaffCards() {
    var eligible = state.staff.filter(function (st) { return (state.service.staffKeys || []).indexOf(st.key) !== -1; });
    if (!eligible.length) eligible = state.staff;
    return '<div class="bk-grid">' + eligible.map(function (st) {
      var active = state.staffMember && state.staffMember.key === st.key;
      var av = st.imageUrl ?
        '<span class="bk-av" style="background-image:url(' + esc(st.imageUrl) + ')"></span>' :
        '<span class="bk-av bk-av-txt">' + esc(initial(st.name)) + '</span>';
      return '<button class="bk-card bk-card-staff' + (active ? ' active' : '') + '" data-staff="' + esc(st.key) + '">' +
        av + '<span class="bk-card-title">' + esc(st.name) + '</span>' +
      '</button>';
    }).join('') + '</div>';
  }

  // ---------- calendar ----------
  function renderCalendar() {
    var y = state.calY, m = state.calM;
    var first = new Date(y, m, 1);
    var startDow = first.getDay();
    var daysInMonth = new Date(y, m + 1, 1).getDate();
    var today = todayISO();

    // Can we go to previous month? Only if it isn't entirely in the past.
    var nowY = now.getFullYear(), nowM = now.getMonth();
    var canPrev = (y > nowY) || (y === nowY && m > nowM);

    var cells = '';
    for (var i = 0; i < startDow; i++) cells += '<span class="bk-day bk-empty"></span>';
    for (var d = 1; d <= daysInMonth; d++) {
      var iso = isoOf(y, m, d);
      var past = iso < today;
      var sel = iso === state.date;
      var isToday = iso === today;
      var cls = 'bk-day' + (past ? ' past' : '') + (sel ? ' sel' : '') + (isToday ? ' today' : '');
      cells += past
        ? '<span class="' + cls + '">' + d + '</span>'
        : '<button class="' + cls + '" data-day="' + iso + '">' + d + '</button>';
    }

    var dowHead = DOW.map(function (w) { return '<span class="bk-dow">' + w + '</span>'; }).join('');

    return '<div class="bk-cal">' +
      '<div class="bk-cal-head">' +
        '<button class="bk-nav" data-cal="prev"' + (canPrev ? '' : ' disabled') + '>‹</button>' +
        '<span class="bk-cal-title">' + MONTHS[m] + ' ' + y + '</span>' +
        '<button class="bk-nav" data-cal="next">›</button>' +
      '</div>' +
      '<div class="bk-cal-grid">' + dowHead + cells + '</div>' +
    '</div>';
  }

  // ---------- slots ----------
  function renderSlots() {
    if (state.loadingSlots) return '<p class="muted small">Loading times…</p>';
    if (!state.slots.length) return '<p class="muted small">No free times on this day — try another date.</p>';
    return '<div class="bk-slots">' + state.slots.map(function (s) {
      var active = s === state.slot;
      return '<button class="bk-slot' + (active ? ' active' : '') + '" data-slot="' + esc(s) + '">' + esc(s) + '</button>';
    }).join('') + '</div>';
  }

  // ---------- booking card ----------
  function renderBooking() {
    if (!state.services.length) {
      return '<div class="card"><p class="muted">Online booking is not available right now. Please contact our office to arrange a meeting.</p></div>';
    }
    var canBook = state.service && state.staffMember && state.date && state.slot;

    var html = '<div class="card">' +
      '<div class="section-title" style="margin-top:0">Book a new appointment</div>' +
      stepChips();

    // Step 1: service
    html += '<div class="bk-sec"><div class="bk-label">1 · Choose a service</div>' + renderServiceCards() + '</div>';

    // Step 2: staff
    if (state.service) {
      html += '<div class="bk-sec"><div class="bk-label">2 · Who would you like to see?</div>' + renderStaffCards() + '</div>';
    }

    // Step 3 + 4: date & time side by side
    if (state.staffMember) {
      html += '<div class="bk-sec"><div class="bk-label">3 · Pick a date</div>' +
        '<div class="bk-datetime">' +
          renderCalendar() +
          '<div class="bk-times">' +
            '<div class="bk-times-head">' + (state.date ? 'Times on ' + Hub.fmtDate(state.date) : 'Select a date to see times') + '</div>' +
            (state.date ? renderSlots() : '') +
          '</div>' +
        '</div>' +
      '</div>';
    }

    html += '<div class="modal-actions" style="justify-content:flex-start;margin-top:14px">' +
        '<button class="btn btn-primary" id="bookBtn"' + (canBook ? '' : ' disabled') + '>Confirm booking</button>' +
        (canBook ? '<span class="muted small" style="align-self:center">' + esc(state.service.name) + ' · ' + Hub.fmtDate(state.date) + ' · ' + esc(state.slot) + '</span>' : '') +
      '</div>' +
    '</div>';
    return html;
  }

  // ---------- render orchestration ----------
  function paint() {
    panel.innerHTML = renderList() + renderBooking();
    bind();
  }

  function bind() {
    Array.prototype.forEach.call(panel.querySelectorAll('[data-svc]'), function (b) {
      b.addEventListener('click', function () {
        var key = b.getAttribute('data-svc');
        state.service = null;
        for (var i = 0; i < state.services.length; i++) { if (state.services[i].key === key) state.service = state.services[i]; }
        state.staffMember = null; state.date = ''; state.slots = []; state.slot = '';
        paint();
      });
    });
    Array.prototype.forEach.call(panel.querySelectorAll('[data-staff]'), function (b) {
      b.addEventListener('click', function () {
        state.staffMember = staffById(b.getAttribute('data-staff'));
        state.date = ''; state.slots = []; state.slot = '';
        paint();
      });
    });
    Array.prototype.forEach.call(panel.querySelectorAll('[data-cal]'), function (b) {
      b.addEventListener('click', function () {
        var dir = b.getAttribute('data-cal');
        if (dir === 'prev') { state.calM--; if (state.calM < 0) { state.calM = 11; state.calY--; } }
        else { state.calM++; if (state.calM > 11) { state.calM = 0; state.calY++; } }
        paint();
      });
    });
    Array.prototype.forEach.call(panel.querySelectorAll('[data-day]'), function (b) {
      b.addEventListener('click', function () {
        state.date = b.getAttribute('data-day');
        state.slot = ''; state.slots = [];
        loadSlots();
      });
    });
    Array.prototype.forEach.call(panel.querySelectorAll('[data-slot]'), function (b) {
      b.addEventListener('click', function () { state.slot = b.getAttribute('data-slot'); paint(); });
    });
    Array.prototype.forEach.call(panel.querySelectorAll('[data-cancelappt]'), function (b) {
      b.addEventListener('click', function () { cancelAppt(b.getAttribute('data-cancelappt')); });
    });
    Array.prototype.forEach.call(panel.querySelectorAll('[data-resched]'), function (b) {
      b.addEventListener('click', function () { rescheduleModal(b.getAttribute('data-resched')); });
    });
    var book = document.getElementById('bookBtn');
    if (book) book.addEventListener('click', doBook);
  }

  function apptById(id) {
    var all = (state.listData.upcoming || []).concat(state.listData.past || []);
    for (var i = 0; i < all.length; i++) { if (String(all[i].id) === String(id)) return all[i]; }
    return null;
  }

  function cancelAppt(id) {
    var a = apptById(id);
    var when = a ? Hub.fmtDateTime(a.start_time) : '';
    var m = Hub.modal('Cancel appointment',
      '<p>Cancel your <b>' + esc(a ? (a.service_name || 'appointment') : 'appointment') + '</b>' + (when ? ' on <b>' + esc(when) + '</b>' : '') + '?</p>' +
      '<p class="muted small">This will release the time slot. You can book a new appointment anytime.</p>' +
      '<div class="modal-actions"><button class="btn btn-ghost" id="cKeep">Keep it</button><button class="btn btn-danger" id="cGo">Cancel appointment</button></div>');
    m.q('#cKeep').addEventListener('click', m.close);
    m.q('#cGo').addEventListener('click', function () {
      Hub.busy(m.q('#cGo'), Nav.api('/api/portal/appointments/' + encodeURIComponent(id) + '/cancel', { method: 'POST' }))
        .then(function () { m.close(); Hub.toast('Appointment cancelled'); refreshList().then(paint); })
        .catch(function (e) { Hub.toast(e.message); });
    });
  }

  // Reschedule: keep the same service + staff, pick a new date + slot.
  function rescheduleModal(id) {
    var a = apptById(id);
    if (!a || !a.service_key || !a.staff_key) { Hub.toast('This appointment cannot be rescheduled online. Please contact our office.'); return; }
    var rs = { date: '', slots: [], slot: '', loading: false, calY: now.getFullYear(), calM: now.getMonth() };
    var m = Hub.modal('Reschedule appointment', '<div id="rsBody"></div>');
    function paintRs() {
      var canSave = rs.date && rs.slot;
      m.q('#rsBody').innerHTML =
        '<p class="muted small">' + esc(a.service_name || 'Appointment') + (a.staff_name ? ' · with ' + esc(a.staff_name) : '') +
          '<br>Currently: <b>' + esc(Hub.fmtDateTime(a.start_time)) + '</b></p>' +
        '<div class="bk-datetime">' + renderCalRs() +
          '<div class="bk-times"><div class="bk-times-head">' + (rs.date ? 'Times on ' + Hub.fmtDate(rs.date) : 'Select a date to see times') + '</div>' +
          (rs.date ? renderSlotsRs() : '') + '</div>' +
        '</div>' +
        '<div class="modal-actions"><button class="btn btn-ghost" id="rsCancel">Close</button>' +
          '<button class="btn btn-primary" id="rsSave"' + (canSave ? '' : ' disabled') + '>Confirm new time</button></div>';
      bindRs();
    }
    function renderCalRs() {
      var y = rs.calY, m2 = rs.calM;
      var first = new Date(y, m2, 1); var startDow = first.getDay();
      var daysInMonth = new Date(y, m2 + 1, 1).getDate(); var today = todayISO();
      var canPrev = (y > now.getFullYear()) || (y === now.getFullYear() && m2 > now.getMonth());
      var cells = '';
      for (var i = 0; i < startDow; i++) cells += '<span class="bk-day bk-empty"></span>';
      for (var d = 1; d <= daysInMonth; d++) {
        var iso = isoOf(y, m2, d); var past = iso < today; var sel = iso === rs.date; var isToday = iso === today;
        var cls = 'bk-day' + (past ? ' past' : '') + (sel ? ' sel' : '') + (isToday ? ' today' : '');
        cells += past ? '<span class="' + cls + '">' + d + '</span>' : '<button class="' + cls + '" data-rsday="' + iso + '">' + d + '</button>';
      }
      var dowHead = DOW.map(function (w) { return '<span class="bk-dow">' + w + '</span>'; }).join('');
      return '<div class="bk-cal"><div class="bk-cal-head">' +
        '<button class="bk-nav" data-rscal="prev"' + (canPrev ? '' : ' disabled') + '>‹</button>' +
        '<span class="bk-cal-title">' + MONTHS[m2] + ' ' + y + '</span>' +
        '<button class="bk-nav" data-rscal="next">›</button></div>' +
        '<div class="bk-cal-grid">' + dowHead + cells + '</div></div>';
    }
    function renderSlotsRs() {
      if (rs.loading) return '<p class="muted small">Loading times…</p>';
      if (!rs.slots.length) return '<p class="muted small">No free times on this day — try another date.</p>';
      return '<div class="bk-slots">' + rs.slots.map(function (s) {
        return '<button class="bk-slot' + (s === rs.slot ? ' active' : '') + '" data-rsslot="' + esc(s) + '">' + esc(s) + '</button>';
      }).join('') + '</div>';
    }
    function loadSlotsRs() {
      rs.loading = true; paintRs();
      var q = '?staffKey=' + encodeURIComponent(a.staff_key) + '&serviceKey=' + encodeURIComponent(a.service_key) + '&date=' + encodeURIComponent(rs.date);
      Nav.api('/api/appointments/slots' + q).then(function (r) {
        rs.slots = r.slots || []; rs.slot = ''; rs.loading = false; paintRs();
      }).catch(function (e) { rs.loading = false; rs.slots = []; paintRs(); Hub.toast(e.message); });
    }
    function bindRs() {
      Array.prototype.forEach.call(m.q('#rsBody').querySelectorAll('[data-rscal]'), function (b) {
        b.addEventListener('click', function () {
          if (b.getAttribute('data-rscal') === 'prev') { rs.calM--; if (rs.calM < 0) { rs.calM = 11; rs.calY--; } }
          else { rs.calM++; if (rs.calM > 11) { rs.calM = 0; rs.calY++; } }
          paintRs();
        });
      });
      Array.prototype.forEach.call(m.q('#rsBody').querySelectorAll('[data-rsday]'), function (b) {
        b.addEventListener('click', function () { rs.date = b.getAttribute('data-rsday'); rs.slot = ''; rs.slots = []; loadSlotsRs(); });
      });
      Array.prototype.forEach.call(m.q('#rsBody').querySelectorAll('[data-rsslot]'), function (b) {
        b.addEventListener('click', function () { rs.slot = b.getAttribute('data-rsslot'); paintRs(); });
      });
      m.q('#rsCancel').addEventListener('click', m.close);
      var save = m.q('#rsSave');
      if (save) save.addEventListener('click', function () {
        if (!(rs.date && rs.slot)) return;
        Hub.busy(save, Nav.api('/api/portal/appointments/' + encodeURIComponent(id) + '/reschedule', { method: 'POST', body: {
          date: rs.date, slot: rs.slot, durationMins: (a.service && a.service.durationMins) || 30 } }))
          .then(function () { m.close(); Hub.toast('Appointment rescheduled'); refreshList().then(paint); })
          .catch(function (e) { Hub.toast(e.message); });
      });
    }
    paintRs();
  }

  function refreshList() {
    return Nav.api('/api/portal/appointments').then(function (data) {
      state.listData = data || { upcoming: [], past: [] };
    }).catch(function () {});
  }

  function loadSlots() {
    if (!state.staffMember || !state.date || !state.service) return;
    state.loadingSlots = true; paint();
    var q = '?staffKey=' + encodeURIComponent(state.staffMember.key) +
            '&serviceKey=' + encodeURIComponent(state.service.key) +
            '&date=' + encodeURIComponent(state.date);
    Nav.api('/api/appointments/slots' + q).then(function (r) {
      state.slots = r.slots || []; state.slot = ''; state.loadingSlots = false;
      paint();
    }).catch(function (e) { state.loadingSlots = false; state.slots = []; paint(); Hub.toast(e.message); });
  }

  function doBook(ev) {
    if (!(state.service && state.staffMember && state.date && state.slot)) return;
    var body = {
      serviceKey: state.service.key, serviceName: state.service.name,
      staffKey: state.staffMember.key, staffName: state.staffMember.name,
      date: state.date, slot: state.slot, durationMins: state.service.durationMins || 30,
    };
    Hub.busy(ev.target, Nav.api('/api/portal/appointments', { method: 'POST', body: body }))
      .then(function () {
        Hub.toast('Appointment booked!');
        state.service = null; state.staffMember = null; state.date = ''; state.slots = []; state.slot = '';
        refreshList().then(paint);
      })
      .catch(function (e) { Hub.toast(e.message); });
  }

  // Load services + staff first, then the list, then paint.
  Nav.api('/api/appointments/services').then(function (r) {
    state.services = r.services || [];
    state.staff = r.staff || [];
    return refreshList();
  }).then(function () {
    paint();
  }).catch(function (e) {
    panel.innerHTML = '<div class="card"><p class="muted">Online booking is unavailable right now: ' + esc(e.message) + '</p></div>';
  });

  // ---------- styles ----------
  function injectStyles() {
    if (document.getElementById('bk-styles')) return;
    var css = ''
      + '.bk-steps{display:flex;align-items:center;gap:0;margin:6px 0 18px;flex-wrap:wrap}'
      + '.bk-step{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:#98a2b3;font-weight:600}'
      + '.bk-step i{width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:#eef0f2;color:#98a2b3;font-style:normal;font-size:12px}'
      + '.bk-step.active{color:#111}.bk-step.active i{background:#111;color:#fff}'
      + '.bk-step.done{color:#0a7d3b}.bk-step.done i{background:#0a7d3b;color:#fff}'
      + '.bk-sep{flex:1;height:2px;background:#eef0f2;margin:0 8px;min-width:12px}'
      + '.bk-sec{margin-top:16px}'
      + '.bk-label{font-size:13px;font-weight:700;color:#344054;margin-bottom:8px}'
      + '.bk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}'
      + '.bk-card{text-align:left;border:1.5px solid #e4e7ec;background:#fff;border-radius:12px;padding:12px 14px;cursor:pointer;display:flex;flex-direction:column;gap:3px;transition:all .12s}'
      + '.bk-card:hover{border-color:#c0c4cc;box-shadow:0 2px 6px rgba(0,0,0,.05)}'
      + '.bk-card.active{border-color:#111;box-shadow:0 0 0 1px #111}'
      + '.bk-card-title{font-weight:700;font-size:14px;color:#111}'
      + '.bk-card-meta{font-size:12.5px;color:#667085;font-weight:600}'
      + '.bk-card-desc{font-size:12px;color:#98a2b3;margin-top:2px;line-height:1.35}'
      + '.bk-card-staff{flex-direction:row;align-items:center;gap:10px}'
      + '.bk-av{width:34px;height:34px;border-radius:50%;background-size:cover;background-position:center;background-color:#eef0f2;flex:0 0 auto}'
      + '.bk-av-txt{display:inline-flex;align-items:center;justify-content:center;font-weight:700;color:#667085;font-size:14px}'
      + '.bk-datetime{display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start}'
      + '.bk-cal{width:280px;border:1.5px solid #e4e7ec;border-radius:12px;padding:12px}'
      + '.bk-cal-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}'
      + '.bk-cal-title{font-weight:700;font-size:14px;color:#111}'
      + '.bk-nav{border:1px solid #e4e7ec;background:#fff;border-radius:8px;width:30px;height:30px;cursor:pointer;font-size:18px;line-height:1;color:#344054}'
      + '.bk-nav:hover:not(:disabled){background:#f7f8fa}.bk-nav:disabled{opacity:.35;cursor:default}'
      + '.bk-cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}'
      + '.bk-dow{text-align:center;font-size:11px;font-weight:700;color:#98a2b3;padding:4px 0}'
      + '.bk-day{aspect-ratio:1;border:none;background:none;border-radius:8px;cursor:pointer;font-size:13px;color:#111;display:flex;align-items:center;justify-content:center;padding:0}'
      + '.bk-day:hover:not(.past):not(.sel){background:#f2f4f7}'
      + '.bk-day.past{color:#cfd4dc;cursor:default}'
      + '.bk-day.today{font-weight:800;box-shadow:inset 0 0 0 1.5px #c0c4cc}'
      + '.bk-day.sel{background:#111;color:#fff;font-weight:700}'
      + '.bk-empty{visibility:hidden}'
      + '.bk-times{flex:1;min-width:220px}'
      + '.bk-times-head{font-size:13px;font-weight:700;color:#344054;margin-bottom:8px}'
      + '.bk-slots{display:grid;grid-template-columns:repeat(auto-fill,minmax(84px,1fr));gap:8px}'
      + '.bk-slot{border:1.5px solid #e4e7ec;background:#fff;border-radius:10px;padding:9px 6px;cursor:pointer;font-size:13px;font-weight:600;color:#111;transition:all .12s}'
      + '.bk-slot:hover{border-color:#c0c4cc}'
      + '.bk-slot.active{background:#111;color:#fff;border-color:#111}';
    var st = document.createElement('style');
    st.id = 'bk-styles'; st.textContent = css;
    document.head.appendChild(st);
  }
})();

// insights.js — staff analytics dashboard with real SVG charts + per-account customization.
// Reads /api/insights/summary and /api/me/prefs/insights.
// Users can hide/show widgets, reorder them (drag), and switch some chart types.
(function () {
  var auth = Nav.guard(Nav.STAFF);
  if (!auth) return;
  Nav.renderNav('insights.html');
  var esc = Nav.esc;
  var wrap = document.getElementById('wrap');

  var cap = function (s) { return String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1); };
  var PAL = ['#96701a', '#c01f2e', '#2f7d4f', '#2f65b0', '#b8912c', '#7a7266', '#8a4b8f', '#0f766e'];

  // ---------- chart primitives (return HTML strings) ----------
  function panelBody(rows) { return rows; } // helper placeholder

  function donutSvg(rows, valueKey) {
    var total = rows.reduce(function (s, r) { return s + r[valueKey]; }, 0) || 1;
    var R = 54, r = 33, cx = 60, cy = 60, C = 2 * Math.PI * ((R + r) / 2), sw = R - r, off = 0, segs = '';
    rows.forEach(function (row, i) {
      var len = (row[valueKey] / total) * C;
      segs += '<circle cx="' + cx + '" cy="' + cy + '" r="' + ((R + r) / 2) + '" fill="none" stroke="' + PAL[i % PAL.length] +
        '" stroke-width="' + sw + '" stroke-dasharray="' + len + ' ' + (C - len) + '" stroke-dashoffset="' + (-off) +
        '" transform="rotate(-90 ' + cx + ' ' + cy + ')"></circle>';
      off += len;
    });
    return { total: total, svg: '<svg class="svg-chart donut" width="120" height="120" viewBox="0 0 120 120">' + segs +
      '<text class="donut-hole-num" x="60" y="58" text-anchor="middle" dominant-baseline="middle">' + total + '</text>' +
      '<text class="donut-hole-lbl" x="60" y="74" text-anchor="middle">Total</text></svg>' };
  }

  function donut(rows, labelKey, valueKey, labelFn) {
    if (!rows || !rows.length) return empty();
    var d = donutSvg(rows, valueKey);
    var legend = '<div class="legend">' + rows.map(function (row, i) {
      var lbl = labelFn ? labelFn(row[labelKey]) : row[labelKey];
      var pct = Math.round((row[valueKey] / d.total) * 100);
      return '<div class="legend-row"><span class="legend-sw" style="background:' + PAL[i % PAL.length] + '"></span>' +
        '<span class="legend-lbl" title="' + esc(String(lbl)) + '">' + esc(String(lbl)) + '</span>' +
        '<span class="legend-val">' + row[valueKey] + '<span class="legend-pct">' + pct + '%</span></span></div>';
    }).join('') + '</div>';
    return '<div class="donut-wrap">' + d.svg + legend + '</div>';
  }

  function columnChart(rows, labelKey, valueKey, labelFn, color) {
    if (!rows || !rows.length) return empty();
    var W = 300, H = 190, padL = 26, padR = 8, padT = 12, padB = 40;
    var iw = W - padL - padR, ih = H - padT - padB;
    var max = Math.max.apply(null, rows.map(function (r) { return r[valueKey]; })) || 1;
    var step = Math.max(1, Math.ceil(max / 3)); max = step * 3;
    var bw = iw / rows.length, bar = Math.min(38, bw * 0.6), grid = '';
    for (var g = 0; g <= 3; g++) {
      var gy = padT + ih - (g / 3) * ih;
      grid += '<line class="grid-line" x1="' + padL + '" y1="' + gy + '" x2="' + (W - padR) + '" y2="' + gy + '"></line>' +
        '<text class="axis-lbl" x="' + (padL - 5) + '" y="' + (gy + 3) + '" text-anchor="end">' + (step * g) + '</text>';
    }
    var bars = rows.map(function (row, i) {
      var h = (row[valueKey] / max) * ih, bx = padL + i * bw + (bw - bar) / 2, by = padT + ih - h;
      var c = color || PAL[i % PAL.length];
      var lbl = String(labelFn ? labelFn(row[labelKey]) : row[labelKey]); if (lbl.length > 10) lbl = lbl.slice(0, 9) + '…';
      return '<rect class="col-bar" x="' + bx.toFixed(1) + '" y="' + by.toFixed(1) + '" width="' + bar.toFixed(1) +
        '" height="' + Math.max(h, 1).toFixed(1) + '" rx="2" fill="' + c + '"></rect>' +
        '<text class="val-lbl" x="' + (bx + bar / 2).toFixed(1) + '" y="' + (by - 5).toFixed(1) + '" text-anchor="middle">' + row[valueKey] + '</text>' +
        '<text class="axis-lbl" x="' + (bx + bar / 2).toFixed(1) + '" y="' + (padT + ih + 14) + '" text-anchor="middle">' + esc(lbl) + '</text>';
    }).join('');
    return '<svg class="svg-chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">' + grid + bars + '</svg>';
  }

  function barChart(rows, labelKey, valueKey, labelFn, palette) {
    if (!rows || !rows.length) return empty();
    var max = Math.max.apply(null, rows.map(function (r) { return r[valueKey]; })) || 1;
    return rows.map(function (r, i) {
      var pct = Math.round((r[valueKey] / max) * 100);
      var lbl = labelFn ? labelFn(r[labelKey]) : r[labelKey];
      var c = (palette && palette[String(r[labelKey]).toLowerCase()]) || PAL[i % PAL.length];
      return '<div class="bc-row"><div class="bc-lbl" title="' + esc(String(lbl)) + '">' + esc(String(lbl)) + '</div>' +
        '<div class="bc-track"><div class="bc-fill" style="width:' + Math.max(pct, 3) + '%;--bc-c:' + c + '"></div></div>' +
        '<div class="bc-val">' + r[valueKey] + '</div></div>';
    }).join('');
  }

  function lineChart(months, series) {
    if (!months.length) return empty();
    var W = 620, H = 210, padL = 30, padR = 14, padT = 14, padB = 26;
    var iw = W - padL - padR, ih = H - padT - padB, max = 1;
    series.forEach(function (s) { months.forEach(function (k) { max = Math.max(max, s.data[k] || 0); }); });
    var step = Math.max(1, Math.ceil(max / 4)); max = step * 4;
    var x = function (i) { return padL + (months.length === 1 ? iw / 2 : (i / (months.length - 1)) * iw); };
    var y = function (v) { return padT + ih - (v / max) * ih; };
    var grid = '';
    for (var g = 0; g <= 4; g++) {
      var gy = padT + ih - (g / 4) * ih;
      grid += '<line class="grid-line" x1="' + padL + '" y1="' + gy + '" x2="' + (W - padR) + '" y2="' + gy + '"></line>' +
        '<text class="axis-lbl" x="' + (padL - 6) + '" y="' + (gy + 3) + '" text-anchor="end">' + (step * g) + '</text>';
    }
    var xlbls = months.map(function (k, i) {
      return '<text class="axis-lbl" x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(k.slice(5) + '/' + k.slice(2, 4)) + '</text>';
    }).join('');
    var paths = series.map(function (s, si) {
      var color = s.color || PAL[si % PAL.length];
      var d = months.map(function (k, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(s.data[k] || 0).toFixed(1); }).join(' ');
      var dots = months.map(function (k, i) { return '<circle class="line-dot" cx="' + x(i).toFixed(1) + '" cy="' + y(s.data[k] || 0).toFixed(1) + '" r="3.5" fill="' + color + '"></circle>'; }).join('');
      return '<path class="line-path" d="' + d + '" stroke="' + color + '"></path>' + dots;
    }).join('');
    var legend = '<div class="chart-legend">' + series.map(function (s, si) {
      return '<span><i style="background:' + (s.color || PAL[si % PAL.length]) + '"></i>' + esc(s.name) + '</span>';
    }).join('') + '</div>';
    return '<svg class="svg-chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">' + grid + xlbls + paths + '</svg>' + legend;
  }

  function empty() { return '<div class="chart-empty">No data yet</div>'; }

  // ---------- widget registry ----------
  // Each widget: id, title, kind ('kpi'|'chart'), section, render(res)->html.
  // Charts that support multiple types expose `types` + render honours current type.
  var SCOPE = 'insights';
  var registry = [];
  function reg(w) { registry.push(w); }

  function buildRegistry(res) {
    registry = [];
    var stageMap = res.stageMap || {};
    var stageLabel = function (s) { return (stageMap[s] && stageMap[s].internalLabel) || s; };
    var priorityPalette = { high: '#c01f2e', normal: '#2f65b0', low: '#2f7d4f' };
    var docPalette = { verified: '#2f7d4f', received: '#2f65b0', incorrect: '#c01f2e', info_required: '#b8912c' };

    // KPI widgets — [id, title, value, cls, defaultHidden]
    var kpis = [
      ['kpi.active', 'Active jobs', res.active, ''],
      ['kpi.completed', 'Completed', res.completed, 'pos'],
      ['kpi.overdue', 'Overdue', res.overdue, res.overdue ? 'alert' : ''],
      ['kpi.high', 'High priority', res.highPriority, res.highPriority ? 'alert' : ''],
      ['kpi.hold', 'On hold', res.onHold, res.onHold ? 'alert' : ''],
      ['kpi.docsreview', 'Docs to review', res.docsToReview, res.docsToReview ? 'alert' : ''],
      ['kpi.outstanding', 'Outstanding requests', res.outstandingDocs, res.outstandingDocs ? 'alert' : ''],
      ['kpi.appts', 'Upcoming appts', res.upcomingAppts, ''],
      ['kpi.clients', res.scoped ? 'My clients' : 'Total clients', res.clients, ''],
      // opt-in KPIs (hidden by default so existing dashboards don't change)
      ['kpi.newweek', 'New this week', res.newThisWeek, '', true],
      ['kpi.doneweek', 'Completed this week', res.completedThisWeek, 'pos', true],
      ['kpi.apptsweek', 'Appts next 7 days', res.apptsThisWeek, '', true],
      ['kpi.completionrate', 'Completion rate', (res.completionRate != null ? res.completionRate + '%' : '—'), 'pos', true],
      ['kpi.stageage', 'Avg days in stage', res.avgStageAge, '', true]
    ];
    kpis.forEach(function (k) {
      reg({ id: k[0], title: k[1], kind: 'kpi', section: 'Overview', defaultHidden: !!k[4], render: function () {
        var cls = k[3] === 'alert' ? ' k-alert' : (k[3] === 'pos' ? ' k-pos' : '');
        return '<div class="kpi' + cls + '"><div class="kpi-num">' + k[2] + '</div><div class="kpi-label">' + esc(k[1]) + '</div></div>';
      } });
    });

    // trend data
    var monthSet = {};
    (res.intake || []).forEach(function (r) { monthSet[r.month] = 1; });
    (res.throughput || []).forEach(function (r) { monthSet[r.month] = 1; });
    var months = Object.keys(monthSet).sort();
    var intakeData = {}, doneData = {};
    (res.intake || []).forEach(function (r) { intakeData[r.month] = r.n; });
    (res.throughput || []).forEach(function (r) { doneData[r.month] = r.n; });

    // Chart widgets
    reg({ id: 'chart.trend', title: 'Intake vs completed · 6 months', kind: 'chart', section: 'Workflow', span2: true,
      render: function () { return lineChart(months, [
        { name: 'New jobs', data: intakeData, color: '#2f65b0' },
        { name: 'Completed', data: doneData, color: '#2f7d4f' }]); } });

    reg({ id: 'chart.byStage', title: 'Active jobs by stage', kind: 'chart', section: 'Workflow',
      types: ['donut', 'bars'], defaultType: 'donut',
      render: function (t) { return t === 'bars'
        ? barChart(res.byStage, 'stage', 'n', stageLabel)
        : donut(res.byStage, 'stage', 'n', stageLabel); } });

    reg({ id: 'chart.byType', title: 'Active jobs by type', kind: 'chart', section: 'Workflow',
      types: ['column', 'bars', 'donut'], defaultType: 'column',
      render: function (t) {
        if (t === 'bars') return barChart(res.byType, 'type', 'n', null);
        if (t === 'donut') return donut(res.byType, 'type', 'n', null);
        return columnChart(res.byType, 'type', 'n', null, '#96701a');
      } });

    reg({ id: 'chart.byPriority', title: 'Active jobs by priority', kind: 'chart', section: 'Workflow',
      types: ['donut', 'bars'], defaultType: 'donut',
      render: function (t) { return t === 'bars'
        ? barChart(res.byPriority, 'priority', 'n', cap, priorityPalette)
        : donut(res.byPriority, 'priority', 'n', cap); } });

    reg({ id: 'chart.docsByStatus', title: 'Documents by status', kind: 'chart', section: 'Documents & clients',
      types: ['donut', 'bars'], defaultType: 'donut',
      render: function (t) {
        var lf = function (s) { return cap(String(s).replace('_', ' ')); };
        return t === 'bars' ? barChart(res.docsByStatus, 'status', 'n', lf, docPalette)
          : donut(res.docsByStatus, 'status', 'n', lf);
      } });

    if (!res.scoped) {
      reg({ id: 'chart.workload', title: 'Active workload by staff', kind: 'chart', section: 'Documents & clients',
        render: function () { return barChart(res.workload, 'staff', 'n'); } });
    }

    // ---- user-defined custom widgets (from prefs.custom) ----
    (prefs.custom || []).forEach(function (cw) {
      var g = groupingInfo(res, cw.groupBy);
      if (!g) return;
      reg({ id: cw.id, title: cw.title || g.defaultTitle, kind: 'chart', section: 'Custom', custom: true,
        types: ['donut', 'bars', 'column'], defaultType: cw.chart || 'bars',
        render: function (t) {
          var type = t || cw.chart || 'bars';
          if (type === 'donut') return donut(g.rows, g.labelKey, 'n', g.labelFn);
          if (type === 'column') return columnChart(g.rows, g.labelKey, 'n', g.labelFn);
          return barChart(g.rows, g.labelKey, 'n', g.labelFn);
        } });
    });
  }

  // Maps a grouping key to its precomputed rows + label helpers (server-computed, no user SQL).
  function groupingInfo(res, key) {
    var stageMap = res.stageMap || {};
    var stageLabel = function (s) { return (stageMap[s] && stageMap[s].internalLabel) || s; };
    switch (key) {
      case 'stage': return { rows: res.byStage, labelKey: 'stage', labelFn: stageLabel, defaultTitle: 'Active jobs by Stage' };
      case 'type': return { rows: res.byType, labelKey: 'type', labelFn: null, defaultTitle: 'Active jobs by Type' };
      case 'priority': return { rows: res.byPriority, labelKey: 'priority', labelFn: cap, defaultTitle: 'Active jobs by Priority' };
      case 'year': return { rows: res.byYear, labelKey: 'year', labelFn: null, defaultTitle: 'Active jobs by Financial year' };
      case 'staff': return res.scoped ? null : { rows: res.workload, labelKey: 'staff', labelFn: null, defaultTitle: 'Active jobs by Staff' };
      default: return null;
    }
  }

  // ---------- prefs ----------
  // prefs shape: { order:[id], hidden:{id:true}, shown:{id:true}, types:{id:'donut'}, custom:[{id,title,groupBy,chart}] }
  var prefs = { order: [], hidden: {}, shown: {}, types: {}, custom: [] };

  function widgetById(id) {
    for (var i = 0; i < registry.length; i++) if (registry[i].id === id) return registry[i];
    return null;
  }
  // Visibility with tri-state defaults:
  // - normal widget: visible unless in hidden{}
  // - defaultHidden widget (opt-in KPI): hidden unless explicitly in shown{}
  function isHidden(w) {
    if (w.defaultHidden) return !(prefs.shown && prefs.shown[w.id]);
    return !!(prefs.hidden && prefs.hidden[w.id]);
  }
  // Effective ordered list: saved order first (that still exist), then any new widgets.
  function orderedWidgets() {
    var seen = {}, out = [];
    (prefs.order || []).forEach(function (id) {
      var w = widgetById(id); if (w && !seen[id]) { seen[id] = 1; out.push(w); }
    });
    registry.forEach(function (w) { if (!seen[w.id]) out.push(w); });
    return out;
  }
  function typeFor(w) { return (prefs.types && prefs.types[w.id]) || w.defaultType || (w.types && w.types[0]); }

  // ---------- render dashboard ----------
  var activeFilters = { fy: '', type: '', priority: '', staff: '', months: 6 };

  function selHtml(id, label, options, cur) {
    var placeholder = label ? '<option value="">' + esc(label) + '</option>' : '';
    var opts = placeholder + options.map(function (o) {
      var v = o.value, t = o.label;
      return '<option value="' + esc(String(v)) + '"' + (String(v) === String(cur) ? ' selected' : '') + '>' + esc(String(t)) + '</option>';
    }).join('');
    return '<select class="ins-filter" data-f="' + id + '">' + opts + '</select>';
  }

  function filterBar(res) {
    var fo = res.filterOptions || {};
    var f = res.filters || activeFilters;
    var parts = [];
    parts.push(selHtml('fy', 'All years', (fo.years || []).map(function (y) { return { value: y, label: y }; }), f.fy));
    parts.push(selHtml('type', 'All types', (fo.types || []).map(function (t) { return { value: t, label: t }; }), f.type));
    parts.push(selHtml('priority', 'All priorities', (fo.priorities || []).map(function (p) { return { value: p, label: cap(p) }; }), f.priority));
    if (!res.scoped) {
      parts.push(selHtml('staff', 'All staff', (fo.staff || []).map(function (s) { return { value: s.email, label: s.name }; }), f.staff));
    }
    parts.push(selHtml('months', '', [3, 6, 12].map(function (m) { return { value: m, label: 'Last ' + m + ' mo' }; }), f.months));
    var anyActive = f.fy || f.type || f.priority || f.staff;
    var clearBtn = anyActive ? '<button class="btn btn-sm" id="clearFilters" type="button">Clear</button>' : '';
    return '<div class="ins-filters">' + parts.join('') + clearBtn + '</div>';
  }

  function scopeLine(res) {
    return '<div class="ins-scope-bar">' +
      '<span class="ins-scope">' + (res.scoped ? 'Assigned to you' : 'Firm-wide · all staff & clients') + '</span>' +
      filterBar(res) +
      '<button class="btn btn-sm" id="addWidgetBtn" type="button">+ Add widget</button>' +
      '<button class="btn btn-sm" id="customizeBtn" type="button">Customize</button></div>';
  }

  function renderDashboard(res) {
    var list = orderedWidgets().filter(function (w) { return !isHidden(w); });
    // group into sections in the order sections first appear
    var sectionsOrder = [], bySection = {};
    list.forEach(function (w) {
      if (!bySection[w.section]) { bySection[w.section] = []; sectionsOrder.push(w.section); }
      bySection[w.section].push(w);
    });
    var html = scopeLine(res);
    sectionsOrder.forEach(function (sec) {
      html += '<div class="ins-sec"><h2>' + esc(sec) + '</h2></div>';
      var items = bySection[sec];
      var kpiItems = items.filter(function (w) { return w.kind === 'kpi'; });
      var chartItems = items.filter(function (w) { return w.kind === 'chart'; });
      if (kpiItems.length) {
        html += '<div class="ins-kpis" data-dnd="1">' + kpiItems.map(function (w) {
          return w.render().replace('<div class="kpi', '<div draggable="true" data-id="' + w.id + '" class="ins-drag kpi');
        }).join('') + '</div>';
      }
      if (chartItems.length) {
        html += '<div class="ins-charts" data-dnd="1">' + chartItems.map(function (w) {
          var t = typeFor(w);
          return '<div class="ins-drag chart-card' + (w.span2 ? ' span2' : '') + '" draggable="true" data-id="' + w.id + '">' +
            '<div class="chart-title"><span class="chart-grip" title="Drag to move">⠿</span> <span>' + esc(w.title) + '</span></div>' + w.render(t) + '</div>';
        }).join('') + '</div>';
      }
    });
    if (!list.length) html += '<p class="muted" style="margin-top:20px">All widgets are hidden. Click <b>Customize</b> to add some back.</p>';
    wrap.innerHTML = html;
    document.getElementById('customizeBtn').addEventListener('click', openCustomize);
    document.getElementById('addWidgetBtn').addEventListener('click', openAddWidget);
    bindFilters();
    enableBoardDnd();
  }

  // ---------- filters ----------
  function bindFilters() {
    Array.prototype.forEach.call(wrap.querySelectorAll('.ins-filter'), function (sel) {
      sel.addEventListener('change', function () {
        var key = sel.getAttribute('data-f');
        activeFilters[key] = key === 'months' ? parseInt(sel.value, 10) : sel.value;
        reload();
      });
    });
    var clr = document.getElementById('clearFilters');
    if (clr) clr.addEventListener('click', function () {
      activeFilters = { fy: '', type: '', priority: '', staff: '', months: activeFilters.months };
      reload();
    });
  }

  function queryString() {
    var f = activeFilters, qs = [];
    if (f.fy) qs.push('fy=' + encodeURIComponent(f.fy));
    if (f.type) qs.push('type=' + encodeURIComponent(f.type));
    if (f.priority) qs.push('priority=' + encodeURIComponent(f.priority));
    if (f.staff) qs.push('staff=' + encodeURIComponent(f.staff));
    if (f.months) qs.push('months=' + encodeURIComponent(f.months));
    return qs.length ? '?' + qs.join('&') : '';
  }

  function reload() {
    wrap.classList.add('ins-loading');
    Nav.api('/api/insights/summary' + queryString()).then(function (res) {
      current = res;
      buildRegistry(current);
      renderDashboard(current);
      wrap.classList.remove('ins-loading');
    }).catch(function (e) {
      wrap.classList.remove('ins-loading');
      alert('Could not load: ' + e.message);
    });
  }

  // ---------- on-screen (dashboard) drag reorder ----------
  function persistOrderFromBoard() {
    var ids = Array.prototype.map.call(wrap.querySelectorAll('.ins-drag'), function (el) { return el.getAttribute('data-id'); });
    // keep any hidden widgets (not in DOM) appended so they aren't lost
    (prefs.order || []).forEach(function (id) { if (ids.indexOf(id) === -1) ids.push(id); });
    prefs.order = ids;
    savePrefs();
  }
  function enableBoardDnd() {
    var grids = wrap.querySelectorAll('[data-dnd]');
    var dragEl = null;
    Array.prototype.forEach.call(grids, function (grid) {
      grid.addEventListener('dragstart', function (e) {
        var el = e.target.closest('.ins-drag'); if (!el) return;
        dragEl = el; el.classList.add('ins-dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', el.getAttribute('data-id') || ''); } catch (err) {}
        }
      });
      grid.addEventListener('dragend', function () {
        if (dragEl) { dragEl.classList.remove('ins-dragging'); persistOrderFromBoard(); }
        dragEl = null;
      });
      grid.addEventListener('dragover', function (e) {
        // only reorder within the grid the drag started in (KPIs with KPIs, charts with charts)
        if (!dragEl || dragEl.parentNode !== grid) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        var after = getBoardAfter(grid, e.clientX, e.clientY);
        if (after == null) grid.appendChild(dragEl);
        else grid.insertBefore(dragEl, after);
      });
    });
  }
  // grids are multi-column, so pick the nearest element by both axes
  function getBoardAfter(container, xx, yy) {
    var els = Array.prototype.slice.call(container.querySelectorAll('.ins-drag:not(.ins-dragging)'));
    var closest = { dist: Infinity, el: null };
    els.forEach(function (child) {
      var box = child.getBoundingClientRect();
      var cx = box.left + box.width / 2, cy = box.top + box.height / 2;
      // only consider elements whose center is at or after the cursor
      if (cy - yy > box.height * 0.5 || (Math.abs(cy - yy) <= box.height * 0.5 && cx >= xx)) {
        var d = Math.pow(cx - xx, 2) + Math.pow(cy - yy, 2);
        if (d < closest.dist) closest = { dist: d, el: child };
      }
    });
    return closest.el;
  }

  // ---------- customize panel ----------
  function openCustomize() {
    var ordered = orderedWidgets();
    var rows = ordered.map(function (w) {
      var hidden = isHidden(w);
      var typeSel = '';
      if (w.types && w.types.length > 1) {
        typeSel = '<select class="cz-type" data-id="' + w.id + '">' + w.types.map(function (t) {
          return '<option value="' + t + '"' + (t === typeFor(w) ? ' selected' : '') + '>' + cap(t) + '</option>';
        }).join('') + '</select>';
      }
      var removeBtn = w.custom ? '<button class="cz-remove" data-id="' + w.id + '" title="Remove widget" type="button">✕</button>' : '';
      return '<li class="cz-row" draggable="true" data-id="' + w.id + '">' +
        '<span class="cz-grip" title="Drag to reorder">⋮⋮</span>' +
        '<label class="cz-name"><input type="checkbox" class="cz-show" data-id="' + w.id + '"' + (hidden ? '' : ' checked') + '> ' + esc(w.title) + '</label>' +
        '<span class="cz-kind">' + (w.custom ? 'custom' : w.kind) + '</span>' + typeSel + removeBtn + '</li>';
    }).join('');
    var html = '<div class="cz-backdrop" id="czBackdrop"></div>' +
      '<div class="cz-panel" role="dialog" aria-label="Customize dashboard">' +
        '<div class="cz-head"><h3>Customize dashboard</h3><button class="cz-x" id="czClose" type="button">✕</button></div>' +
        '<p class="cz-hint">Drag to reorder · tick to show · pick a chart type. Saved to your account.</p>' +
        '<ul class="cz-list" id="czList">' + rows + '</ul>' +
        '<div class="cz-actions">' +
          '<button class="btn btn-sm" id="czReset" type="button">Reset to default</button>' +
          '<span style="flex:1"></span>' +
          '<button class="btn btn-sm" id="czCancel" type="button">Cancel</button>' +
          '<button class="btn btn-sm btn-primary" id="czSave" type="button">Save</button>' +
        '</div>' +
      '</div>';
    var holder = document.createElement('div');
    holder.id = 'czHolder';
    holder.innerHTML = html;
    document.body.appendChild(holder);
    bindCustomize();
  }
  function closeCustomize() {
    var h = document.getElementById('czHolder');
    if (h) h.parentNode.removeChild(h);
  }

  function bindCustomize() {
    document.getElementById('czClose').addEventListener('click', closeCustomize);
    document.getElementById('czCancel').addEventListener('click', closeCustomize);
    document.getElementById('czBackdrop').addEventListener('click', closeCustomize);

    // drag reorder
    var listEl = document.getElementById('czList');
    var dragEl = null;
    listEl.addEventListener('dragstart', function (e) {
      var li = e.target.closest('.cz-row'); if (!li) return;
      dragEl = li; li.classList.add('cz-dragging');
      // Firefox will not start a drag unless some data is set.
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', li.getAttribute('data-id') || ''); } catch (err) {}
      }
    });
    listEl.addEventListener('dragend', function () { if (dragEl) dragEl.classList.remove('cz-dragging'); dragEl = null; });
    listEl.addEventListener('dragover', function (e) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      var after = getDragAfter(listEl, e.clientY);
      if (!dragEl) return;
      if (after == null) listEl.appendChild(dragEl);
      else listEl.insertBefore(dragEl, after);
    });

    // remove a custom widget
    Array.prototype.forEach.call(listEl.querySelectorAll('.cz-remove'), function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        var id = btn.getAttribute('data-id');
        var li = btn.closest('.cz-row'); if (li) li.parentNode.removeChild(li);
        prefs.custom = (prefs.custom || []).filter(function (c) { return c.id !== id; });
      });
    });

    document.getElementById('czReset').addEventListener('click', function () {
      prefs = { order: [], hidden: {}, shown: {}, types: {}, custom: [] };
      savePrefs(function () { closeCustomize(); buildRegistry(current); renderDashboard(current); });
    });
    document.getElementById('czSave').addEventListener('click', function () {
      // read order
      var order = Array.prototype.map.call(listEl.querySelectorAll('.cz-row'), function (li) { return li.getAttribute('data-id'); });
      var hidden = {}, shown = {};
      Array.prototype.forEach.call(listEl.querySelectorAll('.cz-show'), function (cb) {
        var id = cb.getAttribute('data-id');
        var w = widgetById(id);
        if (w && w.defaultHidden) { if (cb.checked) shown[id] = true; }
        else if (!cb.checked) hidden[id] = true;
      });
      var types = {};
      Array.prototype.forEach.call(listEl.querySelectorAll('.cz-type'), function (sel) {
        types[sel.getAttribute('data-id')] = sel.value;
      });
      prefs = { order: order, hidden: hidden, shown: shown, types: types, custom: prefs.custom || [] };
      savePrefs(function () { closeCustomize(); buildRegistry(current); renderDashboard(current); });
    });
  }

  function getDragAfter(container, yy) {
    var els = Array.prototype.slice.call(container.querySelectorAll('.cz-row:not(.cz-dragging)'));
    var closest = { offset: -Infinity, el: null };
    els.forEach(function (child) {
      var box = child.getBoundingClientRect();
      var offset = yy - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) closest = { offset: offset, el: child };
    });
    return closest.el;
  }

  // ---------- add-widget builder ----------
  function openAddWidget() {
    var groupings = (current && current.groupings) || [];
    var groupOpts = groupings.map(function (g) { return '<option value="' + g.key + '">' + esc(g.label) + '</option>'; }).join('');
    var chartOpts = [['bars', 'Bars'], ['column', 'Column'], ['donut', 'Donut']]
      .map(function (c) { return '<option value="' + c[0] + '">' + c[1] + '</option>'; }).join('');
    var html = '<div class="cz-backdrop" id="awBackdrop"></div>' +
      '<div class="cz-panel aw-panel" role="dialog" aria-label="Add widget">' +
        '<div class="cz-head"><h3>Add widget</h3><button class="cz-x" id="awClose" type="button">✕</button></div>' +
        '<p class="cz-hint">Build a chart from your job data. It respects the active filters and is saved to your account.</p>' +
        '<div class="aw-form">' +
          '<label class="aw-field"><span>Group by</span><select id="awGroup">' + groupOpts + '</select></label>' +
          '<label class="aw-field"><span>Chart type</span><select id="awChart">' + chartOpts + '</select></label>' +
          '<label class="aw-field"><span>Title</span><input type="text" id="awTitle" maxlength="60" placeholder="Active jobs by Type"></label>' +
        '</div>' +
        '<div class="cz-actions">' +
          '<span style="flex:1"></span>' +
          '<button class="btn btn-sm" id="awCancel" type="button">Cancel</button>' +
          '<button class="btn btn-sm btn-primary" id="awAdd" type="button">Add to dashboard</button>' +
        '</div>' +
      '</div>';
    var holder = document.createElement('div');
    holder.id = 'awHolder';
    holder.innerHTML = html;
    document.body.appendChild(holder);

    function close() { var h = document.getElementById('awHolder'); if (h) h.parentNode.removeChild(h); }
    function defaultTitle() {
      var g = groupingInfo(current, document.getElementById('awGroup').value);
      return g ? g.defaultTitle : 'Custom chart';
    }
    var titleEl = document.getElementById('awTitle');
    titleEl.placeholder = defaultTitle();
    document.getElementById('awGroup').addEventListener('change', function () { titleEl.placeholder = defaultTitle(); });
    document.getElementById('awClose').addEventListener('click', close);
    document.getElementById('awCancel').addEventListener('click', close);
    document.getElementById('awBackdrop').addEventListener('click', close);
    document.getElementById('awAdd').addEventListener('click', function () {
      var groupBy = document.getElementById('awGroup').value;
      var chart = document.getElementById('awChart').value;
      var title = (titleEl.value || '').trim() || defaultTitle();
      if (!groupBy) return;
      var cw = { id: 'custom.' + Date.now(), title: title, groupBy: groupBy, chart: chart };
      prefs.custom = (prefs.custom || []).concat([cw]);
      savePrefs(function () { close(); buildRegistry(current); renderDashboard(current); });
    });
  }

  // ---------- data + prefs load ----------
  var current = null;
  function savePrefs(done) {
    Nav.api('/api/me/prefs/' + SCOPE, { method: 'PUT', body: { prefs: prefs } })
      .then(function () { done && done(); })
      .catch(function (e) { alert('Could not save: ' + e.message); done && done(); });
  }

  Promise.all([
    Nav.api('/api/insights/summary'),
    Nav.api('/api/me/prefs/' + SCOPE).catch(function () { return { prefs: {} }; })
  ]).then(function (out) {
    current = out[0];
    if (current && current.filters) {
      activeFilters = {
        fy: current.filters.fy || '', type: current.filters.type || '',
        priority: current.filters.priority || '', staff: current.filters.staff || '',
        months: current.filters.months || 6
      };
    }
    var p = (out[1] && out[1].prefs) || {};
    var custom = Array.isArray(p.custom) ? p.custom.filter(function (c) {
      return c && typeof c === 'object' && c.id && c.groupBy;
    }) : [];
    prefs = { order: p.order || [], hidden: p.hidden || {}, shown: p.shown || {}, types: p.types || {}, custom: custom };
    buildRegistry(current);
    renderDashboard(current);
  }).catch(function (e) {
    wrap.innerHTML = '<p class="muted">Error: ' + esc(e.message) + '</p>';
  });
})();

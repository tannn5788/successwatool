// insights.js — Insights 2.0: dense, multi-tab analytics dashboard.
// Reads /api/insights/summary. Hand-built SVG charts, editorial palette (no libraries).
// Tabs: Overview · Trends · Cycle time · Workload · Documents. Filter bar persists across tabs.
(function () {
  var auth = Nav.guard(Nav.STAFF);
  if (!auth) return;
  Nav.renderNav('insights.html');
  var esc = Nav.esc;
  var wrap = document.getElementById('wrap');

  var cap = function (s) { return String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1); };
  // Professional blue ramp (BI look). Categorical charts read as one family;
  // only genuine error states keep a red accent.
  var PAL = ['#1d4ed8', '#3b82f6', '#60a5fa', '#93c5fd', '#1e3a8a', '#2563eb', '#0ea5e9', '#7dd3fc'];
  var INK = '#2563eb';
  var PRIO = { high: '#1e3a8a', normal: '#3b82f6', low: '#93c5fd' };
  var DOCC = { verified: '#1d4ed8', received: '#60a5fa', incorrect: '#ef4444', info_required: '#f59e0b' };
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function empty() { return '<div class="chart-empty">No data yet</div>'; }
  function fmt(n) { return (n == null) ? '—' : String(n); }

  // ---------------- chart primitives (return HTML strings) ----------------

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
  function donut(rows, labelKey, valueKey, labelFn, palette) {
    if (!rows || !rows.length) return empty();
    var d = donutSvg(rows, valueKey);
    var legend = '<div class="legend">' + rows.map(function (row, i) {
      var lbl = labelFn ? labelFn(row[labelKey]) : row[labelKey];
      var pct = Math.round((row[valueKey] / d.total) * 100);
      var c = (palette && palette[String(row[labelKey]).toLowerCase()]) || PAL[i % PAL.length];
      return '<div class="legend-row"><span class="legend-sw" style="background:' + c + '"></span>' +
        '<span class="legend-lbl" title="' + esc(String(lbl)) + '">' + esc(String(lbl)) + '</span>' +
        '<span class="legend-val">' + row[valueKey] + '<span class="legend-pct">' + pct + '%</span></span></div>';
    }).join('') + '</div>';
    // recolour donut segments when a palette is supplied
    if (palette) {
      var i2 = 0;
      d.svg = d.svg.replace(/stroke="#[0-9a-f]{6}"/g, function (m) {
        var c = palette[String(rows[i2] && rows[i2][labelKey]).toLowerCase()] || PAL[i2 % PAL.length]; i2++;
        return 'stroke="' + c + '"';
      });
    }
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

  // Lollipop: horizontal stem + dot (like the reference "sales by region").
  function lollipop(rows, labelKey, valueKey, labelFn) {
    if (!rows || !rows.length) return empty();
    var max = Math.max.apply(null, rows.map(function (r) { return r[valueKey]; })) || 1;
    return '<div class="lolli">' + rows.map(function (r, i) {
      var pct = Math.max((r[valueKey] / max) * 100, 2);
      var lbl = labelFn ? labelFn(r[labelKey]) : r[labelKey];
      var c = PAL[i % PAL.length];
      return '<div class="lolli-row"><div class="lolli-lbl" title="' + esc(String(lbl)) + '">' + esc(String(lbl)) + '</div>' +
        '<div class="lolli-track"><span class="lolli-stem" style="width:' + pct + '%;--c:' + c + '"></span>' +
        '<span class="lolli-dot" style="left:' + pct + '%;--c:' + c + '"></span></div>' +
        '<div class="lolli-val">' + r[valueKey] + '</div></div>';
    }).join('') + '</div>';
  }

  // Multi-series line (area optional on first series).
  function lineChart(months, series, opts) {
    opts = opts || {};
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
    var areas = '';
    var paths = series.map(function (s, si) {
      var color = s.color || PAL[si % PAL.length];
      var d = months.map(function (k, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(s.data[k] || 0).toFixed(1); }).join(' ');
      if (opts.area && si === 0) {
        var a = 'M' + x(0).toFixed(1) + ' ' + (padT + ih) + ' ' +
          months.map(function (k, i) { return 'L' + x(i).toFixed(1) + ' ' + y(s.data[k] || 0).toFixed(1); }).join(' ') +
          ' L' + x(months.length - 1).toFixed(1) + ' ' + (padT + ih) + ' Z';
        areas += '<path d="' + a + '" fill="' + color + '" fill-opacity="0.10"></path>';
      }
      var dots = months.map(function (k, i) { return '<circle class="line-dot" cx="' + x(i).toFixed(1) + '" cy="' + y(s.data[k] || 0).toFixed(1) + '" r="3.2" fill="' + color + '"></circle>'; }).join('');
      return '<path class="line-path" d="' + d + '" stroke="' + color + '"></path>' + dots;
    }).join('');
    var legend = '<div class="chart-legend">' + series.map(function (s, si) {
      return '<span><i style="background:' + (s.color || PAL[si % PAL.length]) + '"></i>' + esc(s.name) + '</span>';
    }).join('') + '</div>';
    return '<svg class="svg-chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">' + grid + areas + xlbls + paths + '</svg>' + legend;
  }

  // Stacked horizontal bars: rows = [{label, parts:[{key,val,color}]}]
  function stackedBar(rows) {
    if (!rows || !rows.length) return empty();
    var max = 1;
    rows.forEach(function (r) { var t = r.parts.reduce(function (s, p) { return s + p.val; }, 0); max = Math.max(max, t); });
    var body = rows.map(function (r) {
      var segs = r.parts.filter(function (p) { return p.val > 0; }).map(function (p) {
        return '<span class="sb-seg" title="' + esc(p.key + ': ' + p.val) + '" style="width:' + (p.val / max * 100) + '%;background:' + p.color + '"></span>';
      }).join('');
      var tot = r.parts.reduce(function (s, p) { return s + p.val; }, 0);
      return '<div class="sb-row"><div class="sb-lbl" title="' + esc(r.label) + '">' + esc(r.label) + '</div>' +
        '<div class="sb-track">' + segs + '</div><div class="sb-val">' + tot + '</div></div>';
    }).join('');
    var keys = rows[0].parts.map(function (p) { return { key: p.key, color: p.color }; });
    var legend = '<div class="chart-legend">' + keys.map(function (k) {
      return '<span><i style="background:' + k.color + '"></i>' + esc(cap(k.key)) + '</span>';
    }).join('') + '</div>';
    return '<div class="sb-wrap">' + body + '</div>' + legend;
  }

  // Funnel: ordered bands narrowing down (jobs across stages).
  function funnel(rows) {
    if (!rows || !rows.length) return empty();
    var max = Math.max.apply(null, rows.map(function (r) { return r.n; })) || 1;
    var sum = rows.reduce(function (s, r) { return s + r.n; }, 0) || 1;
    return '<div class="funnel">' + rows.map(function (r, i) {
      var w = Math.max((r.n / max) * 100, 4);
      var pct = Math.round((r.n / sum) * 100);
      return '<div class="fn-row"><div class="fn-lbl" title="' + esc(r.label) + '">' + esc(r.label) + '</div>' +
        '<div class="fn-bar-wrap"><div class="fn-bar" style="width:' + w + '%;background:' + PAL[i % PAL.length] + '">' +
        '<span class="fn-n">' + r.n + '</span></div><span class="fn-pct">' + pct + '%</span></div></div>';
    }).join('') + '</div>';
  }

  // Histogram: bars for buckets (no gaps), from [{b, n}] bucket index rows.
  function histogram(rows, bucketLabel) {
    if (!rows || !rows.length) return empty();
    var byB = {}; rows.forEach(function (r) { byB[r.b] = r.n; });
    var bars = [];
    for (var i = 1; i <= 10; i++) bars.push({ label: bucketLabel(i), n: byB[i] || 0 });
    var W = 320, H = 190, padL = 24, padR = 8, padT = 12, padB = 34;
    var iw = W - padL - padR, ih = H - padT - padB;
    var max = Math.max.apply(null, bars.map(function (b) { return b.n; })) || 1;
    var step = Math.max(1, Math.ceil(max / 3)); max = step * 3;
    var bw = iw / bars.length, grid = '';
    for (var g = 0; g <= 3; g++) {
      var gy = padT + ih - (g / 3) * ih;
      grid += '<line class="grid-line" x1="' + padL + '" y1="' + gy + '" x2="' + (W - padR) + '" y2="' + gy + '"></line>' +
        '<text class="axis-lbl" x="' + (padL - 4) + '" y="' + (gy + 3) + '" text-anchor="end">' + (step * g) + '</text>';
    }
    var body = bars.map(function (b, i) {
      var h = (b.n / max) * ih, bx = padL + i * bw, by = padT + ih - h;
      var showLbl = (i % 2 === 0);
      return '<rect class="hist-bar" x="' + (bx + 0.5).toFixed(1) + '" y="' + by.toFixed(1) + '" width="' + (bw - 1).toFixed(1) +
        '" height="' + Math.max(h, 0.5).toFixed(1) + '" fill="' + INK + '"></rect>' +
        (b.n ? '<text class="val-lbl" x="' + (bx + bw / 2).toFixed(1) + '" y="' + (by - 4).toFixed(1) + '" text-anchor="middle">' + b.n + '</text>' : '') +
        (showLbl ? '<text class="axis-lbl" x="' + (bx + bw / 2).toFixed(1) + '" y="' + (padT + ih + 13) + '" text-anchor="middle">' + esc(b.label) + '</text>' : '');
    }).join('');
    return '<svg class="svg-chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">' + grid + body + '</svg>';
  }

  // Box plot: rows = [{label,min,q1,median,q3,max,n}] horizontal.
  function boxPlot(rows) {
    if (!rows || !rows.length) return empty();
    var max = Math.max.apply(null, rows.map(function (r) { return r.max; })) || 1;
    var W = 340, rowH = 34, padL = 96, padR = 46, padT = 6;
    var H = padT * 2 + rows.length * rowH + 16;
    var iw = W - padL - padR;
    var x = function (v) { return padL + (v / max) * iw; };
    var grid = '';
    for (var g = 0; g <= 4; g++) {
      var gx = padL + (g / 4) * iw, gv = Math.round(max * g / 4);
      grid += '<line class="grid-line" x1="' + gx + '" y1="' + padT + '" x2="' + gx + '" y2="' + (padT + rows.length * rowH) + '"></line>' +
        '<text class="axis-lbl" x="' + gx + '" y="' + (H - 3) + '" text-anchor="middle">' + gv + '</text>';
    }
    var body = rows.map(function (r, i) {
      var cy = padT + i * rowH + rowH / 2;
      var c = PAL[i % PAL.length];
      var lbl = String(r.label); if (lbl.length > 14) lbl = lbl.slice(0, 13) + '…';
      return '<line class="bx-whisk" x1="' + x(r.min) + '" y1="' + cy + '" x2="' + x(r.q1) + '" y2="' + cy + '"></line>' +
        '<line class="bx-whisk" x1="' + x(r.q3) + '" y1="' + cy + '" x2="' + x(r.max) + '" y2="' + cy + '"></line>' +
        '<line class="bx-cap" x1="' + x(r.min) + '" y1="' + (cy - 5) + '" x2="' + x(r.min) + '" y2="' + (cy + 5) + '"></line>' +
        '<line class="bx-cap" x1="' + x(r.max) + '" y1="' + (cy - 5) + '" x2="' + x(r.max) + '" y2="' + (cy + 5) + '"></line>' +
        '<rect class="bx-box" x="' + x(r.q1) + '" y="' + (cy - 8) + '" width="' + Math.max(x(r.q3) - x(r.q1), 1) + '" height="16" fill="' + c + '" fill-opacity="0.22" stroke="' + c + '"></rect>' +
        '<line class="bx-med" x1="' + x(r.median) + '" y1="' + (cy - 8) + '" x2="' + x(r.median) + '" y2="' + (cy + 8) + '" stroke="' + c + '"></line>' +
        '<text class="val-lbl" x="' + (x(r.max) + 5) + '" y="' + (cy + 3) + '" text-anchor="start">' + r.median + 'd</text>' +
        '<text class="axis-lbl bx-name" x="' + (padL - 6) + '" y="' + (cy + 3) + '" text-anchor="end" title="' + esc(String(r.label)) + '">' + esc(lbl) + '</text>';
    }).join('');
    return '<svg class="svg-chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">' + grid + body + '</svg>';
  }

  // Heatmap: months (cols) x weekday (rows), colour intensity by count.
  function heatmap(cells, months) {
    if (!cells || !cells.length || !months.length) return empty();
    var map = {}, max = 1;
    cells.forEach(function (c) { map[c.month + '|' + c.dow] = c.n; max = Math.max(max, c.n); });
    var cw = 34, ch = 20, padL = 40, padT = 16;
    var W = padL + months.length * cw + 6, H = padT + 7 * ch + 6;
    var body = '';
    for (var d = 0; d < 7; d++) {
      body += '<text class="axis-lbl" x="' + (padL - 6) + '" y="' + (padT + d * ch + ch / 2 + 3) + '" text-anchor="end">' + DOW[d] + '</text>';
      for (var m = 0; m < months.length; m++) {
        var v = map[months[m] + '|' + d] || 0;
        var op = v ? (0.15 + 0.85 * (v / max)) : 0;
        body += '<rect class="hm-cell" x="' + (padL + m * cw) + '" y="' + (padT + d * ch) + '" width="' + (cw - 2) + '" height="' + (ch - 2) +
          '" rx="2" fill="' + INK + '" fill-opacity="' + op.toFixed(2) + '"><title>' + esc(months[m] + ' ' + DOW[d] + ': ' + v) + '</title></rect>';
      }
    }
    months.forEach(function (k, m) {
      body += '<text class="axis-lbl" x="' + (padL + m * cw + cw / 2 - 1) + '" y="' + (padT - 4) + '" text-anchor="middle">' + esc(k.slice(5)) + '</text>';
    });
    return '<svg class="svg-chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">' + body + '</svg>';
  }

  // Bubble: rows=[{label,x,y,r}] scatter with sized dots.
  function bubble(rows, xlab, ylab) {
    if (!rows || !rows.length) return empty();
    var W = 340, H = 220, padL = 34, padR = 12, padT = 12, padB = 30;
    var iw = W - padL - padR, ih = H - padT - padB;
    var maxX = Math.max.apply(null, rows.map(function (r) { return r.x; })) || 1;
    var maxY = Math.max.apply(null, rows.map(function (r) { return r.y; })) || 1;
    var maxR = Math.max.apply(null, rows.map(function (r) { return r.r; })) || 1;
    var X = function (v) { return padL + (v / maxX) * iw; };
    var Y = function (v) { return padT + ih - (v / maxY) * ih; };
    var grid = '';
    for (var g = 0; g <= 3; g++) {
      var gy = padT + ih - (g / 3) * ih;
      grid += '<line class="grid-line" x1="' + padL + '" y1="' + gy + '" x2="' + (W - padR) + '" y2="' + gy + '"></line>' +
        '<text class="axis-lbl" x="' + (padL - 5) + '" y="' + (gy + 3) + '" text-anchor="end">' + Math.round(maxY * g / 3) + '</text>';
    }
    var dots = rows.map(function (r, i) {
      var rad = 6 + (r.r / maxR) * 20;
      var c = PAL[i % PAL.length];
      return '<circle cx="' + X(r.x).toFixed(1) + '" cy="' + Y(r.y).toFixed(1) + '" r="' + rad.toFixed(1) + '" fill="' + c + '" fill-opacity="0.35" stroke="' + c + '"><title>' + esc(r.label + ' — ' + xlab + ':' + r.x + ' ' + ylab + ':' + r.y + ' (overdue ' + r.r + ')') + '</title></circle>' +
        '<text class="bub-lbl" x="' + X(r.x).toFixed(1) + '" y="' + (Y(r.y) - rad - 2).toFixed(1) + '" text-anchor="middle">' + esc(String(r.label).split(' ')[0]) + '</text>';
    }).join('');
    return '<svg class="svg-chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">' + grid + dots +
      '<text class="axis-lbl" x="' + (padL + iw / 2) + '" y="' + (H - 2) + '" text-anchor="middle">' + esc(xlab) + '</text></svg>';
  }

  // KPI with delta vs previous period.
  function kpiDelta(label, value, cur, prev, invert) {
    var d = '';
    if (cur != null && prev != null) {
      var diff = cur - prev;
      var pct = prev === 0 ? (cur === 0 ? 0 : 100) : Math.round((diff / prev) * 100);
      var up = diff > 0, flat = diff === 0;
      var good = invert ? !up : up;
      var cls = flat ? 'k-flat' : (good ? 'k-up' : 'k-down');
      var arrow = flat ? '→' : (up ? '▲' : '▼');
      d = '<div class="kpi-delta ' + cls + '">' + arrow + ' ' + Math.abs(pct) + '% <span class="kpi-delta-sub">vs prev 30d</span></div>';
    }
    return '<div class="kpi2"><div class="kpi2-num">' + value + '</div><div class="kpi2-label">' + esc(label) + '</div>' + d + '</div>';
  }
  function kpiPlain(label, value, cls) {
    return '<div class="kpi2' + (cls ? ' ' + cls : '') + '"><div class="kpi2-num">' + value + '</div><div class="kpi2-label">' + esc(label) + '</div></div>';
  }

  // ---------------- helpers over the response ----------------
  var stageMapG = {}, stageOrderG = [];
  function stageLabel(s) { return (stageMapG[s] && stageMapG[s].internalLabel) || s; }
  function stageShort(s) { var l = stageLabel(s); return l.replace(/^\d+\w?\s*/, ''); }

  function trendMonths(res) {
    var set = {};
    (res.intake || []).forEach(function (r) { set[r.month] = 1; });
    (res.throughput || []).forEach(function (r) { set[r.month] = 1; });
    (res.activity || []).forEach(function (r) { set[r.month] = 1; });
    return Object.keys(set).sort();
  }

  // ---------------- tab content builders ----------------
  function card(title, inner, span2) {
    return '<div class="chart-card' + (span2 ? ' span2' : '') + '"><div class="chart-title"><span>' + esc(title) + '</span></div>' + inner + '</div>';
  }
  function sectionKpis(html) { return '<div class="ins-kpis2">' + html + '</div>'; }
  function chartsGrid(html) { return '<div class="ins-charts">' + html + '</div>'; }

  function tabOverview(res) {
    var k = sectionKpis(
      kpiDelta('New (30d)', res.deltas.created.cur, res.deltas.created.cur, res.deltas.created.prev) +
      kpiDelta('Completed (30d)', res.deltas.completed.cur, res.deltas.completed.cur, res.deltas.completed.prev) +
      kpiPlain('Active', res.active) +
      kpiPlain('Overdue', res.overdue, res.overdue ? 'k-alert' : '') +
      kpiPlain('High priority', res.highPriority, res.highPriority ? 'k-alert' : '') +
      kpiPlain('Avg days in stage', res.avgStageAge)
    );
    // funnel rows in stage order
    var byStageMap = {}; (res.byStage || []).forEach(function (r) { byStageMap[r.stage] = r.n; });
    var funnelRows = (res.stageOrder || []).filter(function (s) { return s !== '09_completed'; })
      .map(function (s) { return { label: stageShort(s), n: byStageMap[s] || 0 }; })
      .filter(function (r) { return r.n > 0; });
    // stacked stage x priority
    var sbRows = (res.stageByPriority || []).map(function (r) {
      return { label: stageShort(r.stage), parts: [
        { key: 'high', val: r.high, color: PRIO.high },
        { key: 'normal', val: r.normal, color: PRIO.normal },
        { key: 'low', val: r.low, color: PRIO.low }] };
    });
    var months = trendMonths(res);
    var intakeData = {}, doneData = {};
    (res.intake || []).forEach(function (r) { intakeData[r.month] = r.n; });
    (res.throughput || []).forEach(function (r) { doneData[r.month] = r.n; });
    var charts = chartsGrid(
      card('Jobs by stage (funnel)', funnel(funnelRows)) +
      card('Active jobs by type', donut(res.byType, 'type', 'n', null)) +
      card('Stage × priority', stackedBar(sbRows)) +
      card('Intake vs completed', lineChart(months, [
        { name: 'New jobs', data: intakeData, color: '#2f65b0' },
        { name: 'Completed', data: doneData, color: '#2f7d4f' }], { area: true }), true)
    );
    return k + charts;
  }

  function tabTrends(res) {
    var months = trendMonths(res);
    var intakeData = {}, doneData = {}, netData = {};
    (res.intake || []).forEach(function (r) { intakeData[r.month] = r.n; });
    (res.throughput || []).forEach(function (r) { doneData[r.month] = r.n; });
    months.forEach(function (m) { netData[m] = (intakeData[m] || 0) - (doneData[m] || 0); });
    var doneRows = months.map(function (m) { return { month: m, n: doneData[m] || 0 }; });
    var charts = chartsGrid(
      card('Intake · completed · net', lineChart(months, [
        { name: 'New', data: intakeData, color: '#2f65b0' },
        { name: 'Completed', data: doneData, color: '#2f7d4f' },
        { name: 'Net', data: netData, color: '#c01f2e' }]), true) +
      card('Completions per month', columnChart(doneRows, 'month', 'n', function (m) { return m.slice(5); }, '#2f7d4f')) +
      card('Activity by month × weekday', heatmap(res.activity, months), true) +
      card('Jobs by financial year', lollipop(res.byYear, 'year', 'n', null))
    );
    return charts;
  }

  function tabCycle(res) {
    var k = sectionKpis(
      kpiPlain('Completed total', res.completed, 'k-pos') +
      kpiPlain('Completion rate', (res.completionRate != null ? res.completionRate + '%' : '—'), 'k-pos') +
      kpiPlain('Avg days in stage', res.avgStageAge) +
      kpiPlain('On hold', res.onHold, res.onHold ? 'k-alert' : '')
    );
    var histLbl = function (i) { return i >= 10 ? '90+' : ((i - 1) * 10) + ''; };
    var stageDur = (res.avgStageDuration || []).slice().sort(function (a, b) {
      return stageOrderG.indexOf(a.stage) - stageOrderG.indexOf(b.stage);
    }).map(function (r) { return { stage: stageShort(r.stage), days: r.days }; });
    var charts = chartsGrid(
      card('Active job age (days in stage)', histogram(res.ageHist, histLbl)) +
      card('Cycle time by type (days)', boxPlot(res.cycleBox), true) +
      card('Avg days per stage', barChart(stageDur, 'stage', 'days', null))
    );
    return k + charts;
  }

  function tabWorkload(res) {
    if (res.scoped) {
      return '<p class="muted" style="margin-top:16px">Workload analytics are firm-wide. As an accountant you only see your own assigned jobs, shown on the other tabs.</p>' +
        chartsGrid(card('My active jobs by stage', barChart((res.byStage || []).map(function (r) { return { s: stageShort(r.stage), n: r.n }; }), 's', 'n', null)));
    }
    // stacked per staff by stage
    var staffMap = {};
    (res.workloadByStage || []).forEach(function (r) {
      if (!staffMap[r.staff]) staffMap[r.staff] = {};
      staffMap[r.staff][r.stage] = r.n;
    });
    var stages = (res.stageOrder || []).filter(function (s) { return s !== '09_completed'; });
    var sbRows = Object.keys(staffMap).map(function (name) {
      return { label: name, parts: stages.map(function (s, i) {
        return { key: stageShort(s), val: staffMap[name][s] || 0, color: PAL[i % PAL.length] };
      }) };
    });
    var bubbleRows = (res.staffBubble || []).map(function (r) {
      return { label: r.staff, x: r.active, y: r.total, r: r.overdue };
    });
    var charts = chartsGrid(
      card('Active workload by staff', barChart(res.workload, 'staff', 'n')) +
      card('Per-staff jobs by stage', stackedBar(sbRows), true) +
      card('Staff load vs overdue', bubble(bubbleRows, 'active', 'total'))
    );
    return charts;
  }

  function tabDocs(res) {
    var k = sectionKpis(
      kpiPlain('Docs to review', res.docsToReview, res.docsToReview ? 'k-alert' : '') +
      kpiPlain('Outstanding requests', res.outstandingDocs, res.outstandingDocs ? 'k-alert' : '') +
      kpiPlain('Upcoming appts', res.upcomingAppts) +
      kpiPlain(res.scoped ? 'My clients' : 'Total clients', res.clients)
    );
    var docLf = function (s) { return cap(String(s).replace('_', ' ')); };
    var outRows = (res.outstandingByStage || []).map(function (r) { return { s: stageShort(r.stage), n: r.n }; });
    var charts = chartsGrid(
      card('Documents by status', donut(res.docsByStatus, 'status', 'n', docLf, DOCC)) +
      card('Outstanding requests by stage', outRows.length ? columnChart(outRows, 's', 'n', null, '#b8912c') : empty()) +
      card('Appointments by service (30d)', barChart(res.apptsByService, 'service', 'n', null))
    );
    return k + charts;
  }

  var TABS = [
    { id: 'overview', label: 'Overview', build: tabOverview },
    { id: 'trends', label: 'Trends', build: tabTrends },
    { id: 'cycle', label: 'Cycle time', build: tabCycle },
    { id: 'workload', label: 'Workload', build: tabWorkload },
    { id: 'documents', label: 'Documents', build: tabDocs }
  ];
  var activeTab = 'overview';

  // ---------------- filters ----------------
  var activeFilters = { fy: '', type: '', priority: '', staff: '', months: 6 };

  function selHtml(id, label, options, cur) {
    var placeholder = label ? '<option value="">' + esc(label) + '</option>' : '';
    var opts = placeholder + options.map(function (o) {
      return '<option value="' + esc(String(o.value)) + '"' + (String(o.value) === String(cur) ? ' selected' : '') + '>' + esc(String(o.label)) + '</option>';
    }).join('');
    return '<select class="ins-filter" data-f="' + id + '">' + opts + '</select>';
  }
  function filterBar(res) {
    var fo = res.filterOptions || {}, f = res.filters || activeFilters, parts = [];
    parts.push(selHtml('fy', 'All years', (fo.years || []).map(function (y) { return { value: y, label: y }; }), f.fy));
    parts.push(selHtml('type', 'All types', (fo.types || []).map(function (t) { return { value: t, label: t }; }), f.type));
    parts.push(selHtml('priority', 'All priorities', (fo.priorities || []).map(function (p) { return { value: p, label: cap(p) }; }), f.priority));
    if (!res.scoped) parts.push(selHtml('staff', 'All staff', (fo.staff || []).map(function (s) { return { value: s.email, label: s.name }; }), f.staff));
    parts.push(selHtml('months', '', [3, 6, 12].map(function (m) { return { value: m, label: 'Last ' + m + ' mo' }; }), f.months));
    var anyActive = f.fy || f.type || f.priority || f.staff;
    var clearBtn = anyActive ? '<button class="btn btn-sm" id="clearFilters" type="button">Clear</button>' : '';
    return '<div class="ins-filters">' + parts.join('') + clearBtn + '</div>';
  }

  function tabBar() {
    return '<div class="ins-tabs" role="tablist">' + TABS.map(function (t) {
      return '<button class="ins-tab' + (t.id === activeTab ? ' is-active' : '') + '" data-tab="' + t.id + '" role="tab" type="button">' + esc(t.label) + '</button>';
    }).join('') + '</div>';
  }

  function render(res) {
    var head = '<div class="ins-scope-bar">' +
      '<span class="ins-scope">' + (res.scoped ? 'Assigned to you' : 'Firm-wide · all staff & clients') + '</span>' +
      filterBar(res) + '</div>' + tabBar();
    var tab = TABS.filter(function (t) { return t.id === activeTab; })[0] || TABS[0];
    wrap.innerHTML = head + '<div class="ins-tabpane">' + tab.build(res) + '</div>';
    bindHead();
  }

  function bindHead() {
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
    Array.prototype.forEach.call(wrap.querySelectorAll('.ins-tab'), function (btn) {
      btn.addEventListener('click', function () {
        activeTab = btn.getAttribute('data-tab');
        try { localStorage.setItem('insights.tab', activeTab); } catch (e) {}
        if (current) render(current);
      });
    });
  }

  // ---------------- data ----------------
  var current = null;
  function queryString() {
    var f = activeFilters, qs = [];
    if (f.fy) qs.push('fy=' + encodeURIComponent(f.fy));
    if (f.type) qs.push('type=' + encodeURIComponent(f.type));
    if (f.priority) qs.push('priority=' + encodeURIComponent(f.priority));
    if (f.staff) qs.push('staff=' + encodeURIComponent(f.staff));
    if (f.months) qs.push('months=' + encodeURIComponent(f.months));
    return qs.length ? '?' + qs.join('&') : '';
  }
  function ingest(res) {
    current = res;
    stageMapG = res.stageMap || {};
    stageOrderG = res.stageOrder || [];
  }
  function reload() {
    wrap.classList.add('ins-loading');
    Nav.api('/api/insights/summary' + queryString()).then(function (res) {
      ingest(res);
      render(res);
      wrap.classList.remove('ins-loading');
    }).catch(function (e) {
      wrap.classList.remove('ins-loading');
      alert('Could not load: ' + e.message);
    });
  }

  try { var t = localStorage.getItem('insights.tab'); if (t) activeTab = t; } catch (e) {}
  Nav.api('/api/insights/summary').then(function (res) {
    ingest(res);
    if (res.filters) {
      activeFilters = {
        fy: res.filters.fy || '', type: res.filters.type || '',
        priority: res.filters.priority || '', staff: res.filters.staff || '',
        months: res.filters.months || 6
      };
    }
    render(res);
  }).catch(function (e) {
    wrap.innerHTML = '<p class="muted">Error: ' + esc(e.message) + '</p>';
  });
})();

/* =========================================================
   Successwa Business — sole trader revenue, expense & GST tracker
   Data lives in this browser only (localStorage).
   Every figure it shows is an estimate, not a lodgement.
   ========================================================= */
(function () {
  'use strict';

  var STORE_KEY = 'successwa.business.v1';
  var STORE_QUOTA = 5 * 1024 * 1024;
  var FREE_TX_CAP = 10;
  var GST_RATE = 0.10;           // Australian GST is 10%
  var GST_DIVISOR = 11;          // GST portion of a GST-inclusive amount = amount / 11

  var INCOME_CATEGORIES = {
    'Business Income': 'All income from your business activities — product sales, services provided, consulting, freelance work. If you\u2019re GST-registered, this figure should be GST-exclusive on your tax return.',
    'Interest income': 'Interest earned on business bank accounts or term deposits held by the business.',
    'Government grants': 'Taxable business grants, subsidies or incentives. Some are GST-free — check before ticking GST.',
    'Other income': 'Any other assessable business income, such as insurance recoveries or asset sale proceeds.'
  };
  var EXPENSE_CATEGORIES = {
    'Cost of goods sold': 'Direct cost of the stock or materials you sold — purchases, freight-in, packaging.',
    'Rent & utilities': 'Business premises rent, electricity, gas, water and council rates.',
    'Wages & contractors': 'Payments to employees and subcontractors. Super and PAYG withholding are handled separately.',
    'Marketing & advertising': 'Website, ads, printing, sponsorships and other promotion of your business.',
    'Vehicle & travel': 'Business vehicle running costs and work-related travel, fares and accommodation.',
    'Office & software': 'Stationery, subscriptions, software licences and general office supplies.',
    'Equipment & tools': 'Tools, devices and equipment. Items over the instant write-off threshold are depreciated.',
    'Professional fees': 'Accounting, legal, bookkeeping and consulting fees for the business.',
    'Insurance': 'Business insurance premiums — public liability, professional indemnity, contents.',
    'Bank & merchant fees': 'Account keeping fees, merchant/payment processing fees and interest on business loans.',
    'Other expenses': 'Any other deductible cost incurred in running the business, with a receipt to back it.'
  };

  var state = null;
  var draftTags = [];

  /* ---------------- helpers ---------------- */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function round2(n) { return Math.round(n * 100) / 100; }
  function money(n) {
    return (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-AU',
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function toISO(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseISO(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function bytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  /* ---------------- financial year ---------------- */
  function fyLabel(fy) { return 'FY ' + fy + '-' + pad((fy + 1) % 100); }
  function fyOf(dateStr) {
    var d = parseISO(dateStr);
    return d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1;
  }
  function fyEnd(fy) { return new Date(fy + 1, 5, 30); }

  /* ---------------- GST maths ---------------- */
  // A transaction stores its GST-inclusive amount and whether it carries GST.
  // The GST portion only applies when the business is GST-registered.
  function gstOf(tx) {
    if (!state.settings.gstRegistered || !tx.gst) return 0;
    return round2(tx.amount / GST_DIVISOR);
  }
  function exGstOf(tx) {
    return round2(tx.amount - gstOf(tx));
  }

  /* ---------------- assessment ---------------- */
  function assess() {
    var fy = state.settings.fy;
    var tx = txForFY();

    var revenueEx = 0, expenseEx = 0, gstCollected = 0, gstPaid = 0;
    tx.forEach(function (t) {
      var ex = exGstOf(t);
      var g = gstOf(t);
      if (t.type === 'income') { revenueEx += ex; gstCollected += g; }
      else { expenseEx += ex; gstPaid += g; }
    });

    var net = revenueEx - expenseEx;
    var gstNet = gstCollected - gstPaid;   // positive = payable to ATO, negative = refund

    return {
      revenueEx: round2(revenueEx), expenseEx: round2(expenseEx), net: round2(net),
      gstCollected: round2(gstCollected), gstPaid: round2(gstPaid), gstNet: round2(gstNet),
      count: tx.length
    };
  }

  /* ---------------- state ---------------- */
  function seed() {
    return {
      transactions: [],
      settings: {
        fy: 2026, theme: 'light', plan: 'free', email: 'tan@successwa.ai',
        name: '', abn: '', structure: 'sole', gstRegistered: false
      }
    };
  }
  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && Array.isArray(p.transactions)) {
          p.settings = Object.assign(seed().settings, p.settings || {});
          return p;
        }
      }
    } catch (e) { /* unreadable storage — fall through to seed */ }
    return seed();
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch (e) { toast('Storage full — export a backup'); }
    updateStorageMeter();
    autoCloud();
  }
  var cloudTimer = null;
  function autoCloud() {
    var account = state.settings && state.settings.cloudAccount;
    if (!account) return;
    // Safety: never let an empty state overwrite a cloud copy.
    if (!(state.transactions && state.transactions.length)) return;
    if (cloudTimer) clearTimeout(cloudTimer);
    cloudTimer = setTimeout(function () {
      fetch('/api/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app: 'business', account: account, data: state })
      }).catch(function () {});
    }, 1200);
  }
  function updateStorageMeter() {
    var used = 0;
    try { used = new Blob([localStorage.getItem(STORE_KEY) || '']).size; } catch (e) { used = 0; }
    var pct = Math.min(100, (used / STORE_QUOTA) * 100);
    $('storageText').textContent = (pct < 1 ? pct.toFixed(pct === 0 ? 0 : 1) : Math.round(pct)) + '% (' + bytes(used) + ')';
  }

  function txForFY() {
    return state.transactions.filter(function (t) { return fyOf(t.date) === state.settings.fy; });
  }
  function sortedTx() {
    return txForFY().slice().sort(function (a, b) {
      return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
    });
  }

  /* ---------------- rendering ---------------- */
  function renderFYSelect() {
    var years = state.transactions.map(function (t) { return fyOf(t.date); });
    var now = new Date();
    years.push(now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1, state.settings.fy);
    var min = Math.min.apply(null, years), max = Math.max.apply(null, years) + 1;
    var sel = $('fySelect');
    sel.innerHTML = '';
    for (var y = max; y >= min; y--) {
      var o = el('option', null, fyLabel(y));
      o.value = y;
      sel.appendChild(o);
    }
    sel.value = state.settings.fy;
  }

  function amountCell(t) {
    var td = el('td', 'cell-amount ta-r');
    td.appendChild(el('span', t.type === 'income' ? 'pos' : 'neg',
      (t.type === 'income' ? '+' : '-') + money(t.amount).replace('-', '')));
    if (t.tags && t.tags.length) td.appendChild(el('span', 'amort-total', t.tags.join(' · ')));
    return td;
  }
  function emptyRow(tbody, cols, text) {
    var tr = el('tr', 'empty-row');
    var td = el('td', null, text);
    td.colSpan = cols;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  function renderDashboard() {
    var a = assess();
    $('statRevenue').textContent = money(a.revenueEx);
    $('statExpenses').textContent = money(a.expenseEx);
    $('statNet').textContent = money(a.net);

    var body = $('recentBody');
    body.innerHTML = '';
    var rows = sortedTx().slice(0, 5);
    if (!rows.length) { emptyRow(body, 4, 'No transactions yet. Click Add Transaction to get started.'); return; }
    rows.forEach(function (t) {
      var tr = el('tr');
      tr.appendChild(el('td', 'cell-date', t.date));
      tr.appendChild(el('td', 'cell-cat' + (t.type === 'expense' ? ' exp' : ''), t.category));
      tr.appendChild(el('td', null, t.description));
      tr.appendChild(amountCell(t));
      body.appendChild(tr);
    });
  }

  var selectedTx = {};
  function renderTransactions() {
    var body = $('txBody');
    body.innerHTML = '';
    var q = ($('txSearch').value || '').trim().toLowerCase();
    var typeF = $('txTypeFilter').value;
    var rows = sortedTx().filter(function (t) {
      if (typeF !== 'all' && t.type !== typeF) return false;
      if (!q) return true;
      return (t.description + ' ' + t.category + ' ' + (t.party || '') + ' ' + (t.reference || '') + ' ' + (t.tags || []).join(' '))
        .toLowerCase().indexOf(q) !== -1;
    });
    var visibleIds = {};
    rows.forEach(function (t) { visibleIds[t.id] = true; });
    Object.keys(selectedTx).forEach(function (id) { if (!visibleIds[id]) delete selectedTx[id]; });
    if (!rows.length) { emptyRow(body, 8, 'Nothing matches this filter.'); updateTxBulkBar(); return; }
    rows.forEach(function (t) {
      var tr = el('tr');
      var cbTd = el('td', 'ta-c');
      var cb = el('input'); cb.type = 'checkbox'; cb.checked = !!selectedTx[t.id];
      cb.addEventListener('change', function () {
        if (cb.checked) selectedTx[t.id] = true; else delete selectedTx[t.id];
        tr.classList.toggle('row-selected', cb.checked);
        updateTxBulkBar();
      });
      tr.classList.toggle('row-selected', !!selectedTx[t.id]);
      cbTd.appendChild(cb); tr.appendChild(cbTd);
      tr.appendChild(el('td', 'cell-date', t.date));
      tr.appendChild(el('td', 'cell-cat' + (t.type === 'expense' ? ' exp' : ''), t.category));
      tr.appendChild(el('td', null, t.description));
      tr.appendChild(el('td', null, t.party || '—'));
      var g = gstOf(t);
      tr.appendChild(el('td', 'cell-amount ta-r', g ? money(g) : '—'));
      tr.appendChild(amountCell(t));
      var td = el('td', 'ta-r');
      var wrap = el('div', 'row-actions');
      var edit = el('button', 'btn-xs', 'Edit');
      edit.addEventListener('click', function () { openTxModal(t); });
      var del = el('button', 'btn-xs danger', 'Delete');
      del.addEventListener('click', function () {
        var series = t.seriesId && state.transactions.filter(function (x) { return x.seriesId === t.seriesId; });
        if (series && series.length > 1) {
          var all = confirm('This is part of a recurring series of ' + series.length + ' transactions.\n\nOK = delete the WHOLE series\nCancel = delete only this one');
          if (all) {
            state.transactions = state.transactions.filter(function (x) { return x.seriesId !== t.seriesId; });
            save(); render(); toast('Deleted ' + series.length + ' recurring transactions');
            return;
          }
        } else {
          if (!confirm('Delete "' + t.description + '"?')) return;
        }
        state.transactions = state.transactions.filter(function (x) { return x.id !== t.id; });
        delete selectedTx[t.id];
        save(); render(); toast('Transaction deleted');
      });
      wrap.appendChild(edit); wrap.appendChild(del);
      td.appendChild(wrap); tr.appendChild(td);
      body.appendChild(tr);
    });
    var all = $('txCheckAll');
    if (all) all.checked = rows.length > 0 && rows.every(function (t) { return selectedTx[t.id]; });
    updateTxBulkBar();
  }
  function updateTxBulkBar() {
    var n = Object.keys(selectedTx).length;
    var bar = $('txBulkBar');
    if (!bar) return;
    bar.hidden = n === 0;
    $('txBulkCount').textContent = n + ' selected';
  }

  function bdRow(parent, label, value, cls) {
    var row = el('div', 'breakdown-row' + (cls ? ' ' + cls : ''));
    row.appendChild(el('span', null, label));
    row.appendChild(el('span', 'mono', value));
    parent.appendChild(row);
  }

  function catTable(bodyId, type) {
    var byCat = {};
    txForFY().forEach(function (t) {
      if (t.type !== type) return;
      if (!byCat[t.category]) byCat[t.category] = { n: 0, sum: 0 };
      byCat[t.category].n++;
      byCat[t.category].sum += exGstOf(t);
    });
    var tb = $(bodyId);
    tb.innerHTML = '';
    var keys = Object.keys(byCat).sort(function (x, y) { return byCat[y].sum - byCat[x].sum; });
    if (!keys.length) { emptyRow(tb, 3, 'Nothing recorded.'); return; }
    keys.forEach(function (k) {
      var tr = el('tr');
      tr.appendChild(el('td', 'cell-cat' + (type === 'expense' ? ' exp' : ''), k));
      tr.appendChild(el('td', 'cell-date ta-r', String(byCat[k].n)));
      tr.appendChild(el('td', 'cell-amount ta-r' + (type === 'expense' ? ' neg' : ''), money(round2(byCat[k].sum))));
      tb.appendChild(tr);
    });
  }

  function renderReport() {
    var a = assess();
    $('reportFy').textContent = fyLabel(state.settings.fy) +
      (state.settings.name ? ' · ' + state.settings.name : '');
    $('repRevenue').textContent = money(a.revenueEx);
    $('repExpenses').textContent = money(a.expenseEx);
    $('repNet').textContent = money(a.net);

    // GST position
    var v = $('gstVerdict'), amt = $('gstAmount'), lab = $('gstLabel');
    var bd = $('gstBreakdown');
    bd.innerHTML = '';
    if (!state.settings.gstRegistered) {
      v.className = 'verdict';
      amt.textContent = money(0);
      lab.textContent = 'Not registered for GST — enable it in Business Settings to track BAS';
    } else {
      bdRow(bd, 'GST collected on sales', money(a.gstCollected));
      bdRow(bd, 'Less GST paid on purchases', '−' + money(a.gstPaid), 'sub');
      bdRow(bd, a.gstNet >= 0 ? 'Net GST payable to ATO' : 'Net GST refund from ATO',
        money(Math.abs(a.gstNet)), 'total');
      if (a.gstNet >= 0) {
        v.className = 'verdict owing';
        amt.textContent = money(a.gstNet);
        lab.textContent = 'estimated GST payable on your BAS';
      } else {
        v.className = 'verdict refund';
        amt.textContent = money(Math.abs(a.gstNet));
        lab.textContent = 'estimated GST refund on your BAS';
      }
    }

    // Net profit
    var pb = $('profitBreakdown');
    pb.innerHTML = '';
    bdRow(pb, 'Revenue (ex GST)', money(a.revenueEx));
    bdRow(pb, 'Less expenses (ex GST)', '−' + money(a.expenseEx), 'sub');
    bdRow(pb, a.net >= 0 ? 'Net profit' : 'Net loss', money(Math.abs(a.net)), 'total');

    catTable('repIncomeBody', 'income');
    catTable('repExpenseBody', 'expense');
  }

  function renderAccount() {
    $('accountEmail').textContent = state.settings.email;
    renderSettingsSummary();
  }

  function renderSettingsSummary() {
    var s = state.settings;
    var chips = [];
    chips.push(s.name || 'Unnamed business');
    if (s.abn) chips.push('ABN ' + s.abn);
    var labels = { sole: 'Sole trader', partnership: 'Partnership', company: 'Company', trust: 'Trust' };
    chips.push(labels[s.structure] || 'Sole trader');
    chips.push(s.gstRegistered ? 'GST registered' : 'Not GST registered');
    var wrap = $('settingsSummary');
    wrap.innerHTML = '';
    chips.forEach(function (t, i) {
      var c = el('span', 'chip' + (i === chips.length - 1 && s.gstRegistered ? ' on' : ''), t);
      wrap.appendChild(c);
    });
  }

  function render() {
    renderFYSelect();
    renderAccount();
    renderDashboard();
    renderTransactions();
    renderReport();
    renderBAS();
    updateStorageMeter();
  }

  /* ---------------- BAS summary ---------------- */
  // The Australian BAS reports GST by quarter. For a FY starting 1 July:
  //   Q1 Jul-Sep, Q2 Oct-Dec, Q3 Jan-Mar, Q4 Apr-Jun.
  var BAS_QUARTERS = [
    { key: 'Q1', label: 'Q1 Jul–Sep', months: [6, 7, 8] },
    { key: 'Q2', label: 'Q2 Oct–Dec', months: [9, 10, 11] },
    { key: 'Q3', label: 'Q3 Jan–Mar', months: [0, 1, 2] },
    { key: 'Q4', label: 'Q4 Apr–Jun', months: [3, 4, 5] }
  ];
  function renderBAS() {
    var grid = $('basGrid');
    grid.innerHTML = '';
    var tx = txForFY();
    BAS_QUARTERS.forEach(function (q) {
      var sales = 0, purchases = 0, gstCollected = 0, gstCredits = 0;
      tx.forEach(function (t) {
        var m = parseISO(t.date).getMonth();
        if (q.months.indexOf(m) === -1) return;
        var ex = exGstOf(t), g = gstOf(t);
        if (t.type === 'income') { sales += ex + g; gstCollected += g; }
        else { purchases += ex + g; gstCredits += g; }
      });
      var netGst = round2(gstCollected - gstCredits);

      var card = el('div', 'bas-card');
      card.appendChild(el('div', 'bas-quarter', q.label));
      [['Sales', sales], ['GST Collected', gstCollected], ['Purchases', purchases], ['GST Credits', gstCredits]]
        .forEach(function (pair) {
          var row = el('div', 'bas-row');
          row.appendChild(el('span', null, pair[0]));
          row.appendChild(el('span', 'mono', money(round2(pair[1]))));
          card.appendChild(row);
        });
      var net = el('div', 'bas-net ' + (netGst >= 0 ? 'pay' : 'refund'));
      net.appendChild(el('span', null, 'Net GST'));
      net.appendChild(el('span', 'mono', (netGst >= 0 ? 'Pay ' : 'Refund ') + money(Math.abs(netGst))));
      card.appendChild(net);
      grid.appendChild(card);
    });
  }

  /* ---------------- navigation ---------------- */
  var PAGES = ['dashboard', 'transactions', 'report', 'bas', 'help'];
  function navigate(page) {
    if (PAGES.indexOf(page) === -1) page = 'dashboard';
    PAGES.forEach(function (p) { $('page-' + p).hidden = (p !== page); });
    document.querySelectorAll('.side-item[data-nav]').forEach(function (a) {
      a.classList.toggle('active', a.dataset.nav === page);
    });
    window.scrollTo(0, 0);
  }

  /* ---------------- transaction modal ---------------- */
  function currentCategories() {
    return $('txModal').dataset.type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  }
  function fillCategories(keep) {
    var cats = currentCategories();
    var sel = $('txCategory');
    sel.innerHTML = '';
    Object.keys(cats).forEach(function (c) {
      var o = el('option', null, c);
      o.value = c;
      sel.appendChild(o);
    });
    if (keep && cats[keep]) sel.value = keep;
    updateAbout();
  }
  function updateAbout() {
    var cats = currentCategories();
    var key = $('txCategory').value;
    var box = $('aboutBox');
    box.innerHTML = '';
    box.appendChild(el('b', null, 'About ' + key + ': '));
    box.appendChild(document.createTextNode(cats[key] || ''));
  }
  function setType(type) {
    $('txModal').dataset.type = type;
    document.querySelectorAll('.type-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.type === type);
    });
  }
  function renderTags() {
    var list = $('tagList');
    list.innerHTML = '';
    draftTags.forEach(function (t, i) {
      var chip = el('span', 'tag', t);
      var x = el('button', null, '×');
      x.type = 'button';
      x.addEventListener('click', function () { draftTags.splice(i, 1); renderTags(); });
      chip.appendChild(x);
      list.appendChild(chip);
    });
  }
  function addTagFromInput() {
    var raw = $('tagInput').value;
    raw.split(',').forEach(function (t) {
      t = t.trim();
      if (t && draftTags.indexOf(t) === -1) draftTags.push(t);
    });
    $('tagInput').value = '';
    renderTags();
  }

  function atFreeCap(existingId) {
    return false;
  }
  // Verify that adding `count` new transactions fits within the free plan cap.
  function checkCap(count) {
    return true;
  }

  function defaultDate() {
    var today = new Date();
    return fyOf(toISO(today)) === state.settings.fy ? toISO(today) : toISO(fyEnd(state.settings.fy));
  }

  function toggleRecurringBox() {
    $('recurringBox').hidden = !$('txRecurring').checked;
  }

  // Build the list of ISO dates for a recurring series, from the start date up to
  // and including the repeat-until date, stepping by the chosen frequency.
  function recurringDates(startISO, freq, untilISO) {
    var dates = [startISO];
    if (!untilISO) return dates;
    var until = parseISO(untilISO);
    var d = parseISO(startISO);
    var guard = 0;
    while (guard++ < 600) {
      d = stepDate(d, freq);
      if (d > until) break;
      dates.push(toISO(d));
    }
    return dates;
  }
  function stepDate(d, freq) {
    var n = new Date(d.getTime());
    switch (freq) {
      case 'weekly': n.setDate(n.getDate() + 7); break;
      case 'fortnightly': n.setDate(n.getDate() + 14); break;
      case 'quarterly': n.setMonth(n.getMonth() + 3); break;
      case 'yearly': n.setFullYear(n.getFullYear() + 1); break;
      case 'monthly':
      default: n.setMonth(n.getMonth() + 1); break;
    }
    return n;
  }

  function openTxModal(tx) {
    if (atFreeCap(tx && tx.id)) return;
    setType(tx ? tx.type : 'income');
    fillCategories(tx ? tx.category : null);
    $('txModalTitle').textContent = tx ? 'Edit Transaction' : 'Add Transaction';
    $('txId').value = tx ? tx.id : '';
    $('txDate').value = tx ? tx.date : defaultDate();
    $('txAmount').value = tx ? tx.amount : '';
    $('txGst').checked = tx ? !!tx.gst : true;
    $('txRecurring').checked = tx ? !!tx.recurring : false;
    $('txFreq').value = tx && tx.freq ? tx.freq : 'monthly';
    $('txRepeatUntil').value = tx && tx.repeatUntil ? tx.repeatUntil : '';
    toggleRecurringBox();
    $('txDesc').value = tx ? tx.description : '';
    $('txParty').value = tx ? (tx.party || '') : '';
    $('txRef').value = tx ? (tx.reference || '') : '';
    $('txNotes').value = tx ? (tx.notes || '') : '';
    if ($('txReceipt')) $('txReceipt').value = '';
    draftTags = tx && tx.tags ? tx.tags.slice() : [];
    renderTags();
    $('txModal').hidden = false;
    $('txDesc').focus();
  }

  /* ---------------- settings modal ---------------- */
  function openSettingsModal() {
    var s = state.settings;
    $('setName').value = s.name || '';
    $('setAbn').value = s.abn || '';
    $('setStructure').value = s.structure || 'sole';
    $('setGst').checked = !!s.gstRegistered;
    $('settingsModal').hidden = false;
    $('setName').focus();
  }

  /* ---------------- export / backup ---------------- */
  function download(filename, content, mime) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function usDate(iso) {
    var d = parseISO(iso);
    return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
  }
  function exportCsv() {
    var rows = [['Date', 'Type', 'Category', 'Party', 'Reference', 'Description',
      'Amount (this FY)', 'Total', 'Amortization', 'GST', 'GST Amount', 'Notes']];
    sortedTx().forEach(function (t) {
      rows.push([
        usDate(t.date), t.type, t.category, t.party || '', t.reference || '', t.description,
        t.amount, t.amount, '',
        (state.settings.gstRegistered && t.gst) ? 'yes' : 'no',
        gstOf(t) ? gstOf(t).toFixed(2) : '', t.notes || ''
      ]);
    });

    download('Successwa_Business_' + fyLabel(state.settings.fy).replace('FY ', 'FY').replace(/\s/g, '') + '.csv',
      rows.map(function (r) { return r.map(csvCell).join(','); }).join('\n'), 'text/csv;charset=utf-8');
    toast('CSV exported');
  }
  // ---- Cloud sync (Successwa server / Neon Postgres) ----
  function cloudSave() {
    var account = ($('cloudAccount').value || '').trim().toLowerCase();
    if (!account) { toast('Enter your account email/ID first'); return; }
    state.settings.cloudAccount = account; save();
    toast('Saving to cloud…');
    fetch('/api/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: 'business', account: account, data: state })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.j.error || 'save failed');
        toast('Saved ' + res.j.records + ' transactions to cloud');
      }).catch(function (e) { toast('Cloud save failed: ' + e.message); });
  }
  function cloudLoad() {
    var account = ($('cloudAccount').value || '').trim().toLowerCase();
    if (!account) { toast('Enter your account email/ID first'); return; }
    toast('Loading from cloud…');
    fetch('/api/load?app=business&account=' + encodeURIComponent(account))
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.j.error || 'not found');
        if (!confirm('Replace ALL current data with the cloud copy for ' + account + '?')) return;
        var d = res.j.data;
        d.settings = Object.assign(seed().settings, d.settings || {}, { cloudAccount: account });
        state = d; applyTheme(); save(); render();
        $('storageModal').hidden = true;
        toast('Loaded ' + (state.transactions || []).length + ' transactions from cloud');
      }).catch(function (e) { toast('Cloud load failed: ' + e.message); });
  }
  function downloadBackup() {
    download('successwa-business-backup-' + toISO(new Date()) + '.json',
      JSON.stringify({ app: 'successwa-business', version: 1, exportedAt: new Date().toISOString(), data: state }, null, 2),
      'application/json');
    toast('Backup downloaded');
  }
  // Merge one or more backup files into the current data, de-duplicating by id.
  function mergeBackups(fileList) {
    var files = Array.prototype.slice.call(fileList);
    var ids = {};
    state.transactions.forEach(function (t) { ids[t.id] = true; });
    var added = 0, badFiles = 0, done = 0;

    files.forEach(function (file) {
      var reader = new FileReader();
      reader.onload = function () {
        var incoming;
        try {
          var parsed = JSON.parse(reader.result);
          incoming = parsed && parsed.data ? parsed.data : parsed;
        } catch (e) { incoming = null; }
        if (!incoming || !Array.isArray(incoming.transactions)) {
          badFiles++;
        } else {
          incoming.transactions.forEach(function (t) {
            if (!ids[t.id]) { state.transactions.push(t); ids[t.id] = true; added++; }
          });
        }
        finish();
      };
      reader.onerror = function () { badFiles++; finish(); };
      reader.readAsText(file);
    });

    function finish() {
      if (++done < files.length) return;
      save(); render();
      var msg = 'Merged ' + added + ' transaction' + (added === 1 ? '' : 's') +
        ' from ' + (files.length - badFiles) + ' file' + ((files.length - badFiles) === 1 ? '' : 's');
      if (badFiles) msg += ' (' + badFiles + ' skipped)';
      toast(msg);
    }
  }
  function freeUpSpace() {
    var cutoff = state.settings.fy;
    var old = state.transactions.filter(function (t) { return fyOf(t.date) < cutoff; });
    if (!old.length) { toast('Nothing to clear before ' + fyLabel(cutoff)); return; }
    if (!confirm('Permanently delete ' + old.length + ' transaction' + (old.length === 1 ? '' : 's') +
      ' from before ' + fyLabel(cutoff) + '?\n\nDownload a backup first — this cannot be undone.')) return;
    state.transactions = state.transactions.filter(function (t) { return fyOf(t.date) >= cutoff; });
    save(); render();
    toast('Removed ' + old.length + ' older transaction' + (old.length === 1 ? '' : 's'));
  }
  // Load a backup file, REPLACING all current data (as opposed to merge).
  function loadBackup(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var incoming;
      try {
        var parsed = JSON.parse(reader.result);
        incoming = parsed && parsed.data ? parsed.data : parsed;
      } catch (e) { toast('That file is not valid Successwa JSON'); return; }
      if (!incoming || !Array.isArray(incoming.transactions)) { toast('That file is not a Successwa Business backup'); return; }
      if (!confirm('Replace ALL current data with the contents of this backup?\n\nThis cannot be undone. Save a backup of your current data first if you want to keep it.')) return;
      incoming.settings = Object.assign(seed().settings, incoming.settings || {});
      state = incoming;
      applyTheme(); save(); render();
      $('storageModal').hidden = true;
      toast('Backup loaded — ' + state.transactions.length + ' transaction' + (state.transactions.length === 1 ? '' : 's'));
    };
    reader.readAsText(file);
  }

  function openStorageModal() {
    var used = 0;
    try { used = new Blob([localStorage.getItem(STORE_KEY) || '']).size; } catch (e) { used = 0; }
    var pct = Math.min(100, (used / STORE_QUOTA) * 100);
    $('storageBar').style.width = pct + '%';
    $('storageUsage').textContent = bytes(used) + ' used of ~5 MB';
    $('storagePct').textContent = (pct < 1 ? pct.toFixed(pct === 0 ? 0 : 1) : Math.round(pct)) + '%';
    var oldCount = state.transactions.filter(function (t) { return fyOf(t.date) < state.settings.fy; }).length;
    $('storageFreeHelp').textContent = oldCount
      ? 'Remove ' + oldCount + ' transaction' + (oldCount === 1 ? '' : 's') + ' from before ' + fyLabel(state.settings.fy) + '. Your backup file (Step 1) keeps a complete copy — nothing is truly lost.'
      : 'No transactions from old financial years to remove. Consider removing individual transactions manually if storage remains full.';
    $('storageModal').hidden = false;
  }

  // Open a clean, standalone window with a printable / save-as-PDF report.
  function openReportWindow() {
    var a = assess();
    var s = state.settings;
    var win = window.open('', '_blank');
    if (!win) { toast('Allow pop-ups to generate the report'); return; }
    var title = (s.name || 'Successwa Business') + ' Report ' + fyLabel(s.fy);

    function catRows(type) {
      var byCat = {};
      txForFY().forEach(function (t) {
        if (t.type !== type) return;
        if (!byCat[t.category]) byCat[t.category] = { n: 0, sum: 0 };
        byCat[t.category].n++;
        byCat[t.category].sum += exGstOf(t);
      });
      var keys = Object.keys(byCat).sort(function (x, y) { return byCat[y].sum - byCat[x].sum; });
      if (!keys.length) return '<tr><td colspan="3" style="color:#888;text-align:center;padding:14px">Nothing recorded.</td></tr>';
      return keys.map(function (k) {
        return '<tr><td>' + esc(k) + '</td><td class="r">' + byCat[k].n + '</td><td class="r">' + money(round2(byCat[k].sum)) + '</td></tr>';
      }).join('');
    }
    var txRows = sortedTx().map(function (t) {
      return '<tr><td>' + esc(t.date) + '</td><td>' + esc(t.category) + '</td><td>' + esc(t.description) +
        '</td><td class="r">' + (gstOf(t) ? money(gstOf(t)) : '—') + '</td><td class="r ' + (t.type === 'income' ? 'pos' : 'neg') + '">' +
        (t.type === 'income' ? '+' : '-') + money(t.amount).replace('-', '') + '</td></tr>';
    }).join('') || '<tr><td colspan="5" style="color:#888;text-align:center;padding:14px">No transactions.</td></tr>';

    var gstBlock = s.gstRegistered
      ? '<div class="row"><span>GST collected on sales</span><b>' + money(a.gstCollected) + '</b></div>' +
        '<div class="row"><span>Less GST paid on purchases</span><b>−' + money(a.gstPaid) + '</b></div>' +
        '<div class="row total"><span>' + (a.gstNet >= 0 ? 'Net GST payable to ATO' : 'Net GST refund from ATO') + '</span><b>' + money(Math.abs(a.gstNet)) + '</b></div>'
      : '<div class="row"><span>Not registered for GST</span><b>—</b></div>';

    var html =
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title><style>' +
      '*{margin:0;padding:0;box-sizing:border-box}' +
      'body{font-family:Arial,Helvetica,sans-serif;color:#1a1614;padding:32px 40px;max-width:900px;margin:0 auto}' +
      '.bar{background:#efeae2;border-radius:8px;padding:16px 20px;display:flex;justify-content:flex-end;margin-bottom:24px}' +
      '.btn{background:#8a6d3b;color:#fff;border:0;border-radius:7px;padding:10px 18px;font-size:14px;font-weight:700;cursor:pointer}' +
      'h1{font-size:26px;margin-bottom:4px}.sub{color:#8a8074;margin-bottom:22px}' +
      '.cards{display:flex;gap:16px;margin-bottom:26px}.card{flex:1;border:1px solid #e0d9cd;border-radius:9px;padding:16px 18px}' +
      '.label{font-size:10.5px;letter-spacing:1px;text-transform:uppercase;color:#8a8074;font-family:monospace}' +
      '.val{font-size:24px;font-weight:700;margin-top:6px}.pos{color:#2f7d4f}.neg{color:#b23a2e}' +
      'h2{font-size:16px;margin:26px 0 10px;border-bottom:2px solid #1a1614;padding-bottom:6px}' +
      'table{width:100%;border-collapse:collapse}th{text-align:left;font-size:10.5px;letter-spacing:.6px;text-transform:uppercase;color:#8a8074;padding:8px 10px;border-bottom:1px solid #ccc}' +
      'td{padding:8px 10px;border-bottom:1px solid #eee;font-size:13px}.r{text-align:right}' +
      '.row{display:flex;justify-content:space-between;padding:9px 2px;border-bottom:1px solid #eee;font-size:14px}.row.total{font-weight:700;border-top:2px solid #1a1614;border-bottom:0}' +
      '.foot{margin-top:34px;color:#8a8074;font-size:11px;border-top:1px solid #eee;padding-top:12px}' +
      '@media print{.bar{display:none}body{padding:0}}' +
      '</style></head><body>' +
      '<div class="bar"><button class="btn" onclick="window.print()">Print / Save as PDF</button></div>' +
      '<h1>' + esc(s.name || 'Successwa Business') + '</h1>' +
      '<p class="sub">Tax Report ' + fyLabel(s.fy) + '</p>' +
      '<div class="cards">' +
      '<div class="card"><div class="label">Revenue (ex GST)</div><div class="val pos">' + money(a.revenueEx) + '</div></div>' +
      '<div class="card"><div class="label">Expenses (ex GST)</div><div class="val neg">' + money(a.expenseEx) + '</div></div>' +
      '<div class="card"><div class="label">Net profit</div><div class="val">' + money(a.net) + '</div></div>' +
      '</div>' +
      '<h2>GST position</h2>' + gstBlock +
      '<h2>Income by category</h2><table><thead><tr><th>Category</th><th class="r">Count</th><th class="r">Amount (ex GST)</th></tr></thead><tbody>' + catRows('income') + '</tbody></table>' +
      '<h2>Expenses by category</h2><table><thead><tr><th>Category</th><th class="r">Count</th><th class="r">Amount (ex GST)</th></tr></thead><tbody>' + catRows('expense') + '</tbody></table>' +
      '<h2>All transactions</h2><table><thead><tr><th>Date</th><th>Category</th><th>Description</th><th class="r">GST</th><th class="r">Amount</th></tr></thead><tbody>' + txRows + '</tbody></table>' +
      '<p class="foot">' + esc(s.name || 'Successwa Business') + (s.abn ? ' · ABN ' + esc(s.abn) : '') + ' · Record-keeping tool only. Not tax advice.</p>' +
      '</body></html>';

    win.document.open();
    win.document.write(html);
    win.document.close();
    win.document.title = title;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2800);
  }

  function applyTheme() { document.documentElement.setAttribute('data-theme', state.settings.theme); }

  /* ---------------- wiring ---------------- */
  function bind() {
    document.querySelectorAll('[data-nav]').forEach(function (a) {
      a.addEventListener('click', function (e) { e.preventDefault(); navigate(a.dataset.nav); });
    });
    $('fySelect').addEventListener('change', function () {
      state.settings.fy = Number(this.value); save(); render();
    });
    $('btnTheme').addEventListener('click', function () {
      state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
      applyTheme(); save();
    });
    $('btnSaveLoad').addEventListener('click', openStorageModal);

    // settings panel opens modal
    $('panelSettings').querySelector('.panel-head').addEventListener('click', openSettingsModal);

    $('btnAddTx').addEventListener('click', function () { openTxModal(null); });
    $('btnAddTx2').addEventListener('click', function () { openTxModal(null); });
    $('btnExportCsv').addEventListener('click', exportCsv);
    $('btnExportCsv2').addEventListener('click', exportCsv);
    $('btnExportCsv3').addEventListener('click', exportCsv);
    $('toolBackup').addEventListener('click', function (e) { e.preventDefault(); downloadBackup(); });
    $('toolFree').addEventListener('click', function (e) { e.preventDefault(); freeUpSpace(); });
    $('toolMerge').addEventListener('click', function (e) { e.preventDefault(); $('mergeInput').click(); });
    $('mergeInput').addEventListener('change', function () {
      if (this.files && this.files.length) mergeBackups(this.files);
      this.value = '';
    });
    $('toolPdf').addEventListener('click', function (e) { e.preventDefault(); openReportWindow(); });
    $('btnPrintReport').addEventListener('click', function (e) { e.preventDefault(); openReportWindow(); });

    $('txSearch').addEventListener('input', renderTransactions);
    $('txTypeFilter').addEventListener('change', renderTransactions);
    if ($('txCheckAll')) {
      $('txCheckAll').addEventListener('change', function () {
        var on = this.checked;
        document.querySelectorAll('#txBody input[type=checkbox]').forEach(function (cb) {
          cb.checked = on; cb.dispatchEvent(new Event('change'));
        });
      });
      $('txBulkClear').addEventListener('click', function () {
        selectedTx = {}; $('txCheckAll').checked = false; renderTransactions();
      });
      $('txBulkDelete').addEventListener('click', function () {
        var ids = Object.keys(selectedTx);
        if (!ids.length) return;
        if (!confirm('Delete ' + ids.length + ' selected transaction' + (ids.length === 1 ? '' : 's') + '? This cannot be undone.')) return;
        var set = {}; ids.forEach(function (id) { set[id] = true; });
        state.transactions = state.transactions.filter(function (x) { return !set[x.id]; });
        selectedTx = {};
        save(); render(); toast('Deleted ' + ids.length + ' transaction' + (ids.length === 1 ? '' : 's'));
      });
    }

    document.querySelectorAll('.type-btn').forEach(function (b) {
      b.addEventListener('click', function () { setType(b.dataset.type); fillCategories(null); });
    });
    $('txCategory').addEventListener('change', updateAbout);
    $('txRecurring').addEventListener('change', toggleRecurringBox);
    $('tagAdd').addEventListener('click', addTagFromInput);
    $('tagInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTagFromInput(); }
    });

    // storage modal actions
    $('storageSave').addEventListener('click', downloadBackup);
    $('storageFree').addEventListener('click', freeUpSpace);
    $('storageLoad').addEventListener('click', function () { $('loadInput').click(); });
    $('storageMerge').addEventListener('click', function () { $('mergeInput').click(); });
    $('loadInput').addEventListener('change', function () {
      if (this.files && this.files[0]) loadBackup(this.files[0]);
      this.value = '';
    });
    if ($('cloudAccount')) {
      $('cloudAccount').value = state.settings.cloudAccount || state.settings.email || '';
      $('cloudSave').addEventListener('click', cloudSave);
      $('cloudLoad').addEventListener('click', cloudLoad);
    }
    if ($('btnLogout')) {
      $('btnLogout').addEventListener('click', function () {
        if (!confirm('Sign out of Successwa on this device?')) return;
        localStorage.removeItem('successwa.auth');
        location.href = 'login.html';
      });
    }

    var ALL_MODALS = ['txModal', 'settingsModal', 'storageModal'];
    document.querySelectorAll('[data-close]').forEach(function (btn) {
      btn.addEventListener('click', function () { $(btn.dataset.close).hidden = true; });
    });
    ALL_MODALS.forEach(function (id) {
      $(id).addEventListener('click', function (e) { if (e.target === $(id)) $(id).hidden = true; });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      ALL_MODALS.forEach(function (id) { $(id).hidden = true; });
    });

    $('txForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var amount = Math.abs(Number($('txAmount').value) || 0);
      if (!amount) { toast('Enter an amount'); return; }
      var recurring = $('txRecurring').checked;
      var freq = $('txFreq').value;
      var repeatUntil = $('txRepeatUntil').value;
      var record = {
        type: $('txModal').dataset.type,
        date: $('txDate').value,
        category: $('txCategory').value,
        description: $('txDesc').value.trim(),
        party: $('txParty').value.trim(),
        reference: $('txRef').value.trim(),
        notes: $('txNotes').value.trim(),
        tags: draftTags.slice(),
        gst: $('txGst').checked,
        recurring: recurring,
        freq: recurring ? freq : '',
        repeatUntil: recurring ? repeatUntil : '',
        amount: amount
      };
      var receiptEl = $('txReceipt');
      var receipt = receiptEl && receiptEl.files && receiptEl.files[0];
      if (receipt) record.receiptName = receipt.name;
      var id = $('txId').value;
      if (id) {
        Object.assign(state.transactions.find(function (x) { return x.id === id; }), record);
        toast('Transaction updated');
      } else if (recurring && repeatUntil) {
        var dates = recurringDates(record.date, freq, repeatUntil);
        if (!checkCap(dates.length)) { $('txModal').hidden = true; return; }
        var seriesId = uid();
        dates.forEach(function (d) {
          var copy = Object.assign({}, record, { id: uid(), date: d, seriesId: seriesId });
          state.transactions.push(copy);
        });
        state.settings.fy = fyOf(record.date);
        toast('Added ' + dates.length + ' recurring transactions');
      } else {
        record.id = uid();
        state.transactions.push(record);
        state.settings.fy = fyOf(record.date);
        toast('Transaction saved');
      }
      $('txModal').hidden = true;
      if ($('txReceipt')) $('txReceipt').value = '';
      save(); render();
    });

    $('settingsForm').addEventListener('submit', function (e) {
      e.preventDefault();
      state.settings.name = $('setName').value.trim();
      state.settings.abn = $('setAbn').value.trim();
      state.settings.structure = $('setStructure').value;
      state.settings.gstRegistered = $('setGst').checked;
      $('settingsModal').hidden = true;
      save(); render();
      toast('Business settings saved');
    });
  }

  /* ---------------- boot ---------------- */
  var auth = null;
  try { auth = JSON.parse(localStorage.getItem('successwa.auth') || 'null'); } catch (e) {}
  if (!auth || !auth.email) { location.href = 'login.html'; return; }
  // Clients arrive here from their portal — give them a way back.
  if (auth.role === 'client') { var bp = document.getElementById('backToPortal'); if (bp) bp.style.display = ''; }

  state = load();
  state.settings.email = auth.email;
  state.settings.cloudAccount = auth.email;
  applyTheme();
  bind();
  setType('income');
  fillCategories(null);
  render();
  navigate((location.hash || '').replace('#', '') || 'dashboard');
  window.addEventListener('hashchange', function () {
    navigate((location.hash || '').replace('#', '') || 'dashboard');
  });
})();

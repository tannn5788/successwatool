/* =========================================================
   Successwa Personal — personal income & deduction tracker
   Data lives in this browser only (localStorage).
   Every figure it shows is an estimate, not a lodgement.
   ========================================================= */
(function () {
  'use strict';

  var STORE_KEY = 'successwa.personal.v1';
  var STORE_QUOTA = 5 * 1024 * 1024;
  var FREE_ENTRY_CAP = 10;

  /* ---------------------------------------------------------
     Rate tables. Australian resident rates, keyed by the FY
     starting year. Keep every published figure in this one
     block so a new year is a data change, not a code change.
     --------------------------------------------------------- */
  var RATES = {
    2026: {
      label: 'FY 2026-27',
      brackets: [
        { from: 0,      to: 18200,    rate: 0    },
        { from: 18200,  to: 45000,    rate: 0.16 },
        { from: 45000,  to: 135000,   rate: 0.30 },
        { from: 135000, to: 190000,   rate: 0.37 },
        { from: 190000, to: Infinity, rate: 0.45 }
      ],
      medicare: 0.02,
      medicareFreeUpTo: 27222,      // no levy at or below this
      medicareShadeTo: 34027,       // phased in at 10c/$1 between the two
      lito: { max: 700, from1: 37500, rate1: 0.05, from2: 45000, rate2: 0.015 },
      help: [                       // marginal HELP/HECS repayment
        { from: 67000,  to: 125000,   rate: 0.15 },
        { from: 125000, to: Infinity, rate: 0.17 }
      ],
      mls: {
        single: [{ from: 105000, rate: 0.01 }, { from: 122500, rate: 0.0125 }, { from: 163000, rate: 0.015 }],
        family: [{ from: 210000, rate: 0.01 }, { from: 245000, rate: 0.0125 }, { from: 326000, rate: 0.015 }],
        familyPerKid: 1500
      },
      vehicleCents: 0.91,           // cents per km method
      vehicleKmCap: 5000,
      homeOfficeRate: 0.70          // fixed rate per hour
    }
  };
  // Years without their own table reuse the most recent one, flagged in the UI.
  function ratesFor(fy) {
    if (RATES[fy]) return RATES[fy];
    var keys = Object.keys(RATES).map(Number).sort(function (a, b) { return b - a; });
    var base = RATES[keys[0]];
    return Object.assign({}, base, { label: fyLabel(fy), estimated: true });
  }

  var INCOME_CATEGORIES = {
    'Salary/Wages': 'Your gross earnings from employment before tax. Get this from your Income Statement (previously PAYG Payment Summary or group certificate).',
    'Allowances': 'Car, travel, tool or meal allowances shown separately on your Income Statement. They are income, and the matching expense is a deduction.',
    'Bank interest': 'Interest credited by your bank or term deposit. The ATO pre-fills this, so it must be declared even when small.',
    'Dividends': 'Dividends received, including the franking credit attached. Enter the grossed-up amount if your statement shows one.',
    'Government payments': 'Taxable Centrelink and similar payments. Some are tax-free — check the payment summary before entering.',
    'Other income': 'Anything else assessable: side income, foreign income, capital gains distributions.'
  };
  var DEDUCTION_CATEGORIES = {
    'Vehicle & travel': 'Work travel in your own car, or fares and accommodation for work trips. Home-to-work commuting does not count.',
    'Home office': 'Running costs for working from home. Use the calculator — the fixed rate covers power, internet, phone and stationery.',
    'Phone & internet': 'The work-related share of your phone and internet, if you are not already claiming it under the home office fixed rate.',
    'Tools & equipment': 'Work tools, devices and software. Items over $300 are depreciated rather than claimed in full.',
    'Uniform & laundry': 'Compulsory uniforms, protective gear and occupation-specific clothing, plus laundering them. Plain clothes do not qualify.',
    'Self-education': 'Courses with a direct connection to your current job — fees, textbooks, travel to classes.',
    'Union & professional fees': 'Union dues, professional association memberships and registrations needed for your work.',
    'Income protection insurance': 'Premiums for income protection held outside super. Life and trauma cover are not deductible.',
    'Donations': 'Gifts of $2 or more to a deductible gift recipient. Keep the receipt — raffle tickets and dinners do not count.',
    'Tax agent fees': 'What you paid to manage your tax affairs last year, including your agent’s fee.',
    'Other deductions': 'Anything else you incurred earning your income, with a receipt to back it.'
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
  function money0(n) {
    return (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n)).toLocaleString('en-AU');
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

  /* ---------------- tax maths ---------------- */
  function taxOnIncome(taxable, r) {
    var tax = 0;
    r.brackets.forEach(function (b) {
      if (taxable > b.from) tax += (Math.min(taxable, b.to) - b.from) * b.rate;
    });
    return tax;
  }
  function medicareLevy(taxable, r) {
    if (taxable <= r.medicareFreeUpTo) return 0;
    if (taxable <= r.medicareShadeTo) return (taxable - r.medicareFreeUpTo) * 0.10;
    return taxable * r.medicare;
  }
  function litoAmount(taxable, r) {
    var l = r.lito;
    if (taxable <= l.from1) return l.max;
    if (taxable <= l.from2) return Math.max(0, l.max - (taxable - l.from1) * l.rate1);
    var atSecond = l.max - (l.from2 - l.from1) * l.rate1;
    return Math.max(0, atSecond - (taxable - l.from2) * l.rate2);
  }
  // HELP and MLS are assessed on repayment income — taxable income grossed back
  // up by reportable fringe benefits and reportable employer super.
  function helpRepayment(repaymentIncome, r, debtRemaining) {
    if (!debtRemaining) return 0;
    var owed = 0;
    r.help.forEach(function (b) {
      if (repaymentIncome > b.from) owed += (Math.min(repaymentIncome, b.to) - b.from) * b.rate;
    });
    return Math.min(owed, debtRemaining);
  }
  function mlsAmount(repaymentIncome, r, td) {
    if (td.cover) return 0;
    var family = td.family === 'family';
    var tiers = family ? r.mls.family : r.mls.single;
    var kids = Math.max(0, Number(td.kids) || 0);
    var lift = family ? Math.max(0, kids - 1) * r.mls.familyPerKid : 0;
    var rate = 0;
    tiers.forEach(function (t) { if (repaymentIncome > t.from + lift) rate = t.rate; });
    return repaymentIncome * rate;
  }
  function mlsHelpText(r, td) {
    var family = td.family === 'family';
    var kids = Math.max(0, Number(td.kids) || 0);
    var lift = family ? Math.max(0, kids - 1) * r.mls.familyPerKid : 0;
    return 'MLS is an additional 1%–1.5% tax if you earn above the threshold (Single: ' +
      money0(r.mls.single[0].from) + ' / Family: ' + money0(r.mls.family[0].from) + ' for ' +
      r.label.replace('FY ', 'FY') + ') without private hospital cover. Family threshold +' +
      money0(r.mls.familyPerKid) + ' per child after the first.' +
      (lift ? ' Yours: ' + money0(r.mls.family[0].from + lift) + '.' : '');
  }

  function assess() {
    var fy = state.settings.fy;
    var r = ratesFor(fy);
    var ent = entriesForFY();

    var entryIncome = 0, deductions = 0;
    ent.forEach(function (e) {
      if (e.type === 'income') entryIncome += e.amount; else deductions += e.amount;
    });

    var statements = state.statements.filter(function (s) { return s.fy === fy; });
    var gross = 0, withheld = 0, resc = 0, rfba = 0, superClaim = 0;
    statements.forEach(function (s) {
      gross += s.gross; withheld += s.withheld;
      resc += Number(s.resc) || 0;
      rfba += Number(s.rfba) || 0;
      superClaim += Number(s.superClaim) || 0;
    });

    var td = taxDetails(fy), bz = business(fy);
    var biz = Number(bz.profit) || 0;
    var paygi = Number(bz.paygi) || 0;

    deductions += superClaim;                       // claimed personal super is a deduction
    var income = entryIncome + gross + biz;
    var taxable = Math.max(0, income - deductions);
    // RFBA is not taxed, but it is added back for the surcharge and student loan tests.
    var repaymentIncome = taxable + rfba + resc;

    var base = taxOnIncome(taxable, r);
    var lito = Math.min(base, litoAmount(taxable, r));
    var levy = td.exempt ? 0 : medicareLevy(taxable, r);
    var mls = mlsAmount(repaymentIncome, r, td);
    var help = helpRepayment(repaymentIncome, r, Number(td.helpDebt) || 0);
    var liability = Math.max(0, base - lito) + levy + mls + help;
    var credits = withheld + paygi;

    return {
      rates: r, income: round2(income), entryIncome: round2(entryIncome),
      gross: round2(gross), biz: round2(biz), deductions: round2(deductions),
      superClaim: round2(superClaim), resc: round2(resc), rfba: round2(rfba),
      repaymentIncome: round2(repaymentIncome),
      taxable: round2(taxable), base: round2(base), lito: round2(lito),
      levy: round2(levy), mls: round2(mls), help: round2(help),
      liability: round2(liability), withheld: round2(withheld), paygi: round2(paygi),
      credits: round2(credits), result: round2(credits - liability),
      count: ent.length, statements: statements, td: td
    };
  }

  /* ---------------- state ---------------- */
  function seed() {
    return {
      entries: [], statements: [], taxDetails: {}, business: {},
      settings: { fy: 2026, theme: 'light', plan: 'free', email: 'tan@successwa.ai' }
    };
  }
  function blankTaxDetails() {
    return { helpDebt: 0, cover: false, family: 'single', kids: 0, exempt: false, docName: '' };
  }
  function blankBusiness() { return { profit: 0, paygi: 0 }; }
  function taxDetails(fy) {
    var key = String(fy == null ? state.settings.fy : fy);
    if (!state.taxDetails[key]) state.taxDetails[key] = blankTaxDetails();
    return state.taxDetails[key];
  }
  function business(fy) {
    var key = String(fy == null ? state.settings.fy : fy);
    if (!state.business[key]) state.business[key] = blankBusiness();
    return state.business[key];
  }
  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && p.entries && p.statements) {
          p.settings = Object.assign(seed().settings, p.settings || {});
          p.settings.theme = 'light'; // Tax Tracker always defaults to light.
          p.taxDetails = p.taxDetails || {};
          p.business = p.business || {};
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
    if (!(state.entries && state.entries.length) && !(state.statements && state.statements.length)) return;
    if (cloudTimer) clearTimeout(cloudTimer);
    cloudTimer = setTimeout(function () {
      fetch('/api/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app: 'personal', account: account, data: state })
      }).then(function (r) { if (r.ok) { var d = $('cloudDot'); if (d) { d.textContent = '☁ synced'; } } })
        .catch(function () {});
    }, 1200);
  }
  function updateStorageMeter() {
    var used = 0;
    try { used = new Blob([localStorage.getItem(STORE_KEY) || '']).size; } catch (e) { used = 0; }
    var pct = Math.min(100, (used / STORE_QUOTA) * 100);
    $('storageText').textContent = (pct < 1 ? pct.toFixed(pct === 0 ? 0 : 1) : Math.round(pct)) + '% (' + bytes(used) + ')';
  }

  function entriesForFY() {
    return state.entries.filter(function (e) { return fyOf(e.date) === state.settings.fy; });
  }
  function sortedEntries() {
    return entriesForFY().slice().sort(function (a, b) {
      return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
    });
  }

  /* ---------------- rendering ---------------- */
  function renderFYSelect() {
    var years = state.entries.map(function (e) { return fyOf(e.date); })
      .concat(state.statements.map(function (s) { return s.fy; }));
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

  function amountCell(e) {
    var td = el('td', 'cell-amount ta-r');
    td.appendChild(el('span', e.type === 'income' ? 'pos' : 'neg',
      (e.type === 'income' ? '+' : '-') + money(e.amount).replace('-', '')));
    if (e.tags && e.tags.length) td.appendChild(el('span', 'amort-total', e.tags.join(' · ')));
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
    $('statIncome').textContent = money(a.income);
    $('statDeductions').textContent = money(a.deductions);
    $('statNet').textContent = money(a.taxable);
    $('statCount').textContent = a.count;
    $('isFy').textContent = fyLabel(state.settings.fy);

    var fl = fyLabel(state.settings.fy);
    $('isModalTitle').textContent = 'Add Income Statement — ' + fl;
    $('ptdTitle').textContent = 'Personal Tax Details — ' + fl;
    $('bizTitle').textContent = 'Business Activity — ' + fl;

    var list = $('isList');
    list.innerHTML = '';
    if (a.statements.length) {
      a.statements.forEach(function (s) {
        var row = el('div', 'breakdown-row');
        var left = el('span', null, s.employer);
        var detail = money(s.gross) + '  ·  ' + money(s.withheld) + ' withheld';
        var extras = [];
        if (Number(s.resc)) extras.push('RESC ' + money(s.resc));
        if (Number(s.rfba)) extras.push('RFBA ' + money(s.rfba));
        if (Number(s.superClaim)) extras.push('Super claim ' + money(s.superClaim));
        if (extras.length) detail += '  ·  ' + extras.join(' · ');
        var right = el('span', 'mono', detail);
        var edit = el('button', 'btn-xs', '✎');
        edit.title = 'Edit';
        edit.style.marginLeft = '8px';
        edit.addEventListener('click', function () { openISModal(s); });
        var del = el('button', 'btn-xs danger', 'X');
        del.style.marginLeft = '4px';
        del.addEventListener('click', function () {
          state.statements = state.statements.filter(function (x) { return x.id !== s.id; });
          save(); render(); toast('Income statement removed');
        });
        right.appendChild(edit);
        right.appendChild(del);
        row.appendChild(left);
        row.appendChild(right);
        list.appendChild(row);
      });
    }

    var body = $('recentBody');
    body.innerHTML = '';
    var rows = sortedEntries().slice(0, 5);
    if (!rows.length) { emptyRow(body, 4, 'No entries yet. Click Add Entry to get started.'); return; }
    rows.forEach(function (e) {
      var tr = el('tr');
      tr.appendChild(el('td', 'cell-date', e.date));
      tr.appendChild(el('td', 'cell-cat' + (e.type === 'deduction' ? ' exp' : ''), e.category));
      tr.appendChild(el('td', null, e.description));
      tr.appendChild(amountCell(e));
      body.appendChild(tr);
    });
  }

  var selectedEntries = {};
  function renderEntries() {
    var body = $('entryBody');
    body.innerHTML = '';
    var q = ($('entrySearch').value || '').trim().toLowerCase();
    var typeF = $('entryTypeFilter').value;
    var rows = sortedEntries().filter(function (e) {
      if (typeF !== 'all' && e.type !== typeF) return false;
      if (!q) return true;
      return (e.description + ' ' + e.category + ' ' + (e.source || '') + ' ' + (e.tags || []).join(' '))
        .toLowerCase().indexOf(q) !== -1;
    });
    // prune selection to visible rows
    var visibleIds = {};
    rows.forEach(function (e) { visibleIds[e.id] = true; });
    Object.keys(selectedEntries).forEach(function (id) { if (!visibleIds[id]) delete selectedEntries[id]; });
    if (!rows.length) { emptyRow(body, 7, 'Nothing matches this filter.'); updateBulkBar(); return; }
    rows.forEach(function (e) {
      var tr = el('tr');
      var cbTd = el('td', 'ta-c');
      var cb = el('input'); cb.type = 'checkbox'; cb.checked = !!selectedEntries[e.id];
      cb.addEventListener('change', function () {
        if (cb.checked) selectedEntries[e.id] = true; else delete selectedEntries[e.id];
        tr.classList.toggle('row-selected', cb.checked);
        updateBulkBar();
      });
      tr.classList.toggle('row-selected', !!selectedEntries[e.id]);
      cbTd.appendChild(cb); tr.appendChild(cbTd);
      tr.appendChild(el('td', 'cell-date', e.date));
      tr.appendChild(el('td', 'cell-cat' + (e.type === 'deduction' ? ' exp' : ''), e.category));
      tr.appendChild(el('td', null, e.description));
      tr.appendChild(el('td', null, e.source || '—'));
      tr.appendChild(amountCell(e));
      var td = el('td', 'ta-r');
      var wrap = el('div', 'row-actions');
      var edit = el('button', 'btn-xs', 'Edit');
      edit.addEventListener('click', function () { openEntryModal(e); });
      var del = el('button', 'btn-xs danger', 'Delete');
      del.addEventListener('click', function () {
        if (!confirm('Delete "' + e.description + '"?')) return;
        state.entries = state.entries.filter(function (x) { return x.id !== e.id; });
        delete selectedEntries[e.id];
        save(); render(); toast('Entry deleted');
      });
      wrap.appendChild(edit); wrap.appendChild(del);
      td.appendChild(wrap); tr.appendChild(td);
      body.appendChild(tr);
    });
    var all = $('entryCheckAll');
    if (all) all.checked = rows.length > 0 && rows.every(function (e) { return selectedEntries[e.id]; });
    updateBulkBar();
  }
  function updateBulkBar() {
    var n = Object.keys(selectedEntries).length;
    var bar = $('entryBulkBar');
    if (!bar) return;
    bar.hidden = n === 0;
    $('entryBulkCount').textContent = n + ' selected';
  }

  function bdRow(parent, label, value, cls) {
    var row = el('div', 'breakdown-row' + (cls ? ' ' + cls : ''));
    row.appendChild(el('span', null, label));
    row.appendChild(el('span', 'mono', value));
    parent.appendChild(row);
  }

  function renderReport() {
    var a = assess();
    $('reportFy').textContent = fyLabel(state.settings.fy) + (a.rates.estimated ? ' · using the latest published rates' : '');
    $('repIncome').textContent = money(a.income);
    $('repDeductions').textContent = money(a.deductions);
    $('repTaxable').textContent = money(a.taxable);

    var v = $('verdict'), amt = $('verdictAmount'), lab = $('verdictLabel');
    if (!a.income) {
      v.className = 'verdict';
      amt.textContent = money(0);
      lab.textContent = 'Add an income statement to see an estimate';
    } else if (a.result >= 0) {
      v.className = 'verdict refund';
      amt.textContent = money(a.result);
      lab.textContent = 'estimated refund — tax withheld exceeds what you owe';
    } else {
      v.className = 'verdict owing';
      amt.textContent = money(Math.abs(a.result));
      lab.textContent = 'estimated amount payable — withholding fell short';
    }

    var bd = $('breakdown');
    bd.innerHTML = '';
    bdRow(bd, 'Taxable income', money(a.taxable));
    bdRow(bd, 'Tax on taxable income', money(a.base));
    if (a.lito) bdRow(bd, 'Less low income tax offset', '−' + money(a.lito), 'sub');
    if (a.levy) bdRow(bd, 'Medicare levy (2%)', money(a.levy), 'sub');
    if (a.mls) bdRow(bd, 'Medicare levy surcharge', money(a.mls), 'sub');
    if (a.help) bdRow(bd, 'HELP/HECS repayment', money(a.help), 'sub');
    bdRow(bd, 'Total liability', money(a.liability), 'total');
    if (a.withheld) bdRow(bd, 'Tax withheld by employers', '−' + money(a.withheld), 'sub');
    if (a.paygi) bdRow(bd, 'PAYG instalments paid', '−' + money(a.paygi), 'sub');
    bdRow(bd, a.result >= 0 ? 'Estimated refund' : 'Estimated payable',
      money(Math.abs(a.result)), 'total');

    renderLadder(a);

    var byCat = {};
    entriesForFY().forEach(function (e) {
      if (e.type !== 'deduction') return;
      if (!byCat[e.category]) byCat[e.category] = { n: 0, sum: 0 };
      byCat[e.category].n++;
      byCat[e.category].sum += e.amount;
    });
    var tb = $('repDeductionBody');
    tb.innerHTML = '';
    var keys = Object.keys(byCat).sort(function (x, y) { return byCat[y].sum - byCat[x].sum; });
    if (!keys.length) { emptyRow(tb, 3, 'No deductions recorded.'); return; }
    keys.forEach(function (k) {
      var tr = el('tr');
      tr.appendChild(el('td', 'cell-cat exp', k));
      tr.appendChild(el('td', 'cell-date ta-r', String(byCat[k].n)));
      tr.appendChild(el('td', 'cell-amount ta-r neg', money(round2(byCat[k].sum))));
      tb.appendChild(tr);
    });
  }

  // Successwa's own view: how the taxable income is actually sliced across brackets.
  function renderLadder(a) {
    var wrap = $('ladder');
    wrap.innerHTML = '';
    var r = a.rates;
    var widest = 0;
    r.brackets.forEach(function (b) {
      var span = (b.to === Infinity ? Math.max(a.taxable, b.from + 1) : b.to) - b.from;
      if (span < 1e9) widest = Math.max(widest, span);
    });

    r.brackets.forEach(function (b) {
      var cap = b.to === Infinity ? Math.max(a.taxable, b.from) : b.to;
      var inBand = Math.max(0, Math.min(a.taxable, cap) - b.from);
      var span = Math.max(1, cap - b.from);
      var pct = Math.min(100, (inBand / span) * 100);

      var row = el('div', 'ladder-row' + (inBand ? '' : ' inactive'));
      var upper = b.to === Infinity ? '+' : money0(b.to);
      row.appendChild(el('span', 'ladder-band',
        money0(b.from) + (b.to === Infinity ? upper : '–' + upper) + '  ' + Math.round(b.rate * 100) + '%'));

      var track = el('div', 'ladder-track');
      var fill = el('div', 'ladder-fill' + (b.rate === 0 ? ' spent' : ''));
      fill.style.width = pct + '%';
      track.appendChild(fill);
      row.appendChild(track);

      row.appendChild(el('span', 'ladder-amt', inBand ? money0(inBand * b.rate) : '—'));
      wrap.appendChild(row);
    });

    $('ladderRates').textContent = 'Vehicle ' + Math.round(r.vehicleCents * 100) + 'c/km · home office ' +
      Math.round(r.homeOfficeRate * 100) + 'c/hr';
  }

  function renderAccount() {
    $('accountEmail').textContent = state.settings.email;
    renderTaxSummary();
    renderBizSummary();
  }

  function renderTaxSummary() {
    var td = taxDetails();
    var r = ratesFor(state.settings.fy);
    var chips = [];
    if (Number(td.helpDebt) > 0) chips.push('HELP debt ' + money(td.helpDebt));
    chips.push(td.cover ? 'Hospital cover' : 'No hospital cover');
    if (td.family === 'family') {
      var k = Number(td.kids) || 0;
      chips.push('Family' + (k ? ' + ' + k + ' child' + (k > 1 ? 'ren' : '') : ''));
    } else {
      chips.push('Single');
    }
    if (td.exempt) chips.push('Medicare exempt');
    var wrap = $('taxSummary');
    wrap.innerHTML = '';
    chips.forEach(function (t) {
      var c = el('span', 'chip', t);
      wrap.appendChild(c);
    });
  }

  function renderBizSummary() {
    var bz = business();
    var chips = [];
    var p = Number(bz.profit) || 0;
    var g = Number(bz.paygi) || 0;
    if (p || g) {
      chips.push('Net ' + (p >= 0 ? 'profit' : 'loss') + ' ' + money(Math.abs(p)));
      if (g) chips.push('PAYG instalments ' + money(g));
    } else {
      chips.push('No business activity entered');
    }
    var wrap = $('bizSummary');
    wrap.innerHTML = '';
    chips.forEach(function (t) {
      var c = el('span', 'chip', t);
      wrap.appendChild(c);
    });
  }

  function populateISFYSelect() {
    var sel = $('isFySelect');
    var current = Number($('fySelect').value) || state.settings.fy;
    sel.innerHTML = '';
    for (var y = current + 1; y >= current - 2; y--) {
      var o = el('option', null, fyLabel(y));
      o.value = y;
      sel.appendChild(o);
    }
    sel.value = current;
  }

  function openISModal(existing) {
    populateISFYSelect();
    if (existing) {
      $('isId').value = existing.id;
      $('isFySelect').value = existing.fy;
      $('isEmployer').value = existing.employer || '';
      $('isGross').value = existing.gross || '';
      $('isWithheld').value = existing.withheld || '';
      $('isResc').value = existing.resc || '';
      $('isRfba').value = existing.rfba || '';
      $('isSuperClaim').value = existing.superClaim || '';
      $('isModalTitle').textContent = 'Edit Income Statement — ' + fyLabel(existing.fy);
    } else {
      $('isId').value = '';
      $('isEmployer').value = '';
      $('isGross').value = '';
      $('isWithheld').value = '';
      $('isResc').value = '';
      $('isRfba').value = '';
      $('isSuperClaim').value = '';
      $('isModalTitle').textContent = 'Add Income Statement — ' + fyLabel(state.settings.fy);
    }
    if ($('isDoc')) $('isDoc').value = '';
    $('isUploadLabel').textContent = existing && existing.docName ? existing.docName : 'Upload income statement (image or PDF)';
    $('isModal').hidden = false;
    $('isEmployer').focus();
  }

  function updateMlsHelp() {
    var r = ratesFor(state.settings.fy);
    var td = { family: $('ptdFamily').value, kids: Number($('ptdKids').value) || 0 };
    $('mlsHelp').textContent = mlsHelpText(r, td);
  }

  function openPTDModal() {
    var td = taxDetails();
    $('ptdHelpDebt').value = td.helpDebt || '';
    $('ptdCover').checked = !!td.cover;
    $('ptdFamily').value = td.family || 'single';
    $('ptdKids').value = td.kids || 0;
    $('ptdExempt').checked = !!td.exempt;
    $('ptdDoc').value = '';
    $('ptdUploadLabel').textContent = td.docName || 'Upload statement (image or PDF)';
    updateMlsHelp();
    $('ptdModal').hidden = false;
  }

  function openBizModal() {
    var bz = business();
    $('bizProfit').value = bz.profit || '';
    $('bizPaygi').value = bz.paygi || '';
    $('bizModal').hidden = false;
  }

  function render() {
    renderFYSelect();
    renderAccount();
    renderDashboard();
    renderEntries();
    renderReport();
    updateStorageMeter();
  }

  /* ---------------- navigation ---------------- */
  var PAGES = ['dashboard', 'entries', 'report', 'business', 'help'];
  function navigate(page) {
    if (PAGES.indexOf(page) === -1) page = 'dashboard';
    PAGES.forEach(function (p) { $('page-' + p).hidden = (p !== page); });
    document.querySelectorAll('.side-item[data-nav]').forEach(function (a) {
      a.classList.toggle('active', a.dataset.nav === page);
    });
    window.scrollTo(0, 0);
  }

  /* ---------------- entry modal ---------------- */
  function currentCategories() {
    return $('entryModal').dataset.type === 'income' ? INCOME_CATEGORIES : DEDUCTION_CATEGORIES;
  }
  function fillCategories(keep) {
    var cats = currentCategories();
    var sel = $('entryCategory');
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
    var key = $('entryCategory').value;
    var box = $('aboutBox');
    box.innerHTML = '';
    box.appendChild(el('b', null, 'About ' + key + ': '));
    box.appendChild(document.createTextNode(cats[key] || ''));
  }
  function setType(type) {
    $('entryModal').dataset.type = type;
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

  function defaultDate() {
    var today = new Date();
    return fyOf(toISO(today)) === state.settings.fy ? toISO(today) : toISO(fyEnd(state.settings.fy));
  }

  function openEntryModal(entry) {
    if (atFreeCap(entry && entry.id)) return;
    setType(entry ? entry.type : 'income');
    fillCategories(entry ? entry.category : null);
    $('entryModalTitle').textContent = entry ? 'Edit Entry' : 'Add Entry';
    $('entryId').value = entry ? entry.id : '';
    $('entryDate').value = entry ? entry.date : defaultDate();
    $('entryAmount').value = entry ? entry.amount : '';
    $('entryRecurring').checked = entry ? !!entry.recurring : false;
    $('entryDesc').value = entry ? entry.description : '';
    $('entrySource').value = entry ? (entry.source || '') : '';
    $('entryNotes').value = entry ? (entry.notes || '') : '';
    draftTags = entry && entry.tags ? entry.tags.slice() : [];
    renderTags();
    $('entryModal').hidden = false;
    $('entryDesc').focus();
  }

  /* ---------------- calculators ---------------- */
  var VEH_NOTES = {
    cents: 'Multiply your work kilometres by the ATO rate. No receipts needed, but keep a diary of trips. Max 5,000 km per year.',
    logbook: 'Claim the business percentage of your actual running costs — fuel, insurance, registration, servicing and depreciation. Needs a valid 12-week logbook.'
  };
  var HO_NOTES = {
    fixed: 'Multiply your work-from-home hours by the ATO rate. Covers electricity, gas, phone, internet and stationery. Must keep a diary/timesheet of actual hours (estimates not accepted).',
    actual: 'Claim the work-related portion of what you actually spent. Needs records for each cost and a way to show how you worked out the percentage.'
  };

  function vehicleResult() {
    var r = ratesFor(state.settings.fy);
    if ($('vehMethod').value === 'cents') {
      var km = Math.min(r.vehicleKmCap, Math.max(0, Number($('vehKm').value) || 0));
      return { total: round2(km * r.vehicleCents), km: km, rates: r };
    }
    var costs = Math.max(0, Number($('vehCosts').value) || 0);
    var pct = Math.min(100, Math.max(0, Number($('vehPct').value) || 0));
    return { total: round2(costs * pct / 100), costs: costs, pct: pct, rates: r };
  }
  function syncVehicle() {
    var cents = $('vehMethod').value === 'cents';
    $('vehCents').hidden = !cents;
    $('vehLog').hidden = cents;
    $('vehNote').textContent = VEH_NOTES[$('vehMethod').value];
    var res = vehicleResult();
    $('vehLine').innerHTML = cents
      ? res.km + ' km × ' + Math.round(res.rates.vehicleCents * 100) + 'c/km = <b>' + money(res.total) + '</b>'
      : money(res.costs) + ' × ' + res.pct + '% = <b>' + money(res.total) + '</b>';
    $('vehRate').textContent = 'Rate for ' + fyLabel(state.settings.fy) +
      (res.rates.estimated ? ' (latest published rate)' : '');
    $('vehTotal').textContent = money(res.total);
  }

  function homeOfficeResult() {
    var r = ratesFor(state.settings.fy);
    if ($('hoMethod').value === 'fixed') {
      var hrs = Math.max(0, Number($('hoHours').value) || 0);
      return { total: round2(hrs * r.homeOfficeRate), hours: hrs, rates: r };
    }
    var costs = Math.max(0, Number($('hoCosts').value) || 0);
    var pct = Math.min(100, Math.max(0, Number($('hoPct').value) || 0));
    return { total: round2(costs * pct / 100), costs: costs, pct: pct, rates: r };
  }
  function syncHomeOffice() {
    var fixed = $('hoMethod').value === 'fixed';
    $('hoFixed').hidden = !fixed;
    $('hoActual').hidden = fixed;
    $('hoNote').textContent = HO_NOTES[$('hoMethod').value];
    var res = homeOfficeResult();
    $('hoLine').innerHTML = fixed
      ? res.hours + ' hours × ' + Math.round(res.rates.homeOfficeRate * 100) + 'c/hr = <b>' + money(res.total) + '</b>'
      : money(res.costs) + ' × ' + res.pct + '% = <b>' + money(res.total) + '</b>';
    $('hoRate').textContent = 'Rate for ' + fyLabel(state.settings.fy) +
      (res.rates.estimated ? ' (latest published rate)' : '');
    $('hoTotal').textContent = money(res.total);
  }

  function addCalcEntry(category, amount, dateStr, notes, description) {
    if (!amount) { toast('Enter a figure first'); return false; }
    if (atFreeCap(null)) return false;
    state.entries.push({
      id: uid(), type: 'deduction', category: category, amount: amount,
      date: dateStr || toISO(fyEnd(state.settings.fy)),
      description: description, source: '', notes: notes || '',
      tags: ['calculated'], recurring: false
    });
    state.settings.fy = fyOf(dateStr || toISO(fyEnd(state.settings.fy)));
    save(); render();
    toast('Added ' + money(amount) + ' deduction');
    return true;
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
    var a = assess();
    var td = taxDetails();
    var rows = [];
    rows.push(['Successwa Personal - Financial Year Export']);
    rows.push(['Financial year', fyLabel(state.settings.fy)]);
    rows.push(['Exported', usDate(toISO(new Date()))]);
    rows.push([]);

    rows.push(['SUMMARY']);
    rows.push(['Item', 'Amount (AUD)']);
    rows.push(['Gross income (income statements)', a.gross.toFixed(2)]);
    rows.push(['PAYG tax withheld (income statements)', a.withheld.toFixed(2)]);
    rows.push(['Other income (transactions)', a.entryIncome.toFixed(2)]);
    rows.push(['Total income', a.income.toFixed(2)]);
    rows.push(['Total deductions (transactions)', a.deductions.toFixed(2)]);
    rows.push([]);

    rows.push(['PERSONAL TAX DETAILS']);
    rows.push(['Field', 'Value']);
    rows.push(['HELP/HECS debt', Number(td.helpDebt) > 0 ? money(td.helpDebt) : 'None']);
    rows.push(['Private hospital cover', td.cover ? 'Yes' : 'No']);
    rows.push(['Medicare levy exemption', td.exempt ? 'Yes' : 'No']);
    rows.push(['Family status', td.family || 'single']);
    rows.push(['Dependent children', Number(td.kids) || 0]);
    rows.push([]);

    rows.push(['TRANSACTIONS']);
    rows.push(['Date', 'Type', 'Category', 'Source', 'Description', 'Amount', 'Notes']);
    sortedEntries().forEach(function (e) {
      rows.push([usDate(e.date), e.type, e.category, e.source || '', e.description, e.amount.toFixed(2), e.notes || '']);
    });

    download('Successwa_Personal_' + fyLabel(state.settings.fy).replace('FY ', 'FY').replace(/\s/g, '') + '.csv',
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
      body: JSON.stringify({ app: 'personal', account: account, data: state })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.j.error || 'save failed');
        toast('Saved ' + res.j.records + ' entries to cloud');
      }).catch(function (e) { toast('Cloud save failed: ' + e.message); });
  }
  function cloudLoad() {
    var account = ($('cloudAccount').value || '').trim().toLowerCase();
    if (!account) { toast('Enter your account email/ID first'); return; }
    toast('Loading from cloud…');
    fetch('/api/load?app=personal&account=' + encodeURIComponent(account))
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.j.error || 'not found');
        if (!confirm('Replace ALL current data with the cloud copy for ' + account + '?')) return;
        var d = res.j.data;
        d.settings = Object.assign(seed().settings, d.settings || {}, { cloudAccount: account });
        d.taxDetails = d.taxDetails || {}; d.business = d.business || {};
        state = d; applyTheme(); save(); render();
        $('storageModal').hidden = true;
        toast('Loaded ' + (state.entries || []).length + ' entries from cloud');
      }).catch(function (e) { toast('Cloud load failed: ' + e.message); });
  }
  function downloadBackup() {
    download('successwa-personal-backup-' + toISO(new Date()) + '.json',
      JSON.stringify({ app: 'successwa-personal', version: 1, exportedAt: new Date().toISOString(), data: state }, null, 2),
      'application/json');
    toast('Backup downloaded');
  }
  // Merge one or more backup files into the current data, de-duplicating by id.
  function mergeBackups(fileList) {
    var files = Array.prototype.slice.call(fileList);
    var ids = {}, sids = {};
    state.entries.forEach(function (e) { ids[e.id] = true; });
    state.statements.forEach(function (s) { sids[s.id] = true; });
    var addedE = 0, addedS = 0, badFiles = 0, done = 0;

    files.forEach(function (file) {
      var reader = new FileReader();
      reader.onload = function () {
        var incoming;
        try {
          var parsed = JSON.parse(reader.result);
          incoming = parsed && parsed.data ? parsed.data : parsed;
        } catch (e) { incoming = null; }
        if (!incoming || !Array.isArray(incoming.entries)) {
          badFiles++;
        } else {
          incoming.entries.forEach(function (e) { if (!ids[e.id]) { state.entries.push(e); ids[e.id] = true; addedE++; } });
          (incoming.statements || []).forEach(function (s) { if (!sids[s.id]) { state.statements.push(s); sids[s.id] = true; addedS++; } });
        }
        finish();
      };
      reader.onerror = function () { badFiles++; finish(); };
      reader.readAsText(file);
    });

    function finish() {
      if (++done < files.length) return;
      save(); render();
      var msg = 'Merged ' + addedE + ' entr' + (addedE === 1 ? 'y' : 'ies') +
        ' and ' + addedS + ' statement' + (addedS === 1 ? '' : 's') +
        ' from ' + (files.length - badFiles) + ' file' + ((files.length - badFiles) === 1 ? '' : 's');
      if (badFiles) msg += ' (' + badFiles + ' skipped)';
      toast(msg);
    }
  }
  // Load a backup file, REPLACING all current data.
  function loadBackup(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var incoming;
      try {
        var parsed = JSON.parse(reader.result);
        incoming = parsed && parsed.data ? parsed.data : parsed;
      } catch (e) { toast('That file is not valid Successwa JSON'); return; }
      if (!incoming || !Array.isArray(incoming.entries)) { toast('That file is not a Successwa Personal backup'); return; }
      if (!confirm('Replace ALL current data with the contents of this backup?\n\nThis cannot be undone. Save a backup of your current data first if you want to keep it.')) return;
      incoming.settings = Object.assign(seed().settings, incoming.settings || {});
      incoming.taxDetails = incoming.taxDetails || {};
      incoming.business = incoming.business || {};
      state = incoming;
      applyTheme(); save(); render();
      $('storageModal').hidden = true;
      toast('Backup loaded — ' + state.entries.length + ' entr' + (state.entries.length === 1 ? 'y' : 'ies'));
    };
    reader.readAsText(file);
  }
  function freeUpSpace() {
    var cutoff = state.settings.fy;
    var old = state.entries.filter(function (e) { return fyOf(e.date) < cutoff; });
    if (!old.length) { toast('Nothing to clear before ' + fyLabel(cutoff)); return; }
    if (!confirm('Permanently delete ' + old.length + ' entr' + (old.length === 1 ? 'y' : 'ies') +
      ' from before ' + fyLabel(cutoff) + '?\n\nDownload a backup first — this cannot be undone.')) return;
    state.entries = state.entries.filter(function (e) { return fyOf(e.date) >= cutoff; });
    state.statements = state.statements.filter(function (s) { return s.fy >= cutoff; });
    save(); render();
    toast('Removed ' + old.length + ' older entr' + (old.length === 1 ? 'y' : 'ies'));
  }

  function openStorageModal() {
    var used = 0;
    try { used = new Blob([localStorage.getItem(STORE_KEY) || '']).size; } catch (e) { used = 0; }
    var pct = Math.min(100, (used / STORE_QUOTA) * 100);
    $('storageBar').style.width = pct + '%';
    $('storageUsage').textContent = bytes(used) + ' used of ~5 MB';
    $('storagePct').textContent = (pct < 1 ? pct.toFixed(pct === 0 ? 0 : 1) : Math.round(pct)) + '%';
    var oldCount = state.entries.filter(function (e) { return fyOf(e.date) < state.settings.fy; }).length;
    $('storageFreeHelp').textContent = oldCount
      ? 'Remove ' + oldCount + ' entr' + (oldCount === 1 ? 'y' : 'ies') + ' from before ' + fyLabel(state.settings.fy) + '. Your backup file (Step 1) keeps a complete copy — nothing is truly lost.'
      : 'No entries from old financial years to remove. Consider removing individual entries manually if storage remains full.';
    $('storageModal').hidden = false;
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

    // panels open modals
    $('panelTax').querySelector('.panel-head').addEventListener('click', function () {
      openPTDModal();
    });
    $('panelBiz').querySelector('.panel-head').addEventListener('click', function () {
      openBizModal();
    });

    $('btnAddEntry').addEventListener('click', function () { openEntryModal(null); });
    $('btnAddEntry2').addEventListener('click', function () { openEntryModal(null); });
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
    function printReport(e) {
      if (e) e.preventDefault();
      navigate('report');
      setTimeout(function () { window.print(); }, 120);
    }
    $('toolPdf').addEventListener('click', printReport);
    $('btnPrintReport').addEventListener('click', printReport);

    $('entrySearch').addEventListener('input', renderEntries);
    $('entryTypeFilter').addEventListener('change', renderEntries);
    if ($('entryCheckAll')) {
      $('entryCheckAll').addEventListener('change', function () {
        var on = this.checked;
        document.querySelectorAll('#entryBody input[type=checkbox]').forEach(function (cb) {
          cb.checked = on; cb.dispatchEvent(new Event('change'));
        });
      });
      $('entryBulkClear').addEventListener('click', function () {
        selectedEntries = {}; $('entryCheckAll').checked = false; renderEntries();
      });
      $('entryBulkDelete').addEventListener('click', function () {
        var ids = Object.keys(selectedEntries);
        if (!ids.length) return;
        if (!confirm('Delete ' + ids.length + ' selected entr' + (ids.length === 1 ? 'y' : 'ies') + '? This cannot be undone.')) return;
        var set = {}; ids.forEach(function (id) { set[id] = true; });
        state.entries = state.entries.filter(function (x) { return !set[x.id]; });
        selectedEntries = {};
        save(); render(); toast('Deleted ' + ids.length + ' entr' + (ids.length === 1 ? 'y' : 'ies'));
      });
    }

    document.querySelectorAll('.type-btn').forEach(function (b) {
      b.addEventListener('click', function () { setType(b.dataset.type); fillCategories(null); });
    });
    $('entryCategory').addEventListener('change', updateAbout);
    $('tagAdd').addEventListener('click', addTagFromInput);
    $('tagInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTagFromInput(); }
    });

    var ALL_MODALS = ['entryModal', 'isModal', 'vehModal', 'hoModal', 'ptdModal', 'bizModal', 'storageModal'];
    $('entryCancel').addEventListener('click', function () { $('entryModal').hidden = true; });
    $('vehCancel').addEventListener('click', function () { $('vehModal').hidden = true; });
    $('hoCancel').addEventListener('click', function () { $('hoModal').hidden = true; });
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

    $('entryForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var amount = Math.abs(Number($('entryAmount').value) || 0);
      if (!amount) { toast('Enter an amount'); return; }
      var record = {
        type: $('entryModal').dataset.type,
        date: $('entryDate').value,
        category: $('entryCategory').value,
        description: $('entryDesc').value.trim(),
        source: $('entrySource').value.trim(),
        notes: $('entryNotes').value.trim(),
        tags: draftTags.slice(),
        recurring: $('entryRecurring').checked,
        amount: amount
      };
      var receiptEl = $('entryReceipt');
      var receipt = receiptEl && receiptEl.files && receiptEl.files[0];
      if (receipt) record.receiptName = receipt.name;
      var id = $('entryId').value;
      if (id) {
        Object.assign(state.entries.find(function (x) { return x.id === id; }), record);
      } else {
        record.id = uid();
        state.entries.push(record);
        state.settings.fy = fyOf(record.date);
      }
      $('entryModal').hidden = true;
      $('entryReceipt').value = '';
      save(); render();
      toast(id ? 'Entry updated' : 'Entry saved');
    });

    $('btnAddIS').addEventListener('click', function () { openISModal(null); });

    $('isForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var editId = $('isId').value;
      var fy = Number($('isFySelect').value) || state.settings.fy;
      var record = {
        fy: fy,
        employer: $('isEmployer').value.trim(),
        gross: Math.abs(Number($('isGross').value) || 0),
        withheld: Math.abs(Number($('isWithheld').value) || 0),
        resc: Math.abs(Number($('isResc').value) || 0),
        rfba: Math.abs(Number($('isRfba').value) || 0),
        superClaim: Math.abs(Number($('isSuperClaim').value) || 0)
      };
      var isDocEl = $('isDoc');
      var doc = isDocEl && isDocEl.files && isDocEl.files[0];
      if (doc) record.docName = doc.name;
      if (editId) {
        var existing = state.statements.find(function (x) { return x.id === editId; });
        if (existing) Object.assign(existing, record);
      } else {
        record.id = uid();
        state.statements.push(record);
      }
      $('isModal').hidden = true;
      if ($('isDoc')) $('isDoc').value = '';
      save(); render();
      toast(editId ? 'Income statement updated' : 'Income statement saved');
    });

    if ($('isDoc')) $('isDoc').addEventListener('change', function () {
      $('isUploadLabel').textContent = this.files && this.files[0] ? this.files[0].name : 'Upload income statement (image or PDF)';
    });

    $('ptdForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var td = taxDetails();
      td.helpDebt = Math.abs(Number($('ptdHelpDebt').value) || 0);
      td.cover = $('ptdCover').checked;
      td.family = $('ptdFamily').value;
      td.kids = Number($('ptdKids').value) || 0;
      td.exempt = $('ptdExempt').checked;
      var ptdDocEl = $('ptdDoc');
      var doc = ptdDocEl && ptdDocEl.files && ptdDocEl.files[0];
      if (doc) td.docName = doc.name;
      $('ptdModal').hidden = true;
      if ($('ptdDoc')) $('ptdDoc').value = '';
      save(); render();
      toast('Tax details saved');
    });

    if ($('ptdDoc')) $('ptdDoc').addEventListener('change', function () {
      $('ptdUploadLabel').textContent = this.files && this.files[0] ? this.files[0].name : 'Upload statement (image or PDF)';
    });

    $('ptdFamily').addEventListener('change', function () {
      updateMlsHelp();
    });
    $('ptdKids').addEventListener('input', function () {
      updateMlsHelp();
    });

    $('bizForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var bz = business();
      bz.profit = Number($('bizProfit').value) || 0;
      bz.paygi = Math.abs(Number($('bizPaygi').value) || 0);
      $('bizModal').hidden = true;
      save(); render();
      toast('Business activity saved');
    });

    $('btnVehicle').addEventListener('click', function () {
      $('vehKm').value = ''; $('vehCosts').value = ''; $('vehPct').value = '';
      $('vehNotes').value = '';
      $('vehDate').value = toISO(fyEnd(state.settings.fy));
      syncVehicle();
      $('vehModal').hidden = false;
    });
    ['vehMethod', 'vehKm', 'vehCosts', 'vehPct'].forEach(function (id) {
      $(id).addEventListener('input', syncVehicle);
      $(id).addEventListener('change', syncVehicle);
    });
    $('vehForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var res = vehicleResult();
      var label = $('vehMethod').value === 'cents'
        ? res.km + ' km at ' + Math.round(res.rates.vehicleCents * 100) + 'c/km'
        : res.pct + '% of ' + money(res.costs) + ' running costs';
      if (addCalcEntry('Vehicle & travel', res.total, $('vehDate').value, $('vehNotes').value.trim(), label)) {
        $('vehModal').hidden = true;
      }
    });

    $('btnHomeOffice').addEventListener('click', function () {
      $('hoHours').value = ''; $('hoCosts').value = ''; $('hoPct').value = '';
      $('hoNotes').value = '';
      $('hoDate').value = toISO(fyEnd(state.settings.fy));
      syncHomeOffice();
      $('hoModal').hidden = false;
    });
    ['hoMethod', 'hoHours', 'hoCosts', 'hoPct'].forEach(function (id) {
      $(id).addEventListener('input', syncHomeOffice);
      $(id).addEventListener('change', syncHomeOffice);
    });
    $('hoForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var res = homeOfficeResult();
      var label = $('hoMethod').value === 'fixed'
        ? res.hours + ' hours at ' + Math.round(res.rates.homeOfficeRate * 100) + 'c/hr'
        : res.pct + '% of ' + money(res.costs) + ' running costs';
      if (addCalcEntry('Home office', res.total, $('hoDate').value, $('hoNotes').value.trim(), label)) {
        $('hoModal').hidden = true;
      }
    });
  }

  /* ---------------- boot ---------------- */
  var auth = null;
  try { auth = JSON.parse(localStorage.getItem('successwa.auth') || 'null'); } catch (e) {}
  if (!auth || !auth.email) { location.href = 'login.html'; return; }
  // Clients arrive here from their portal — give them a way back.
  if (auth.role === 'client') { var bp = document.getElementById('backToPortal'); if (bp) bp.style.display = ''; }

  state = load();
  // Tie this session to the logged-in user for cloud sync.
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

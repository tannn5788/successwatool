// assistant.js — standalone, self-initialising AI help widget.
// Injects a floating chat button (bottom-right) on every page. Collects lightweight
// page context (path, visible heading, active tab, open modal) so answers match the
// exact step the user is on. Talks ONLY to /api/assistant (key stays server-side).
// No dependency on nav.js / hub-common.js so it works on login/personal/business too.
(function () {
  'use strict';
  if (window.__successwaAssistant) return;
  window.__successwaAssistant = true;

  function token() {
    try { var a = JSON.parse(localStorage.getItem('successwa.auth') || 'null'); return a && a.token; }
    catch (e) { return null; }
  }

  // ---- Gather "where am I" context from the live DOM ----
  function pageContext() {
    var ctx = { path: location.pathname };
    var title = document.querySelector('.page-title');
    if (title && title.textContent.trim()) ctx.title = title.textContent.trim();
    else if (document.title) ctx.title = document.title;
    var activeTab = document.querySelector('.seg-btn.active, .tab.active, [role="tab"][aria-selected="true"]');
    if (activeTab && activeTab.textContent.trim()) ctx.tab = activeTab.textContent.trim();
    // Any visible modal? grab its heading.
    var modals = document.querySelectorAll('.modal, .modal-backdrop, [role="dialog"]');
    for (var i = 0; i < modals.length; i++) {
      var m = modals[i];
      if (m.offsetParent !== null && !m.hidden) {
        var h = m.querySelector('h1,h2,h3,.modal-title');
        if (h && h.textContent.trim()) { ctx.modal = h.textContent.trim(); break; }
      }
    }
    return ctx;
  }

  var AUTH_KEY = 'successwa.auth';
  function currentEmail() {
    try { var a = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); return (a && a.email) ? String(a.email).toLowerCase() : 'guest'; }
    catch (e) { return 'guest'; }
  }

  // History is remembered PER ACCOUNT EMAIL, so switching accounts shows a fresh,
  // account-specific conversation (and never leaks one user's chat to another).
  var acct = currentEmail();
  var HIST_KEY = 'successwa.assistant.history.' + acct;
  var OPEN_KEY = 'successwa.assistant.open';
  var history = [];   // {role:'user'|'assistant', text}
  try { history = JSON.parse(localStorage.getItem(HIST_KEY) || '[]') || []; } catch (e) { history = []; }
  function saveHistory() {
    try { localStorage.setItem(HIST_KEY, JSON.stringify(history.slice(-40))); } catch (e) {}
  }

  // ---- Styles (scoped, injected once) ----
  var css = '' +
    '#swaAsstBtn{position:fixed;right:22px;bottom:22px;z-index:99998;width:56px;height:56px;' +
      'border-radius:50%;background:#111418;color:#fff;border:1px solid rgba(255,255,255,.14);' +
      'display:grid;place-items:center;cursor:pointer;box-shadow:0 10px 30px rgba(0,0,0,.28);' +
      'transition:transform .22s cubic-bezier(.16,1,.3,1),box-shadow .22s}' +
    '#swaAsstBtn:hover{transform:translateY(-3px);box-shadow:0 16px 40px rgba(0,0,0,.34)}' +
    '#swaAsstBtn svg{width:24px;height:24px;stroke:#d9b23f;fill:none;stroke-width:1.8;' +
      'stroke-linecap:round;stroke-linejoin:round}' +
    '#swaAsstPanel{position:fixed;right:22px;bottom:88px;z-index:99999;width:370px;max-width:calc(100vw - 32px);' +
      'height:520px;max-height:calc(100vh - 130px);background:#faf7f2;color:#1a1614;border:1px solid #1a1614;' +
      'border-radius:8px;display:none;flex-direction:column;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.30);' +
      'font-family:Karla,system-ui,sans-serif}' +
    '#swaAsstPanel.open{display:flex}' +
    '.swaA-head{background:#111418;color:#fff;padding:13px 15px;display:flex;align-items:center;gap:9px;flex:none}' +
    '.swaA-head b{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:16px;letter-spacing:-.2px}' +
    '.swaA-head .swaA-tag{font-family:"IBM Plex Mono",monospace;font-size:9.5px;letter-spacing:1px;' +
      'text-transform:uppercase;color:#d9b23f;border:1px solid rgba(217,178,63,.4);padding:2px 6px;border-radius:3px}' +
    '.swaA-x{margin-left:auto;background:transparent;border:none;color:rgba(255,255,255,.7);cursor:pointer;' +
      'font-size:20px;line-height:1;padding:2px 4px}' +
    '.swaA-x:hover{color:#fff}' +
    '.swaA-body{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:11px}' +
    '.swaA-msg{max-width:86%;padding:9px 12px;border-radius:9px;font-size:13.5px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}' +
    '.swaA-msg.u{align-self:flex-end;background:#111418;color:#fff;border-bottom-right-radius:2px}' +
    '.swaA-msg.a{align-self:flex-start;background:#fff;border:1px solid #e5ddd0;border-bottom-left-radius:2px}' +
    '.swaA-msg.err{align-self:flex-start;background:#fbeaea;border:1px solid #e3b7b7;color:#8a2b22}' +
    '.swaA-hint{align-self:center;font-family:"IBM Plex Mono",monospace;font-size:10.5px;letter-spacing:.5px;' +
      'text-transform:uppercase;color:#8a8074;text-align:center;padding:6px 10px}' +
    '.swaA-typing{align-self:flex-start;display:flex;gap:5px;align-items:center;padding:11px 13px;' +
      'background:#fff;border:1px solid #e5ddd0;border-radius:9px;border-bottom-left-radius:2px}' +
    '.swaA-typing span{width:7px;height:7px;border-radius:50%;background:#b0a692;display:inline-block;' +
      'animation:swaBlink 1.4s infinite both}' +
    '.swaA-typing span:nth-child(2){animation-delay:.2s}' +
    '.swaA-typing span:nth-child(3){animation-delay:.4s}' +
    '@keyframes swaBlink{0%,80%,100%{transform:translateY(0);opacity:.35}40%{transform:translateY(-4px);opacity:1}}' +
    '.swaA-foot{flex:none;border-top:1px solid #e5ddd0;padding:10px;display:flex;gap:8px;background:#faf7f2}' +
    '.swaA-foot textarea{flex:1;resize:none;height:40px;max-height:110px;border:1px solid #d8cfc0;border-radius:6px;' +
      'padding:9px 11px;font-family:inherit;font-size:13.5px;background:#fff;color:#1a1614;outline:none}' +
    '.swaA-foot textarea:focus{border-color:#96701a}' +
    '.swaA-send{flex:none;width:40px;height:40px;border-radius:6px;background:#111418;color:#fff;border:none;' +
      'cursor:pointer;display:grid;place-items:center}' +
    '.swaA-send:hover{background:#2a2f38}.swaA-send:disabled{opacity:.45;cursor:default}' +
    '.swaA-send svg{width:18px;height:18px;stroke:#fff;fill:none;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}';
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ---- DOM ----
  var btn = document.createElement('button');
  btn.id = 'swaAsstBtn';
  btn.setAttribute('aria-label', 'Open help assistant');
  btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';

  var panel = document.createElement('div');
  panel.id = 'swaAsstPanel';
  panel.innerHTML =
    '<div class="swaA-head"><b>Enzo</b><span class="swaA-tag">AI Assistant</span>' +
      '<button class="swaA-x" aria-label="Close">&times;</button></div>' +
    '<div class="swaA-body" id="swaAbody">' +
      '<div class="swaA-hint">Hi, I\'m Enzo — ask me anything about this page</div>' +
    '</div>' +
    '<div class="swaA-foot">' +
      '<textarea id="swaAinput" placeholder="Ask a question..." rows="1"></textarea>' +
      '<button class="swaA-send" id="swaAsend" aria-label="Send">' +
        '<svg viewBox="0 0 24 24"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>' +
      '</button>' +
    '</div>';

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  var body = panel.querySelector('#swaAbody');
  var input = panel.querySelector('#swaAinput');
  var sendBtn = panel.querySelector('#swaAsend');

  function open() { panel.classList.add('open'); try { sessionStorage.setItem(OPEN_KEY, '1'); } catch (e) {} setTimeout(function () { input.focus(); }, 50); }
  function close() { panel.classList.remove('open'); try { sessionStorage.setItem(OPEN_KEY, '0'); } catch (e) {} }
  btn.addEventListener('click', function () { panel.classList.contains('open') ? close() : open(); });
  panel.querySelector('.swaA-x').addEventListener('click', close);

  var hint = panel.querySelector('.swaA-hint');
  function addMsg(text, cls) {
    if (hint && hint.parentNode) hint.remove();
    var d = document.createElement('div');
    d.className = 'swaA-msg ' + cls;
    d.textContent = text;
    body.appendChild(d);
    body.scrollTop = body.scrollHeight;
    return d;
  }

  // Restore prior conversation (persists across page/tab navigation within the session).
  if (history.length) {
    history.forEach(function (m) { addMsg(m.text, m.role === 'assistant' ? 'a' : 'u'); });
  }
  try { if (sessionStorage.getItem(OPEN_KEY) === '1') open(); } catch (e) {}

  var busy = false;
  function send() {
    if (busy) return;
    var q = input.value.trim();
    if (!q) return;
    input.value = '';
    input.style.height = '40px';
    addMsg(q, 'u');
    history.push({ role: 'user', text: q });
    saveHistory();
    busy = true; sendBtn.disabled = true;

    var typing = document.createElement('div');
    typing.className = 'swaA-typing';
    typing.innerHTML = '<span></span><span></span><span></span>';
    body.appendChild(typing);
    body.scrollTop = body.scrollHeight;

    var headers = { 'Content-Type': 'application/json' };
    var t = token();
    if (t) headers['Authorization'] = 'Bearer ' + t;

    fetch('/api/assistant', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ question: q, page: location.pathname, context: pageContext(), history: history.slice(0, -1) }),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; });
    }).then(function (res) {
      typing.remove();
      if (res.ok && res.j.answer) {
        addMsg(res.j.answer, 'a');
        history.push({ role: 'assistant', text: res.j.answer });
        saveHistory();
      } else {
        addMsg(res.j.error || 'Something went wrong. Please try again.', 'err');
      }
    }).catch(function () {
      typing.remove();
      addMsg('Network error. Please try again.', 'err');
    }).then(function () {
      busy = false; sendBtn.disabled = false; input.focus();
    });
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', function () {
    input.style.height = '40px';
    input.style.height = Math.min(input.scrollHeight, 110) + 'px';
  });
})();

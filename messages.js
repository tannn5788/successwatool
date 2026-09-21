// messages.js — client's secure two-way conversation with the firm.
// Read the full thread, send a new message. Firm replies are always attributed to
// "Syraxx" — staff names are never shown. Poll lightly to pick up replies.
(function () {
  var auth = Nav.guard(['client']);
  if (!auth) return;
  Nav.renderNav('messages.html');
  var esc = Nav.esc;
  var panel = document.getElementById('panel');
  var lastCount = -1;

  Hub.guide('messages', auth.role, {
    client: {
      em: '💬',
      title: 'Secure messages',
      text: 'Message your accountant securely here. This keeps everything in one place — no need for email. We will reply as soon as we can and you will get an email letting you know.',
    },
  });

  function bubble(m) {
    var mine = m.direction === 'in';
    var who = mine ? 'You' : 'Syraxx';
    var align = mine ? 'flex-end' : 'flex-start';
    var bg = mine ? 'var(--brand,#2f6df6)' : 'var(--surface-2,#f0f2f5)';
    var col = mine ? '#fff' : 'inherit';
    return '<div style="display:flex;justify-content:' + align + ';margin:8px 0">' +
      '<div style="max-width:78%;background:' + bg + ';color:' + col + ';padding:10px 14px;border-radius:14px">' +
        '<div style="font-size:12px;opacity:.7;margin-bottom:2px">' + esc(who) + ' · ' + Hub.fmtDateTime(m.created_at) + '</div>' +
        '<div style="white-space:pre-wrap;word-break:break-word">' + esc(m.body) + '</div>' +
      '</div></div>';
  }

  function render(messages) {
    var thread = messages.length
      ? messages.map(bubble).join('')
      : '<p class="muted small" style="text-align:center;padding:24px 0">No messages yet. Send us a message and we will get back to you.</p>';
    panel.innerHTML =
      '<div class="card">' +
        '<div id="thread" style="max-height:52vh;overflow-y:auto;padding:4px 2px">' + thread + '</div>' +
        '<div style="display:flex;gap:8px;margin-top:12px;border-top:1px solid var(--border,#eef0f2);padding-top:12px">' +
          '<textarea id="msgBody" rows="2" placeholder="Type your message…" style="flex:1;resize:vertical"></textarea>' +
          '<button class="btn btn-primary" id="sendBtn" style="align-self:flex-end">Send</button>' +
        '</div>' +
      '</div>';
    var t = document.getElementById('thread');
    if (t) t.scrollTop = t.scrollHeight;
    document.getElementById('sendBtn').addEventListener('click', send);
    document.getElementById('msgBody').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(e); }
    });
  }

  function send(ev) {
    var ta = document.getElementById('msgBody');
    var body = ta.value.trim();
    if (!body) { Hub.toast('Please type a message'); return; }
    var btn = document.getElementById('sendBtn');
    Hub.busy(btn, Nav.api('/api/portal/messages', { method: 'POST', body: { body: body } }))
      .then(function () { ta.value = ''; load(); })
      .catch(function (e) { Hub.toast(e.message); });
  }

  function load() {
    Nav.api('/api/portal/messages').then(function (r) {
      render(r.messages || []);
      lastCount = (r.messages || []).length;
    }).catch(function (e) {
      panel.innerHTML = '<div class="card"><p class="muted">Error: ' + esc(e.message) + '</p></div>';
    });
  }

  // Light poll for new replies while the page is open.
  setInterval(function () {
    Nav.api('/api/portal/messages/count').then(function (r) {
      // If there are unread firm replies, refresh the thread.
      if (r.count > 0) load();
    }).catch(function () {});
  }, 20000);

  load();
})();

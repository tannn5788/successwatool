// settings.js — self-service security settings (two-factor authentication).
(function () {
  var auth = Nav.guard(); // any logged-in role
  if (!auth) return;
  Nav.renderNav('settings.html');
  var esc = Nav.esc;
  var panel = document.getElementById('panel');

  function load() {
    panel.innerHTML = '<p class="muted">Loading…</p>';
    Nav.api('/api/mfa/status').then(render).catch(function (e) {
      panel.innerHTML = '<p class="muted">Error: ' + esc(e.message) + '</p>';
    });
  }

  function methodLabel(m) {
    return m === 'totp' ? 'Authenticator app' : (m === 'email' ? 'Email code' : '');
  }

  function render(s) {
    var body;
    if (s.enabled) {
      body =
        '<p><span class="pill pill-completed">On</span> &nbsp;Two-factor is protecting your account.</p>' +
        '<p class="muted small">Method: <b>' + esc(methodLabel(s.method)) + '</b>. ' +
        'Each time you sign in, you\u2019ll be asked for a 6-digit code.</p>' +
        '<div class="modal-actions" style="justify-content:flex-start">' +
          '<button class="btn btn-sm danger" id="mfaOff">Turn off two-factor</button></div>';
    } else {
      body =
        '<p><span class="pill pill-hold">Off</span> &nbsp;Add a second step at sign-in for extra security.</p>' +
        '<p class="muted small">Choose how you\u2019d like to receive your verification code:</p>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px">' +
          '<button class="btn btn-primary btn-sm" id="mfaEmail">Use email codes</button>' +
          '<button class="btn btn-outline btn-sm" id="mfaTotp">Use an authenticator app</button>' +
        '</div>' +
        '<p class="muted small" style="margin-top:12px">' +
          '<b>Email codes:</b> we email you a 6-digit code each sign-in. ' +
          '<br><b>Authenticator app:</b> use Google Authenticator, Authy, etc. — works even offline.</p>';
    }
    panel.innerHTML = '<div class="card" style="max-width:640px"><h3 style="margin-top:0">Two-factor authentication (2FA)</h3>' + body + '</div>';

    var off = document.getElementById('mfaOff');
    if (off) off.addEventListener('click', disableMfa);
    var em = document.getElementById('mfaEmail');
    if (em) em.addEventListener('click', enableEmail);
    var tp = document.getElementById('mfaTotp');
    if (tp) tp.addEventListener('click', enableTotp);
  }

  // ---- Enable: email codes ----
  function enableEmail(ev) {
    Hub.busy(ev.target, Nav.api('/api/mfa/setup', { method: 'POST', body: { method: 'email' } }))
      .then(function (r) {
        var m = Hub.modal('Confirm email 2FA',
          '<p class="muted small">We sent a 6-digit code to <b>' + esc(r.maskedEmail || 'your email') + '</b>. Enter it below to turn on email two-factor.</p>' +
          '<div class="field"><label>6-digit code</label><input id="cCode" inputmode="numeric" maxlength="6" placeholder="123456"/></div>' +
          '<div class="modal-actions"><button class="btn btn-ghost" id="cCancel">Cancel</button><button class="btn btn-primary" id="cOk">Confirm</button></div>');
        m.q('#cCancel').addEventListener('click', m.close);
        m.q('#cOk').addEventListener('click', function () {
          var code = m.q('#cCode').value.trim();
          if (!/^\d{6}$/.test(code)) { Hub.toast('Enter the 6-digit code'); return; }
          Hub.busy(m.q('#cOk'), Nav.api('/api/mfa/enable', { method: 'POST', body: { method: 'email', code: code, challengeId: r.challengeId } }))
            .then(function () { m.close(); Hub.toast('Two-factor enabled'); load(); })
            .catch(function (e) { Hub.toast(e.message); });
        });
      }).catch(function (e) { Hub.toast(e.message); });
  }

  // ---- Enable: authenticator app (TOTP) ----
  function enableTotp(ev) {
    Hub.busy(ev.target, Nav.api('/api/mfa/setup', { method: 'POST', body: { method: 'totp' } }))
      .then(function (r) {
        var m = Hub.modal('Set up authenticator app',
          '<p class="muted small">1. Open your authenticator app (Google Authenticator, Authy\u2026).<br>' +
          '2. Scan this QR code, or enter the key manually.<br>' +
          '3. Enter the 6-digit code it shows to confirm.</p>' +
          '<div style="text-align:center;margin:12px 0"><img src="' + esc(r.qr) + '" alt="QR code" style="width:180px;height:180px;border:1px solid var(--border);border-radius:8px"/></div>' +
          '<p class="muted small" style="text-align:center">Manual key:<br><code style="word-break:break-all">' + esc(r.secret) + '</code></p>' +
          '<div class="field"><label>6-digit code from the app</label><input id="tCode" inputmode="numeric" maxlength="6" placeholder="123456"/></div>' +
          '<div class="modal-actions"><button class="btn btn-ghost" id="tCancel">Cancel</button><button class="btn btn-primary" id="tOk">Confirm</button></div>');
        m.q('#tCancel').addEventListener('click', m.close);
        m.q('#tOk').addEventListener('click', function () {
          var code = m.q('#tCode').value.trim();
          if (!/^\d{6}$/.test(code)) { Hub.toast('Enter the 6-digit code'); return; }
          Hub.busy(m.q('#tOk'), Nav.api('/api/mfa/enable', { method: 'POST', body: { method: 'totp', code: code } }))
            .then(function () { m.close(); Hub.toast('Two-factor enabled'); load(); })
            .catch(function (e) { Hub.toast(e.message); });
        });
      }).catch(function (e) { Hub.toast(e.message); });
  }

  // ---- Disable ----
  function disableMfa() {
    var m = Hub.modal('Turn off two-factor',
      '<p>Are you sure? Your account will be protected by password only.</p>' +
      '<div class="modal-actions"><button class="btn btn-ghost" id="dCancel">Cancel</button><button class="btn danger" id="dOk">Turn off</button></div>');
    m.q('#dCancel').addEventListener('click', m.close);
    m.q('#dOk').addEventListener('click', function () {
      Hub.busy(m.q('#dOk'), Nav.api('/api/mfa/disable', { method: 'POST' }))
        .then(function () { m.close(); Hub.toast('Two-factor turned off'); load(); })
        .catch(function (e) { Hub.toast(e.message); });
    });
  }

  load();
})();

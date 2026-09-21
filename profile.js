// profile.js — client self-service basic profile.
// Only basic contact details: name, email (read-only), address, mobile, phone,
// preferred contact. NEVER shows or edits TFN / bank / sensitive tax data.
(function () {
  var auth = Nav.guard(['client']);
  if (!auth) return;
  Nav.renderNav('profile.html');
  var esc = Nav.esc;
  var panel = document.getElementById('panel');

  Hub.guide('profile', auth.role, {
    client: { em: '🪪', title: 'Your details', text: 'Keep your contact details up to date so we can reach you. For your security, sensitive information like your TFN and bank details is never shown here.' },
  });

  function field(label, id, val, type, ph) {
    return '<div class="field"><label>' + esc(label) + '</label>' +
      '<input id="' + id + '" type="' + (type || 'text') + '" value="' + esc(val || '') + '"' +
      (ph ? ' placeholder="' + esc(ph) + '"' : '') + '/></div>';
  }

  function render(p) {
    var prefOpts = [['email', 'Email'], ['mobile', 'Mobile'], ['phone', 'Phone']].map(function (o) {
      return '<option value="' + o[0] + '"' + (p.preferredContact === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
    }).join('');
    panel.innerHTML =
      '<div class="card" style="max-width:600px">' +
        field('Full name', 'fName', p.name, 'text', 'Jane Smith') +
        '<div class="field"><label>Email (sign-in)</label>' +
          '<input value="' + esc(p.email) + '" disabled style="opacity:.7"/>' +
          '<p class="muted small" style="margin-top:4px">Contact us if you need to change your sign-in email.</p></div>' +
        field('Mobile', 'fMobile', p.mobile, 'tel', '0400 000 000') +
        field('Phone', 'fPhone', p.phone, 'tel', '(0X) XXXX XXXX') +
        field('Address', 'fAddress', p.address, 'text', 'Street, Suburb, State, Postcode') +
        '<div class="field"><label>Preferred contact method</label>' +
          '<select id="fPref">' + prefOpts + '</select></div>' +
        '<div class="modal-actions" style="justify-content:flex-start">' +
          '<button class="btn btn-primary" id="save">Save changes</button></div>' +
        '<div class="secure-note" style="margin-top:14px;padding:12px;background:var(--surface-2,#f6f7f9);border-radius:8px">' +
          '<p class="muted small" style="margin:0">🔒 For your protection, sensitive tax details (TFN, bank account) are never displayed in the portal.</p>' +
        '</div>' +
      '</div>';
    document.getElementById('save').addEventListener('click', save);
  }

  function save(ev) {
    var body = {
      name: document.getElementById('fName').value.trim(),
      mobile: document.getElementById('fMobile').value.trim(),
      phone: document.getElementById('fPhone').value.trim(),
      address: document.getElementById('fAddress').value.trim(),
      preferredContact: document.getElementById('fPref').value,
    };
    Hub.busy(ev.target, Nav.api('/api/portal/profile', { method: 'POST', body: body }))
      .then(function () { Hub.toast('Profile saved'); })
      .catch(function (e) { Hub.toast(e.message); });
  }

  function load() {
    Nav.api('/api/portal/profile').then(function (r) { render(r.profile); }).catch(function (e) {
      panel.innerHTML = '<p class="muted">Error: ' + esc(e.message) + '</p>';
    });
  }

  load();
})();

// complete-profile.js — mandatory profile completion for new clients (Phase 1).
// Clients whose profile is incomplete are redirected here by nav.js guard.
// On success -> home.html. All fields are required.
(function () {
  var auth = Nav.guard(['client']);
  if (!auth) return;
  Nav.renderNav('complete-profile.html');
  var esc = Nav.esc;
  var panel = document.getElementById('panel');
  var current = {};

  function load() {
    panel.innerHTML = '<p class="muted">Loading…</p>';
    // If the profile is already complete, don't keep the user here.
    Nav.api('/api/portal/status').then(function (s) {
      if (s.profileComplete) { window.location.replace('home.html'); return; }
      return Nav.api('/api/portal/profile').then(function (r) {
        current = r.profile || {};
        render();
      });
    }).catch(function (e) {
      panel.innerHTML = '<div class="card"><p class="muted">Error: ' + esc(e.message) + '</p></div>';
    });
  }

  function opt(val, label, sel) {
    return '<option value="' + val + '"' + (sel === val ? ' selected' : '') + '>' + label + '</option>';
  }

  function render() {
    var pref = current.preferredContact || 'email';
    panel.innerHTML =
      '<div class="card">' +
        '<p class="muted small" style="margin-top:0">Welcome to Syraxx. Please confirm your details so we can look after your tax affairs correctly. All fields are required.</p>' +
        '<div class="field"><label>Full name</label>' +
          '<input id="pName" type="text" autocomplete="name" placeholder="e.g. Jane Smith" value="' + esc(current.name || auth.name || '') + '"/></div>' +
        '<div class="field"><label>Date of birth</label>' +
          '<input id="pDob" type="date" value="' + esc(current.dob || '') + '"/></div>' +
        '<div class="field"><label>Mobile number</label>' +
          '<input id="pMobile" type="tel" autocomplete="tel" placeholder="e.g. 0400 000 000" value="' + esc(current.mobile || '') + '"/></div>' +
        '<div class="field"><label>Residential address</label>' +
          '<textarea id="pAddress" rows="2" autocomplete="street-address" placeholder="Street, suburb, state, postcode">' + esc(current.address || '') + '</textarea></div>' +
        '<div class="field"><label>Preferred contact method</label>' +
          '<select id="pPref">' + opt('email', 'Email', pref) + opt('mobile', 'Mobile', pref) + opt('phone', 'Phone', pref) + '</select></div>' +
        '<div class="modal-actions" style="justify-content:flex-start">' +
          '<button class="btn btn-primary" id="pSave">Save and continue</button>' +
        '</div>' +
      '</div>';
    document.getElementById('pSave').addEventListener('click', save);
  }

  function save(ev) {
    var body = {
      name: document.getElementById('pName').value.trim(),
      dob: document.getElementById('pDob').value.trim(),
      mobile: document.getElementById('pMobile').value.trim(),
      address: document.getElementById('pAddress').value.trim(),
      preferredContact: document.getElementById('pPref').value,
    };
    if (!body.name) { Hub.toast('Please enter your full name.'); return; }
    if (!body.dob) { Hub.toast('Please enter your date of birth.'); return; }
    if (!body.mobile) { Hub.toast('Please enter your mobile number.'); return; }
    if (!body.address) { Hub.toast('Please enter your residential address.'); return; }
    Hub.busy(ev.target, Nav.api('/api/portal/profile/complete', { method: 'POST', body: body }))
      .then(function () {
        Hub.toast('Thanks — your profile is all set!');
        // Next onboarding step: enable 2FA if not done yet, otherwise go home.
        return Nav.api('/api/portal/status').then(function (s) {
          var next = (s && s.mfaEnabled) ? 'home.html' : 'secure-setup.html';
          setTimeout(function () { window.location.replace(next); }, 700);
        }).catch(function () {
          setTimeout(function () { window.location.replace('home.html'); }, 700);
        });
      })
      .catch(function (e) { Hub.toast(e.message); });
  }

  load();
})();

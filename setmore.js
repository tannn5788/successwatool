// setmore.js — thin server-side client for the Setmore booking API.
// The firm connects ONE Setmore account; a long-lived refresh token lives in .env
// (SETMORE_REFRESH_TOKEN). We exchange it for a short-lived access token (~2h) and
// cache it in memory. All calls are made server-side so the token never reaches the
// browser. Docs: https://setmore.docs.apiary.io/
const BASE = 'https://developer.setmore.com/api/v1';
const TOKEN_URL = process.env.SETMORE_TOKEN_URL || (BASE + '/o/oauth2/token');
const REFRESH_TOKEN = process.env.SETMORE_REFRESH_TOKEN || '';

let cached = { accessToken: null, expiresAt: 0 };

function isConfigured() { return !!REFRESH_TOKEN; }

// Exchange the refresh token for an access token, cached until ~1 min before expiry.
async function getAccessToken() {
  if (!isConfigured()) throw new Error('Setmore is not configured (SETMORE_REFRESH_TOKEN missing).');
  const now = Date.now();
  if (cached.accessToken && now < cached.expiresAt - 60000) return cached.accessToken;
  const url = TOKEN_URL + '?refreshToken=' + encodeURIComponent(REFRESH_TOKEN);
  const r = await fetch(url, { method: 'GET' });
  const j = await r.json().catch(() => ({}));
  const tok = j && j.data && j.data.token;
  if (!r.ok || !tok || !tok.access_token) {
    throw new Error('Setmore token refresh failed: ' + (j && (j.msg || j.error) || r.status));
  }
  cached.accessToken = tok.access_token;
  // `expires` is an absolute ms timestamp; `expires_in` is seconds. Prefer absolute.
  cached.expiresAt = tok.expires || (now + (tok.expires_in || 7000) * 1000);
  return cached.accessToken;
}

// Setmore invalidates previously-issued access tokens whenever the refresh token is
// used again elsewhere. If a call fails with an auth error, force a fresh token once
// and retry before giving up.
function isAuthError(j) {
  const m = String((j && (j.msg || j.error)) || '').toLowerCase();
  return m.indexOf('token') !== -1 && (m.indexOf('invalid') !== -1 || m.indexOf('expired') !== -1);
}

async function apiGet(path, _retried) {
  const token = await getAccessToken();
  const r = await fetch(BASE + path, { headers: { Authorization: 'Bearer ' + token } });
  const j = await r.json().catch(() => ({}));
  if ((!r.ok || j.response === false)) {
    if (!_retried && isAuthError(j)) { cached = { accessToken: null, expiresAt: 0 }; return apiGet(path, true); }
    throw new Error('Setmore API error: ' + (j.msg || j.error || r.status));
  }
  return j;
}

async function apiPost(path, body, _retried) {
  const token = await getAccessToken();
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if ((!r.ok || j.response === false)) {
    if (!_retried && isAuthError(j)) { cached = { accessToken: null, expiresAt: 0 }; return apiPost(path, body, true); }
    throw new Error('Setmore API error: ' + (j.msg || j.error || r.status));
  }
  return j;
}

async function apiPut(path, _retried) {
  const token = await getAccessToken();
  const r = await fetch(BASE + path, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  });
  const j = await r.json().catch(() => ({}));
  if ((!r.ok || j.response === false)) {
    if (!_retried && isAuthError(j)) { cached = { accessToken: null, expiresAt: 0 }; return apiPut(path, true); }
    throw new Error('Setmore API error: ' + (j.msg || j.error || r.status));
  }
  return j;
}

// ---- Public helpers ----

// Services offered by the firm. We only surface client-relevant fields.
async function getServices() {
  const j = await apiGet('/bookingapi/services');
  const list = (j.data && j.data.services) || [];
  return list.map((s) => ({
    key: s.key, name: s.service_name, durationMins: s.duration,
    cost: s.cost, currency: s.currency, description: s.description,
    staffKeys: s.staff_keys || [], imageUrl: s.image_url || null,
  }));
}

// Staff (Setmore "staffs"). Used to map a service to bookable staff.
async function getStaff() {
  const j = await apiGet('/bookingapi/staffs');
  const list = (j.data && j.data.staffs) || [];
  return list.map((s) => ({
    key: s.key,
    name: [s.first_name, s.last_name].filter(Boolean).join(' ').trim() || 'Staff',
    imageUrl: s.image_url || null,
  }));
}

// Available time slots for a staff+service on a given date.
// `date` must be dd/MM/yyyy (Setmore's expected format for slots).
async function getSlots(staffKey, serviceKey, date, slotLimit) {
  const j = await apiPost('/bookingapi/slots', {
    staff_key: staffKey, service_key: serviceKey,
    selected_date: date, slot_limit: slotLimit || 20,
  });
  return (j.data && j.data.slots) || [];
}

// Create (or reuse) a customer record, returns its key.
// Setmore expects: { first_name, last_name, email_id, cell_phone }
async function createCustomer(customer) {
  const j = await apiPost('/bookingapi/customer/create', {
    first_name: customer.firstName || customer.first_name || 'Client',
    last_name: customer.lastName || customer.last_name || '',
    email_id: customer.email || customer.email_id || '',
    cell_phone: customer.phone || customer.cell_phone || '',
  });
  return (j.data && j.data.customer && j.data.customer.key) || (j.data && j.data.key) || null;
}

// Convert a Setmore slot label ("2:10 PM") on a yyyy-MM-dd date into a
// { start_time, end_time } pair in Setmore's yyyy-MM-ddTHH:mm format.
function slotToTimes(isoDate, slotLabel, durationMins) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(slotLabel).trim());
  if (!m) throw new Error('Unrecognised slot format: ' + slotLabel);
  let hh = Number(m[1]) % 12;
  if (/PM/i.test(m[3])) hh += 12;
  const mm = Number(m[2]);
  const pad = (n) => String(n).padStart(2, '0');
  const start = isoDate + 'T' + pad(hh) + ':' + pad(mm);
  // Compute end time.
  const total = hh * 60 + mm + (durationMins || 30);
  const eh = Math.floor(total / 60) % 24;
  const em = total % 60;
  const end = isoDate + 'T' + pad(eh) + ':' + pad(em);
  return { start_time: start, end_time: end };
}

// Create an appointment. Requires staff_key, service_key, customer_key,
// start_time & end_time (yyyy-MM-ddTHH:mm).
async function createAppointment(appt) {
  const j = await apiPost('/bookingapi/appointment/create', {
    staff_key: appt.staffKey || appt.staff_key,
    service_key: appt.serviceKey || appt.service_key,
    customer_key: appt.customerKey || appt.customer_key,
    start_time: appt.startTime || appt.start_time,
    end_time: appt.endTime || appt.end_time,
  });
  return j.data || j;
}

// IMPORTANT: Setmore's public API (https://setmore.docs.apiary.io/) exposes NO
// endpoint to delete/cancel or reschedule an appointment. The only appointment
// mutation it documents is updating the *label*:
//   PUT /api/v1/bookingapi/appointments/{key}/label?label={text}
// So to "cancel" on Setmore we flag the appointment's label (e.g. "CANCELLED").
// A human then removes/moves it in the Setmore dashboard. The authoritative
// cancel/reschedule state lives in our own DB.
async function labelAppointment(apptKey, label) {
  return apiPut('/bookingapi/appointments/' + encodeURIComponent(apptKey)
    + '/label?label=' + encodeURIComponent(label));
}

module.exports = {
  isConfigured, getAccessToken, getServices, getStaff, getSlots,
  createCustomer, createAppointment, labelAppointment, slotToTimes,
  _apiGet: apiGet, _apiPost: apiPost, _apiPut: apiPut,
};

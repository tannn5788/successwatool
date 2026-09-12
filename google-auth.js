// google-auth.js — "Continue with Google" sign-in for Successwa.
// Separate from google-drive.js: this only asks for lightweight identity scopes
// (openid email profile) to log a user in. It never touches Drive and never
// stores refresh tokens — login is a one-shot online flow.
'use strict';

const { google } = require('googleapis');

// Lightweight identity scopes only.
const LOGIN_SCOPES = ['openid', 'email', 'profile'];

// The redirect URI must exactly match one registered in Google Cloud Console.
// We derive it from the current host so the same code works on localhost and prod,
// unless GOOGLE_LOGIN_REDIRECT_URI is explicitly set.
function loginRedirectUri(baseUrl) {
  if (process.env.GOOGLE_LOGIN_REDIRECT_URI) return process.env.GOOGLE_LOGIN_REDIRECT_URI;
  return String(baseUrl).replace(/\/+$/, '') + '/api/auth/google/callback';
}

function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

// A fresh OAuth2 client bound to the request-time redirect URI.
function oauthClient(baseUrl) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    loginRedirectUri(baseUrl));
}

// Build the Google consent URL to send the browser to.
function getLoginAuthUrl(baseUrl, state) {
  const client = oauthClient(baseUrl);
  return client.generateAuthUrl({
    access_type: 'online',       // login only — no refresh token needed
    scope: LOGIN_SCOPES,
    state: state,
    prompt: 'select_account',    // let the user pick which Google account
  });
}

// Exchange the ?code= for the signed-in user's verified identity.
// Returns { email, name, emailVerified }.
async function exchangeCodeForProfile(baseUrl, code) {
  const client = oauthClient(baseUrl);
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  // Prefer verifying the id_token (contains email + email_verified + name).
  if (tokens.id_token) {
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const p = ticket.getPayload() || {};
    return {
      email: (p.email || '').toLowerCase(),
      name: p.name || '',
      emailVerified: p.email_verified === true || p.email_verified === 'true',
    };
  }

  // Fallback: call the userinfo endpoint.
  const oauth2api = google.oauth2({ version: 'v2', auth: client });
  const me = await oauth2api.userinfo.get();
  const d = me.data || {};
  return {
    email: (d.email || '').toLowerCase(),
    name: d.name || '',
    emailVerified: d.verified_email === true,
  };
}

module.exports = {
  isConfigured,
  getLoginAuthUrl,
  exchangeCodeForProfile,
  loginRedirectUri,
};

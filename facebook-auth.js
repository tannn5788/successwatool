// facebook-auth.js — "Continue with Facebook" sign-in for Successwa.
// Mirrors google-auth.js: a one-shot online OAuth flow that only asks for
// lightweight identity (email, public_profile) to log a user in. It never
// stores tokens. Uses the Facebook Graph API over native fetch (Node 18+),
// so no extra npm dependency is required.
'use strict';

const GRAPH_VERSION = 'v19.0';
const LOGIN_SCOPES = 'email,public_profile';

// The redirect URI must exactly match one registered in the Facebook App's
// "Valid OAuth Redirect URIs". Derived from the current host so the same code
// works on localhost and prod, unless FACEBOOK_LOGIN_REDIRECT_URI is set.
function loginRedirectUri(baseUrl) {
  if (process.env.FACEBOOK_LOGIN_REDIRECT_URI) return process.env.FACEBOOK_LOGIN_REDIRECT_URI;
  return String(baseUrl).replace(/\/+$/, '') + '/api/auth/facebook/callback';
}

function isConfigured() {
  return !!(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET);
}

// Build the Facebook consent URL to send the browser to.
function getLoginAuthUrl(baseUrl, state) {
  const params = new URLSearchParams({
    client_id: process.env.FACEBOOK_APP_ID,
    redirect_uri: loginRedirectUri(baseUrl),
    state: state,
    scope: LOGIN_SCOPES,
    response_type: 'code',
    auth_type: 'rerequest', // re-ask for email if the user declined it before
  });
  return 'https://www.facebook.com/' + GRAPH_VERSION + '/dialog/oauth?' + params.toString();
}

// Exchange the ?code= for the signed-in user's identity.
// Returns { email, name, emailVerified }.
async function exchangeCodeForProfile(baseUrl, code) {
  // 1) Swap the authorization code for an access token.
  const tokenParams = new URLSearchParams({
    client_id: process.env.FACEBOOK_APP_ID,
    client_secret: process.env.FACEBOOK_APP_SECRET,
    redirect_uri: loginRedirectUri(baseUrl),
    code: code,
  });
  const tokenRes = await fetch(
    'https://graph.facebook.com/' + GRAPH_VERSION + '/oauth/access_token?' + tokenParams.toString());
  const tokenJson = await tokenRes.json();
  if (!tokenRes.ok || !tokenJson.access_token) {
    const msg = (tokenJson.error && tokenJson.error.message) || 'token exchange failed';
    throw new Error('Facebook token exchange failed: ' + msg);
  }
  const accessToken = tokenJson.access_token;

  // 2) Fetch the user's profile. Facebook returns email only if the user
  //    granted the email permission AND has a verified email on file.
  const meParams = new URLSearchParams({ fields: 'id,name,email', access_token: accessToken });
  const meRes = await fetch('https://graph.facebook.com/' + GRAPH_VERSION + '/me?' + meParams.toString());
  const me = await meRes.json();
  if (!meRes.ok) {
    const msg = (me.error && me.error.message) || 'profile fetch failed';
    throw new Error('Facebook profile fetch failed: ' + msg);
  }

  const email = (me.email || '').toLowerCase();
  return {
    email: email,
    name: me.name || '',
    // Facebook only surfaces an email that is already verified on the account,
    // so a present email is treated as verified.
    emailVerified: !!email,
  };
}

module.exports = {
  isConfigured,
  getLoginAuthUrl,
  exchangeCodeForProfile,
  loginRedirectUri,
};

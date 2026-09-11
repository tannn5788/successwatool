// google-drive.js — Google Drive integration for Successwa.
// Model: the firm connects ONE Google account (e.g. AI1@successwa.com) once via
// OAuth2. We store the resulting refresh token in the app_settings table and use
// it server-side to back up uploaded documents to Drive. No per-user OAuth.
'use strict';

const fs = require('fs');
const { google } = require('googleapis');

// --- Settings keys stored in the app_settings table ---
const K_REFRESH_TOKEN = 'google_drive.refresh_token';
const K_CONNECTED_EMAIL = 'google_drive.connected_email';
const K_ROOT_FOLDER_ID = 'google_drive.root_folder_id';

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file', // only files this app creates
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
];

const ROOT_FOLDER_NAME = process.env.GOOGLE_DRIVE_FOLDER_NAME || 'Successwa Documents';

// ---------- small app_settings helpers ----------
async function getSetting(pool, key) {
  const r = await pool.query('SELECT value FROM app_settings WHERE key=$1', [key]);
  return r.rows.length ? r.rows[0].value : null;
}
async function setSetting(pool, key, value, updatedBy) {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_by, updated_at)
     VALUES ($1,$2,$3, now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [key, value, updatedBy || null]);
}
async function delSetting(pool, key) {
  await pool.query('DELETE FROM app_settings WHERE key=$1', [key]);
}

// ---------- OAuth ----------
function getOAuthClient() {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  const redirect = process.env.GOOGLE_REDIRECT_URI;
  if (!id || !secret || !redirect) {
    throw new Error('Google OAuth env not configured (GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI)');
  }
  return new google.auth.OAuth2(id, secret, redirect);
}

function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
}

function getAuthUrl() {
  const oauth2 = getOAuthClient();
  return oauth2.generateAuthUrl({
    access_type: 'offline',   // needed to receive a refresh token
    prompt: 'consent',        // force refresh token even on re-connect
    scope: SCOPES,
  });
}

// Exchange the ?code= from the OAuth callback for tokens and persist them.
async function saveTokensFromCode(pool, code, actor) {
  const oauth2 = getOAuthClient();
  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) {
    // Google only returns a refresh token on first consent; force via prompt=consent above.
    throw new Error('No refresh token returned. Disconnect the app in your Google Account and reconnect.');
  }
  oauth2.setCredentials(tokens);

  // Fetch the connected account email (best-effort).
  let email = '';
  try {
    const oauth2api = google.oauth2({ version: 'v2', auth: oauth2 });
    const me = await oauth2api.userinfo.get();
    email = (me.data && me.data.email) || '';
  } catch (e) { /* non-fatal */ }

  await setSetting(pool, K_REFRESH_TOKEN, tokens.refresh_token, actor);
  await setSetting(pool, K_CONNECTED_EMAIL, email, actor);
  // Reset cached root folder so it is re-created/looked up under the new account.
  await delSetting(pool, K_ROOT_FOLDER_ID);
  return { email };
}

async function isConnected(pool) {
  const t = await getSetting(pool, K_REFRESH_TOKEN);
  return !!t;
}

async function getStatus(pool) {
  const configured = isConfigured();
  const token = configured ? await getSetting(pool, K_REFRESH_TOKEN) : null;
  const email = token ? await getSetting(pool, K_CONNECTED_EMAIL) : null;
  return { configured, connected: !!token, email: email || null, folderName: ROOT_FOLDER_NAME };
}

async function disconnect(pool) {
  await delSetting(pool, K_REFRESH_TOKEN);
  await delSetting(pool, K_CONNECTED_EMAIL);
  await delSetting(pool, K_ROOT_FOLDER_ID);
}

// Build an authorized Drive client from the stored refresh token.
async function getDriveClient(pool) {
  const refreshToken = await getSetting(pool, K_REFRESH_TOKEN);
  if (!refreshToken) throw new Error('Google Drive not connected');
  const oauth2 = getOAuthClient();
  oauth2.setCredentials({ refresh_token: refreshToken });
  return google.drive({ version: 'v3', auth: oauth2 });
}

// ---------- folders ----------
async function findFolder(drive, name, parentId) {
  const q = [
    "mimeType='application/vnd.google-apps.folder'",
    'trashed=false',
    "name='" + String(name).replace(/'/g, "\\'") + "'",
    parentId ? "'" + parentId + "' in parents" : null,
  ].filter(Boolean).join(' and ');
  const r = await drive.files.list({ q, fields: 'files(id,name)', pageSize: 1, spaces: 'drive' });
  return (r.data.files && r.data.files[0]) ? r.data.files[0].id : null;
}

async function createFolder(drive, name, parentId) {
  const r = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentId ? [parentId] : undefined,
    },
    fields: 'id',
  });
  return r.data.id;
}

async function ensureFolder(drive, name, parentId) {
  const existing = await findFolder(drive, name, parentId);
  if (existing) return existing;
  return createFolder(drive, name, parentId);
}

// Get (creating if needed) the root "Successwa Documents" folder id, cached in app_settings.
async function ensureRootFolder(pool, drive) {
  let id = await getSetting(pool, K_ROOT_FOLDER_ID);
  if (id) {
    // Verify it still exists / not trashed.
    try {
      const meta = await drive.files.get({ fileId: id, fields: 'id,trashed' });
      if (meta.data && !meta.data.trashed) return id;
    } catch (e) { /* fall through to recreate */ }
  }
  id = await ensureFolder(drive, ROOT_FOLDER_NAME, null);
  await setSetting(pool, K_ROOT_FOLDER_ID, id, 'system');
  return id;
}

// Make a Drive item (folder/file) shareable via "anyone with the link can view",
// and return its shareable webViewLink. Idempotent — safe to call repeatedly.
async function ensureAnyoneReader(drive, fileId) {
  try {
    await drive.permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' },
    });
  } catch (e) { /* permission may already exist — ignore */ }
  const meta = await drive.files.get({ fileId, fields: 'webViewLink' });
  return (meta.data && meta.data.webViewLink) || null;
}

// ---------- upload ----------
// opts: { localPath, filename, mime, subfolder } — subfolder groups files (e.g. by client/job).
// Returns { fileId, webViewLink, folderId, folderLink } or throws.
async function uploadFileToDrive(pool, opts) {
  const drive = await getDriveClient(pool);
  const rootId = await ensureRootFolder(pool, drive);
  let parentId = rootId;
  let folderLink = null;
  if (opts.subfolder) {
    parentId = await ensureFolder(drive, String(opts.subfolder), rootId);
    // Share the client's folder so staff can open the whole folder in Drive.
    folderLink = await ensureAnyoneReader(drive, parentId);
  }

  const res = await drive.files.create({
    requestBody: { name: opts.filename, parents: [parentId] },
    media: {
      mimeType: opts.mime || 'application/octet-stream',
      body: fs.createReadStream(opts.localPath),
    },
    fields: 'id,webViewLink',
  });
  return {
    fileId: res.data.id,
    webViewLink: res.data.webViewLink || null,
    folderId: opts.subfolder ? parentId : rootId,
    folderLink: folderLink,
  };
}

module.exports = {
  isConfigured,
  isConnected,
  getStatus,
  getAuthUrl,
  saveTokensFromCode,
  disconnect,
  getDriveClient,
  ensureRootFolder,
  uploadFileToDrive,
};

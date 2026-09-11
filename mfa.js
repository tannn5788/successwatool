// mfa.js — Multi-factor authentication for Successwa.
// Supports two methods the user can choose from:
//   - 'email' : a 6-digit one-time code emailed on each login
//   - 'totp'  : an authenticator app (Google Authenticator, Authy, etc.)
// Challenges (login step-2, email-OTP enable) are persisted in the mfa_challenges
// table so the flow works under the PM2 cluster on the VPS (no in-memory state).
'use strict';

const crypto = require('crypto');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');

const ISSUER = 'Successwa';

// Email codes are valid for 10 minutes; login challenges for 10 minutes.
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

// Allow a small clock drift window for authenticator apps (±1 step = ±30s).
authenticator.options = { window: 1 };

function randomId() { return crypto.randomBytes(24).toString('hex'); }
function sixDigitCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }
function hashCode(code) { return crypto.createHash('sha256').update(String(code)).digest('hex'); }

// ---------- TOTP (authenticator app) ----------
function generateTotpSecret() { return authenticator.generateSecret(); } // base32

async function totpQrDataUrl(email, secret) {
  const otpauth = authenticator.keyuri(email, ISSUER, secret);
  const qr = await QRCode.toDataURL(otpauth);
  return { otpauth, qr };
}

function verifyTotp(secret, token) {
  if (!secret || !token) return false;
  try { return authenticator.verify({ token: String(token).replace(/\s+/g, ''), secret }); }
  catch (e) { return false; }
}

// ---------- Challenges (DB-backed) ----------
// Create a challenge row and return its id. For email method, pass the plaintext
// code (it is hashed before storage). For totp login, code is null.
async function createChallenge(pool, { email, purpose, method, code }) {
  const id = randomId();
  const expires = new Date(Date.now() + CHALLENGE_TTL_MS);
  await pool.query(
    `INSERT INTO mfa_challenges (id, email, purpose, method, code_hash, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, email, purpose, method, code != null ? hashCode(code) : null, expires]);
  return id;
}

// Verify a challenge. For email: compares the hashed code. For totp: verifies
// against the provided secret. Returns { ok, email, method, error }.
// On success (or terminal failure) the challenge row is consumed/updated.
async function verifyChallenge(pool, { id, code, totpSecret }) {
  const r = await pool.query('SELECT * FROM mfa_challenges WHERE id=$1', [id]);
  if (!r.rows.length) return { ok: false, error: 'This verification request is invalid or has expired.' };
  const ch = r.rows[0];
  if (new Date(ch.expires_at) < new Date()) {
    await pool.query('DELETE FROM mfa_challenges WHERE id=$1', [id]);
    return { ok: false, error: 'Your code has expired. Please sign in again.' };
  }
  if (ch.attempts >= MAX_ATTEMPTS) {
    await pool.query('DELETE FROM mfa_challenges WHERE id=$1', [id]);
    return { ok: false, error: 'Too many incorrect attempts. Please sign in again.' };
  }

  let good = false;
  if (ch.method === 'totp') good = verifyTotp(totpSecret, code);
  else good = ch.code_hash && hashCode(code) === ch.code_hash;

  if (!good) {
    await pool.query('UPDATE mfa_challenges SET attempts = attempts + 1 WHERE id=$1', [id]);
    return { ok: false, error: 'Incorrect code. Please try again.' };
  }
  // Success — consume the challenge.
  await pool.query('DELETE FROM mfa_challenges WHERE id=$1', [id]);
  return { ok: true, email: ch.email, method: ch.method, purpose: ch.purpose };
}

// Best-effort cleanup of expired challenges (called opportunistically).
async function purgeExpired(pool) {
  try { await pool.query('DELETE FROM mfa_challenges WHERE expires_at < now()'); } catch (e) {}
}

module.exports = {
  ISSUER,
  sixDigitCode,
  generateTotpSecret,
  totpQrDataUrl,
  verifyTotp,
  createChallenge,
  verifyChallenge,
  purgeExpired,
};

// ─────────────────────────────────────────────
//  Admin password gate.
//
//  A small browser-side gate in front of the
//  GitHub-token connect. Static hosting has no
//  server, so the password check runs in the
//  browser — it keeps casual visitors and URL
//  scanners out, but the *real* write-credential
//  remains the GitHub token entered on the next
//  step (see the lock screen hint in admin.astro).
//
//  The expected value is a salted PBKDF2-SHA256
//  digest, not the plaintext password — the
//  password itself never appears in the code.
// ─────────────────────────────────────────────

const USERNAME = 'Admin - AyushWrites';
// pbkdf2-sha256 · 150k iterations · salt 'ayushwrites-admin-gate'
const EXPECTED = 'b0864a3100b057135bd67d8cb099a12993ebfaba7397e6e191f6f4ffa0b1aad0';
const SALT = 'ayushwrites-admin-gate';
const ITERATIONS = 150000;

const SESSION_KEY = 'mc_admin_session';
const FAIL_KEY = 'mc_admin_fails';

// lockout policy: 5 failed attempts within 10 minutes → 1 minute cooldown
const MAX_FAILS = 5;
const WINDOW_MS = 10 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000;

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function digest(password) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(SALT), iterations: ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return hex(new Uint8Array(bits));
}

/** constant-time-ish comparison of two lowercase hex strings */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── session (per tab — dies with the tab, unlike the stored token) ──
export function isSessionOpen() {
  try {
    return sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

export function openSession() {
  try {
    sessionStorage.setItem(SESSION_KEY, '1');
  } catch {
    /* private mode — session just won't persist */
  }
}

export function closeSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {}
}

// ── failed-attempt tracking ──────────────────
function readFails() {
  try {
    const list = JSON.parse(sessionStorage.getItem(FAIL_KEY) || '[]');
    return Array.isArray(list) ? list.filter((t) => typeof t === 'number') : [];
  } catch {
    return [];
  }
}

function writeFails(list) {
  try {
    sessionStorage.setItem(FAIL_KEY, JSON.stringify(list));
  } catch {}
}

function recordFail() {
  const now = Date.now();
  writeFails([...readFails().filter((t) => now - t < WINDOW_MS), now]);
}

/** milliseconds still left in the cooldown, or 0 if attempts are allowed */
export function lockoutRemainingMs() {
  const fails = readFails().filter((t) => Date.now() - t < WINDOW_MS);
  if (fails.length < MAX_FAILS) return 0;
  const last = fails[fails.length - 1];
  return Math.max(0, COOLDOWN_MS - (Date.now() - last));
}

export function resetFails() {
  writeFails([]);
}

/**
 * Verify the admin username + password.
 * Returns { ok: true } on success, { ok: false, locked?: boolean } otherwise.
 */
export async function checkPassword(username, password) {
  if (lockoutRemainingMs() > 0) return { ok: false, locked: true };
  // always derive, so wrong usernames take the same time as wrong passwords
  const [derived] = await Promise.all([digest(password || '')]);
  const ok =
    String(username || '').trim() === USERNAME && safeEqual(derived, EXPECTED);
  if (!ok) recordFail();
  return { ok };
}
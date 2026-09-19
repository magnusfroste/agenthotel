// Browser sessions that expire. Until now a login handed back the panel's one
// static token, so "Session Timeout" in Settings promised a protection that did
// not exist: whoever had the token had it until setup was run again.
//
// Two kinds of credential now. The static auth_token stays for API and MCP
// clients — an integration cannot re-enter a password — and a login gets a
// session of its own that lapses after session_timeout minutes without use.
// Sliding: activity extends it, so a person who is working is never thrown out
// mid-task, and a tab left open over the weekend is.

const crypto = require('crypto');

const DEFAULT_TIMEOUT_MIN = 60;
const MIN_TIMEOUT_MIN = 5;
// A session's expiry is pushed forward at most this often, so a dashboard that
// polls every five seconds does not turn every request into a write.
const TOUCH_INTERVAL_MS = 60 * 1000;

function init(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);
}

function timeoutMs(db) {
  let minutes = DEFAULT_TIMEOUT_MIN;
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'session_timeout'").get();
    const n = parseInt(row?.value);
    if (Number.isFinite(n)) minutes = Math.max(MIN_TIMEOUT_MIN, n);
  } catch (e) { /* settings not ready: default */ }
  return minutes * 60 * 1000;
}

function create(db, now = Date.now()) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, now, now, now + timeoutMs(db));
  return token;
}

// True for the static panel token or a live session. A live session's expiry
// slides forward on use.
function verify(db, token, now = Date.now()) {
  if (!token) return false;
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'auth_token'").get();
  if (stored && stored.value === token) return true;

  const row = db.prepare('SELECT last_seen, expires_at FROM sessions WHERE token = ?').get(token);
  if (!row) return false;
  if (row.expires_at <= now) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return false;
  }
  if (now - row.last_seen >= TOUCH_INTERVAL_MS) {
    db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token = ?')
      .run(now, now + timeoutMs(db), token);
  }
  return true;
}

function revoke(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function purgeExpired(db, now = Date.now()) {
  return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now).changes;
}

module.exports = { init, create, verify, revoke, purgeExpired, timeoutMs, DEFAULT_TIMEOUT_MIN, MIN_TIMEOUT_MIN, TOUCH_INTERVAL_MS };

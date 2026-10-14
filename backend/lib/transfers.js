// Moving an agent between hotels.
//
// Hotel A, where the agent lives, issues a transfer ticket: a one-time URL
// that serves the agent's export zip — config, and volume data when asked —
// to whoever holds it, once, within an hour. Hotel B, the agent's new home,
// is given that URL and fetches the zip itself, server to server, then
// imports it the way an uploaded zip is imported.
//
// Pulled rather than pushed, so neither hotel needs the other's admin token,
// and server to server, so an agent's gigabytes of memory never pass through
// a laptop or a proxy's upload limit (Cloudflare refuses request bodies over
// 100 MB, and a working Hermes carries a gigabyte; 2026-10-14). Moving an
// agent out of one hotel into another is the answer to lock-in: its memory
// is the harness's own files, and they go with it.
//
// Only a hash of the token is stored. A ticket is spent the moment a pull
// begins; a pull that fails needs a new ticket.

const crypto = require('crypto');

const TTL_MS = 60 * 60 * 1000;

function init(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      include_data INTEGER NOT NULL DEFAULT 1,
      stop_on_pull INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      used_by TEXT
    )
  `);
}

const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// A ticket for agentId. Returns { token, expiresAt }; the token is shown once.
function issue(db, agentId, { includeData = true, stopOnPull = true, ttlMs = TTL_MS, now = Date.now() } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO transfers (agent_id, token_hash, include_data, stop_on_pull, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(agentId, hash(token), includeData ? 1 : 0, stopOnPull ? 1 : 0, now, now + ttlMs);
  // Spent and expired tickets are of no use to anyone; keep the table small.
  db.prepare('DELETE FROM transfers WHERE expires_at < ?').run(now - 24 * 60 * 60 * 1000);
  return { token, expiresAt: now + ttlMs };
}

// Spend a ticket. Returns { ticket } or { error: 'unknown' | 'expired' | 'used' }.
function claim(db, token, { by = null, now = Date.now() } = {}) {
  if (!/^[0-9a-f]{64}$/.test(String(token || ''))) return { error: 'unknown' };
  const row = db.prepare('SELECT * FROM transfers WHERE token_hash = ?').get(hash(token));
  if (!row) return { error: 'unknown' };
  if (row.used_at) return { error: 'used' };
  if (row.expires_at <= now) return { error: 'expired' };
  // Conditional update: two pulls racing for one ticket — only one wins.
  const won = db.prepare('UPDATE transfers SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL')
    .run(now, by, row.id).changes === 1;
  if (!won) return { error: 'used' };
  return { ticket: { ...row, used_at: now, used_by: by } };
}

// The URL a ticket is fetched from, on this hotel's own address.
function ticketUrl(base, token) {
  return `${String(base).replace(/\/+$/, '')}/api/transfer/${token}`;
}

// A transfer URL another hotel handed over, checked before this hotel fetches
// it: http(s), with a token in the expected place. Returns the URL or throws.
function parseTicketUrl(raw) {
  let url;
  try { url = new URL(String(raw || '').trim()); } catch (_) { throw new Error('Not a URL'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The transfer URL must be http or https');
  if (!/^\/api\/transfer\/[0-9a-f]{64}$/.test(url.pathname)) {
    throw new Error('Not an AgentHotel transfer URL — it ends in /api/transfer/<token>');
  }
  if (url.username || url.password) throw new Error('The transfer URL must not carry credentials');
  return url.toString();
}

module.exports = { init, issue, claim, ticketUrl, parseTicketUrl, hash, TTL_MS };

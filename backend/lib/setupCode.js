// Who may create the admin account on a fresh panel.
//
// install.sh brought the panel up on http://<ip> with a catch-all route, and
// POST /api/setup took the first email and password anyone sent. Whoever got
// there first was admin — and the panel is root on its host. Scanners sweep
// every IPv4 address on port 80 within hours, and a new domain appears in the
// certificate transparency logs the minute Caddy fetches its certificate, so
// "first" was not reliably the person who ran the installer (security sweep,
// 2026-09-30).
//
// Now setup also needs a code that exists only on the server: generated at
// the first boot without an admin, printed by install.sh and by
// `agenthotel setup-code`, and deleted the moment an account is created.
// Reading it takes a shell on the host, which is exactly the person entitled
// to the panel.

const crypto = require('crypto');
const fs = require('fs');

// No 0/O, 1/l/I: it is read off a terminal and typed, sometimes on a phone.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function generate(length = 20) {
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length)) {
      if (byte < 256 - (256 % ALPHABET.length)) out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

// The code for this unconfigured panel, created once and kept across restarts
// so the one install.sh printed stays valid. The file is for the host's shell;
// the database row is what the check reads.
function ensure(db, filePath) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'setup_code'").get();
  const code = row?.value || generate();
  if (!row) db.prepare("INSERT INTO settings (key, value) VALUES ('setup_code', ?)").run(code);
  if (filePath) {
    try { fs.writeFileSync(filePath, code + '\n', { mode: 0o600 }); } catch (e) { /* the log line still has it */ }
  }
  return code;
}

// Constant-time, and forgiving of what copying from a terminal adds: spaces,
// a trailing newline, upper case.
function matches(db, supplied) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'setup_code'").get();
  if (!row?.value || typeof supplied !== 'string') return false;
  const given = Buffer.from(supplied.replace(/\s+/g, '').toLowerCase());
  const expected = Buffer.from(row.value);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function clear(db, filePath) {
  db.prepare("DELETE FROM settings WHERE key = 'setup_code'").run();
  if (filePath) { try { fs.unlinkSync(filePath); } catch (e) { /* already gone */ } }
}

module.exports = { generate, ensure, matches, clear, ALPHABET };

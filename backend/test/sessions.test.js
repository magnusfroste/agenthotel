// What "Session Timeout" now actually does.
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const sessions = require('../lib/sessions');

function fresh(timeoutMinutes) {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT INTO settings VALUES ('auth_token', 'static-panel-token')").run();
  if (timeoutMinutes !== undefined) db.prepare("INSERT INTO settings VALUES ('session_timeout', ?)").run(String(timeoutMinutes));
  sessions.init(db);
  return db;
}

test('a login gets a session that is not the panel token', () => {
  const db = fresh();
  const token = sessions.create(db);
  assert.notStrictEqual(token, 'static-panel-token');
  assert.ok(sessions.verify(db, token));
});

test('the static panel token still works — integrations cannot re-enter a password', () => {
  assert.ok(sessions.verify(fresh(), 'static-panel-token'));
});

test('a session lapses after the configured minutes without use', () => {
  const db = fresh(10);
  const t0 = 1_000_000;
  const token = sessions.create(db, t0);
  // No use in between — a check is use, and use extends the window.
  assert.strictEqual(sessions.verify(db, token, t0 + 11 * 60 * 1000), false, 'past the window');
  assert.strictEqual(sessions.verify(db, token, t0), false, 'and it is gone for good');
});

test('activity extends a session — a person at work is never thrown out mid-task', () => {
  const db = fresh(10);
  const t0 = 1_000_000;
  const token = sessions.create(db, t0);
  sessions.verify(db, token, t0 + 8 * 60 * 1000);   // used at minute 8: expiry moves to 18
  assert.ok(sessions.verify(db, token, t0 + 15 * 60 * 1000), 'alive at minute 15 thanks to the touch');
});

test('the timeout has a floor, so a typo cannot set it to zero', () => {
  assert.strictEqual(sessions.timeoutMs(fresh(0)), sessions.MIN_TIMEOUT_MIN * 60 * 1000);
  assert.strictEqual(sessions.timeoutMs(fresh()), sessions.DEFAULT_TIMEOUT_MIN * 60 * 1000);
});

test('logging out revokes the session and nothing else', () => {
  const db = fresh();
  const a = sessions.create(db), b = sessions.create(db);
  sessions.revoke(db, a);
  assert.strictEqual(sessions.verify(db, a), false);
  assert.ok(sessions.verify(db, b));
  assert.ok(sessions.verify(db, 'static-panel-token'));
});

test('garbage and empty tokens are refused', () => {
  const db = fresh();
  assert.strictEqual(sessions.verify(db, ''), false);
  assert.strictEqual(sessions.verify(db, undefined), false);
  assert.strictEqual(sessions.verify(db, 'not-a-token'), false);
});

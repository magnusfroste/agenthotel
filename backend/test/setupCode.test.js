// Who may create the first admin of a panel that is root on its host.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const setupCode = require('../lib/setupCode');

function freshDb() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  return db;
}

test('a code is made once and survives a restart, so the one install printed stays valid', () => {
  const db = freshDb();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-')), 'setup-code');
  const first = setupCode.ensure(db, file);
  assert.match(first, new RegExp(`^[${setupCode.ALPHABET}]{20}$`));
  assert.strictEqual(setupCode.ensure(db, file), first);
  assert.strictEqual(fs.readFileSync(file, 'utf8').trim(), first);
  assert.strictEqual(fs.statSync(file).mode & 0o077, 0, 'readable by root only');
});

test('only the code opens setup, forgiving what a terminal copy adds', () => {
  const db = freshDb();
  const code = setupCode.ensure(db);
  assert.ok(setupCode.matches(db, code));
  assert.ok(setupCode.matches(db, ` ${code.toUpperCase()}\n`));
  assert.ok(!setupCode.matches(db, code.slice(0, -1) + (code.endsWith('a') ? 'b' : 'a')));
  assert.ok(!setupCode.matches(db, ''));
  assert.ok(!setupCode.matches(db, undefined));
});

test('without a code on the server nothing matches — not even an empty one', () => {
  const db = freshDb();
  assert.ok(!setupCode.matches(db, ''));
  assert.ok(!setupCode.matches(db, 'anything'));
});

test('the code is spent when the admin is created', () => {
  const db = freshDb();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-')), 'setup-code');
  const code = setupCode.ensure(db, file);
  setupCode.clear(db, file);
  assert.ok(!setupCode.matches(db, code));
  assert.ok(!fs.existsSync(file));
});

// What an upgrade would cut off (lib/upgradeGuard.js). Moves were missing: an
// upgrade killed gun's import and another killed ada's pull, each
// spending its one-time ticket (2026-10-29).
const { test } = require('node:test');
const assert = require('node:assert');
const { upgradeBlocker } = require('../lib/upgradeGuard');

test('nothing running: the upgrade may go ahead', () => {
  assert.strictEqual(upgradeBlocker({}), null);
});

test('an upgrade already running cannot be forced', () => {
  const b = upgradeBlocker({ upgradeRunning: true, moves: [{ kind: 'upload' }] });
  assert.strictEqual(b.status, 409);
  assert.strictEqual(b.forceable, false);
});

test('a deploy and a backup block, and can be forced', () => {
  const d = upgradeBlocker({ deploys: [{ name: 'bo', status: 'redeploying' }] });
  assert.strictEqual(d.forceable, true);
  assert.match(d.body.error, /bo \(redeploying\)/);
  const b = upgradeBlocker({ backup: 'ada' });
  assert.match(b.body.error, /backup is running \(ada\)/);
});

test('a pull in progress blocks, and says how far it has come', () => {
  const b = upgradeBlocker({ moves: [{ kind: 'pull', from: 'agenthotel.example.com', bytes: 1.2e9, total: 3.2e9 }] });
  assert.strictEqual(b.status, 409);
  assert.strictEqual(b.forceable, true);
  assert.match(b.body.error, /a pull from agenthotel\.example\.com \(1200 MB of 3200 MB\)/);
  assert.match(b.body.error, /one-time ticket/);
});

test('uploads and exports count as moves too', () => {
  const b = upgradeBlocker({ moves: [{ kind: 'upload' }, { kind: 'export', name: 'ada', to: '198.51.100.20' }] });
  assert.match(b.body.error, /an uploaded import, an export of ada to 198\.51\.100\.20/);
});

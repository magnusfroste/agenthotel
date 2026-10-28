// Nightly backups (lib/backups.js): when they run, what is kept, and that the
// S3 secret and its settings are read the way the card writes them.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const b = require('../lib/backups');

test('a stamp sorts by time and is safe as a folder and an S3 key', () => {
  const s = b.stamp(new Date('2026-10-28T03:00:12.345Z'));
  assert.strictEqual(s, '2026-10-28T03-00-12Z');
  assert.match(s, b.STAMP_RE);
});

test('the run is due once a day, at or after the hour (UTC)', () => {
  const at = iso => new Date(iso);
  assert.strictEqual(b.isDue(at('2026-10-28T02:59:00Z'), null, 3), false, 'not before the hour');
  assert.strictEqual(b.isDue(at('2026-10-28T03:05:00Z'), null, 3), true, 'never ran');
  assert.strictEqual(b.isDue(at('2026-10-28T03:15:00Z'), '2026-10-28T03:05:00Z', 3), false, 'already ran today');
  assert.strictEqual(b.isDue(at('2026-10-29T03:00:00Z'), '2026-10-28T03:05:00Z', 3), true, 'tomorrow again');
  assert.strictEqual(b.isDue(at('2026-10-29T03:00:00Z'), 'garbage', 3), true);
});

test('the newest backups are kept, never fewer than one', () => {
  const stamps = ['2026-10-25T03-00-00Z', '2026-10-27T03-00-00Z', '2026-10-26T03-00-00Z', 'not-a-backup'];
  assert.deepStrictEqual(b.beyondKeep(stamps, 2), ['2026-10-25T03-00-00Z']);
  assert.deepStrictEqual(b.beyondKeep(stamps, 0), ['2026-10-26T03-00-00Z', '2026-10-25T03-00-00Z']);
});

test('settings: defaults, bounds, and S3 only counts as configured when complete', () => {
  const store = {};
  let s = b.readSettings(k => store[k]);
  assert.strictEqual(s.enabled, false);
  assert.strictEqual(s.hour, 3);
  assert.strictEqual(s.s3Configured, false);
  Object.assign(store, { backup_enabled: 'true', backup_hour: '30', backup_keep_local: '0', backup_s3_endpoint: 'fsn1.your-objectstorage.com', backup_s3_bucket: 'hotel', backup_s3_access_key: 'AK', backup_s3_prefix: '/agenthotel/' });
  s = b.readSettings(k => store[k]);
  assert.strictEqual(s.hour, 23);
  assert.strictEqual(s.keepLocal, 1);
  assert.strictEqual(s.s3.prefix, 'agenthotel');
  assert.strictEqual(s.s3Configured, false, 'no secret yet');
  store[b.SECRET_KEY] = 'secret';
  assert.strictEqual(b.readSettings(k => store[k]).s3Configured, true);
  assert.strictEqual(b.remotePrefix('agenthotel', 'reports'), 'agenthotel/reports/');
  assert.strictEqual(b.remotePrefix('', 'reports'), 'reports/');
});

test('local backups are listed newest first with their size', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backups-'));
  for (const s of ['2026-10-26T03-00-00Z', '2026-10-27T03-00-00Z']) {
    fs.mkdirSync(path.join(root, 'reports', s), { recursive: true });
    fs.writeFileSync(path.join(root, 'reports', s, 'agent.json'), '{}');
  }
  fs.mkdirSync(path.join(root, 'reports', 'tmp'));
  const list = b.listLocal('reports', root);
  assert.deepStrictEqual(list.map(x => x.stamp), ['2026-10-27T03-00-00Z', '2026-10-26T03-00-00Z']);
  assert.strictEqual(list[0].bytes, 2);
  assert.deepStrictEqual(b.listLocal('nobody', root), []);
});

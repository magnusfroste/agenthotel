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

// 2026-11-20: one part of a 3 GB upload sat on a silent socket for over an
// hour, and the night's run never finished.
function fakeUpload() {
  const handlers = [];
  let finish;
  const up = {
    aborted: false,
    on: (ev, fn) => { if (ev === 'httpUploadProgress') handlers.push(fn); },
    progress: (loaded) => handlers.forEach(fn => fn({ loaded })),
    done: () => new Promise(resolve => { finish = resolve; }),
    finish: () => finish(),
    abort: async () => { up.aborted = true; },
  };
  return up;
}

test('an upload that stops moving is aborted, and the run goes on with an error', async () => {
  let clock = 0;
  const up = fakeUpload();
  const waiting = b.doneOrStalled(up, { stallMs: 1000, checkMs: 5, label: 'big.tar.gz', now: () => clock });
  up.progress(100); clock = 900; up.progress(200);   // moving
  clock = 1500;                                       // 600 ms since the last bytes: still fine
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(up.aborted, false);
  clock = 2000;                                       // 1100 ms with nothing
  await assert.rejects(waiting, /big\.tar\.gz: no progress for 0 min, aborted/);
  assert.strictEqual(up.aborted, true);
});

test('an upload that keeps moving is waited for, however long it takes', async () => {
  let clock = 0;
  const up = fakeUpload();
  const waiting = b.doneOrStalled(up, { stallMs: 1000, checkMs: 5, now: () => clock });
  for (let i = 1; i <= 5; i++) { clock += 800; up.progress(i * 100); await new Promise(r => setTimeout(r, 10)); }
  up.finish();
  await waiting;
  assert.strictEqual(up.aborted, false);
});

// 2026-11-24: an upgrade at 03:40 restarted the backend after five guests;
// the next check began again from the first under a new stamp.
test('a run cut short is taken up again under its own stamp, with what was done', () => {
  const now = Date.parse('2026-11-24T03:56:00Z');
  const record = JSON.stringify({
    stamp: '2026-11-24T03-05-29Z', startedAt: '2026-11-24T03:05:29.000Z', trigger: 'schedule',
    results: [
      { name: 'agent-take', ok: true, volumes: 1 },
      { name: 'christer', ok: true, volumes: 3 },
      { name: 'david', ok: false, error: 'skipped: a deploy is running' },
    ]
  });
  const r = b.resumable(record, now);
  assert.strictEqual(r.stamp, '2026-11-24T03-05-29Z');
  // A guest that failed is tried again, so only the ones that worked count as done.
  assert.deepStrictEqual(r.results.map(x => x.name), ['agent-take', 'christer']);
});

test('nothing to take up: no record, a broken one, or one from another night', () => {
  const now = Date.parse('2026-11-24T03:56:00Z');
  assert.strictEqual(b.resumable(null, now), null);
  assert.strictEqual(b.resumable('{not json', now), null);
  assert.strictEqual(b.resumable({ stamp: 'yesterday', startedAt: '2026-11-24T03:05:29Z', results: [] }, now), null);
  const old = { stamp: '2026-11-23T03-05-28Z', startedAt: '2026-11-23T03:05:28Z', results: [] };
  assert.strictEqual(b.resumable(old, now), null);
  assert.ok(b.resumable(old, Date.parse('2026-11-23T20:00:00Z')));
});

test('a backup a cut-short run left unverified is removed, and never counts as one of the kept', () => {
  const list = [
    { stamp: '2026-11-24T03-56-58Z', verified: false }, // being written now
    { stamp: '2026-11-24T03-05-29Z', verified: false }, // cut short
    { stamp: '2026-11-23T03-05-28Z', verified: true },
    { stamp: '2026-11-22T03-08-21Z', verified: true },
    { stamp: '2026-11-21T03-08-07Z', verified: true },
    { stamp: '2026-11-20T03-07-55Z', verified: true },
  ];
  assert.deepStrictEqual(b.localToRemove(list, 3, '2026-11-24T03-56-58Z'),
    ['2026-11-20T03-07-55Z', '2026-11-24T03-05-29Z']);
  // Without one being written, every unverified one goes.
  assert.deepStrictEqual(b.localToRemove(list, 3), ['2026-11-20T03-07-55Z', '2026-11-24T03-05-29Z', '2026-11-24T03-56-58Z']);
});

// ---- The upload queue ----

test('a backup still waiting for S3 is never removed from the host', () => {
  const list = [
    { stamp: '2026-11-25T03-05-02Z', verified: true },
    { stamp: '2026-11-24T03-56-58Z', verified: true },
    { stamp: '2026-11-23T03-05-28Z', verified: true },
    { stamp: '2026-11-22T03-08-21Z', verified: true }, // still queued: the bucket was slow
  ];
  assert.deepStrictEqual(b.localToRemove(list, 3, '2026-11-25T03-05-02Z'), ['2026-11-22T03-08-21Z']);
  assert.deepStrictEqual(b.localToRemove(list, 3, ['2026-11-25T03-05-02Z', '2026-11-22T03-08-21Z']), []);
});

test('the queue takes each backup once, in order, and skips one waiting to be tried again', () => {
  let q = b.queueAdd([], { name: 'alpha', stamp: '2026-11-25T03-05-02Z' }, 1000);
  q = b.queueAdd(q, { name: 'beta', stamp: '2026-11-25T03-05-02Z' }, 2000);
  // A resumed run queues alpha again; it stays one entry.
  q = b.queueAdd(JSON.stringify(q), { name: 'alpha', stamp: '2026-11-25T03-05-02Z' }, 3000);
  assert.deepStrictEqual(q.map(x => x.name), ['alpha', 'beta']);
  assert.strictEqual(b.nextUpload(q, 5000).name, 'alpha');

  const first = b.afterFailure(q, q[0], 'no progress for 10 min, aborted', 5000);
  assert.strictEqual(first.gaveUp, false);
  assert.strictEqual(first.queue[0].attempts, 1);
  assert.strictEqual(first.queue[0].notBefore, 5000 + b.UPLOAD_RETRY_MS);
  // alpha waits, so beta goes first; once alpha's time comes it is next again.
  assert.strictEqual(b.nextUpload(first.queue, 6000).name, 'beta');
  assert.strictEqual(b.nextUpload(b.queueRemove(first.queue, { name: 'beta', stamp: '2026-11-25T03-05-02Z' }), 6000), null);
  assert.strictEqual(b.nextUpload(first.queue, 5000 + b.UPLOAD_RETRY_MS).name, 'alpha');
  assert.deepStrictEqual(b.queuedStamps(first.queue, 'alpha'), ['2026-11-25T03-05-02Z']);
});

test('after the last attempt an upload leaves the queue as given up', () => {
  let q = b.queueAdd([], { name: 'alpha', stamp: '2026-11-25T03-05-02Z' });
  for (let i = 1; i < b.UPLOAD_ATTEMPTS; i++) {
    const r = b.afterFailure(q, q[0], 'HTTP 503');
    assert.strictEqual(r.gaveUp, false);
    q = r.queue;
  }
  const last = b.afterFailure(q, q[0], 'HTTP 503');
  assert.strictEqual(last.gaveUp, true);
  assert.deepStrictEqual(last.queue, []);
});

test('the card sees each guest as uploaded, queued, retrying or as the run left it', () => {
  const st = '2026-11-25T03-05-02Z';
  const summary = { stamp: st, results: [
    { name: 'alpha', ok: true, s3: 'queued' },
    { name: 'beta', ok: true, s3: 'queued' },
    { name: 'gamma', ok: true, s3: 'queued' },
    { name: 'delta', ok: false, error: 'skipped: a deploy is running' },
  ] };
  let uploaded = b.recordUpload({}, st, 'alpha', { s3: 'uploaded', seconds: 40 });
  let q = b.queueAdd([], { name: 'beta', stamp: st });
  q = b.queueAdd(q, { name: 'gamma', stamp: st });
  q = b.afterFailure(q, q[1], 'HTTP 503').queue;
  const view = b.withUploads(summary, JSON.stringify(uploaded), q);
  assert.deepStrictEqual(view.results.map(r => r.s3), ['uploaded', 'queued', 'retrying (HTTP 503)', undefined]);
  assert.strictEqual(view.results[0].uploadSeconds, 40);
  assert.strictEqual(b.withUploads(null, uploaded, q), null);
});

test('the upload record keeps only the newest few nights', () => {
  let m = {};
  for (const d of ['21', '22', '23', '24']) m = b.recordUpload(m, `2026-11-${d}T03-05-00Z`, 'alpha', { s3: 'uploaded' });
  m = b.recordUpload(m, '2026-11-24T03-05-00Z', 'beta', { s3: 'failed: HTTP 403' });
  assert.deepStrictEqual(Object.keys(m).sort(), ['2026-11-22T03-05-00Z', '2026-11-23T03-05-00Z', '2026-11-24T03-05-00Z']);
  assert.deepStrictEqual(Object.keys(m['2026-11-24T03-05-00Z']), ['alpha', 'beta']);
});

// An identical redeploy joins the one already queued or running.
const { test } = require('node:test');
const assert = require('node:assert');
const { createRedeployGate, sameRevision } = require('../lib/redeployGate');
const { pickRemoteRevision } = require('../plugins/git-app');

const quiet = { log() {}, warn() {} };
const REEL = 'git-app-reel-studio-1790886075660';

// A redeploy whose progress the test drives: start() is its turn in the queue
// coming, read(commit) its fetch, finish() the end.
function controlled() {
  const runs = [];
  const run = entry => {
    let finish, fail;
    const promise = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    runs.push({
      entry,
      start() { entry.started = true; },
      read(commit) { entry.revision = commit; },
      finish: v => finish(v),
      fail: e => fail(e)
    });
    return promise;
  };
  return { runs, run };
}

test('a redeploy asked for while an identical one is queued joins it', async () => {
  const gate = createRedeployGate({ log: quiet });
  const { runs, run } = controlled();
  const a = await gate.redeploy(REEL, 'k', run);
  const b = await gate.redeploy(REEL, 'k', run);
  assert.strictEqual(a.joined, null);
  assert.strictEqual(b.joined, 'queued');
  assert.strictEqual(runs.length, 1, 'one build, not two');
  runs[0].finish('done');
  assert.strictEqual(await b.promise, 'done');
});

test('2026-10-09: the same commit, a minute into the first build, joins it', async () => {
  const gate = createRedeployGate({ log: quiet });
  const { runs, run } = controlled();
  const asked = [];
  await gate.redeploy(REEL, 'k', run);
  runs[0].start();
  runs[0].read('34f593e');
  const second = await gate.redeploy(REEL, 'k', run, {
    remoteRevision: async () => { asked.push(1); return '34f593e1c0ffee00000000000000000000000000'; }
  });
  assert.strictEqual(second.joined, 'running');
  assert.strictEqual(second.revision, '34f593e');
  assert.strictEqual(runs.length, 1);
  assert.strictEqual(asked.length, 1);
});

test('a new commit since the running build started queues a second redeploy', async () => {
  const gate = createRedeployGate({ log: quiet });
  const { runs, run } = controlled();
  await gate.redeploy(REEL, 'k', run);
  runs[0].start();
  runs[0].read('34f593e');
  const second = await gate.redeploy(REEL, 'k', run, { remoteRevision: async () => '9a1b2c3d' });
  assert.strictEqual(second.joined, null);
  assert.strictEqual(runs.length, 2);

  // A third, identical request joins the queued second rather than the first.
  const third = await gate.redeploy(REEL, 'k', run, { remoteRevision: async () => '9a1b2c3d' });
  assert.strictEqual(third.joined, 'queued');
  assert.strictEqual(third.promise, second.promise);
});

test('a source that cannot be asked, or a running build that has not read it, never joins', async () => {
  const gate = createRedeployGate({ log: quiet });
  const { runs, run } = controlled();
  await gate.redeploy(REEL, 'k', run);
  runs[0].start();
  // Still fetching: no commit yet.
  const early = await gate.redeploy(REEL, 'k', run, { remoteRevision: async () => '34f593e' });
  assert.strictEqual(early.joined, null);

  const gate2 = createRedeployGate({ log: quiet });
  const c = controlled();
  await gate2.redeploy(REEL, 'k', c.run);
  c.runs[0].start();
  c.runs[0].read('34f593e');
  const offline = await gate2.redeploy(REEL, 'k', c.run, { remoteRevision: async () => { throw new Error('Could not resolve host'); } });
  assert.strictEqual(offline.joined, null);
  const noLookup = await gate2.redeploy(REEL, 'k2', c.run);
  c.runs[c.runs.length - 1].start();
  c.runs[c.runs.length - 1].read('34f593e');
  assert.strictEqual((await gate2.redeploy(REEL, 'k2', c.run)).joined, null, 'no way to ask the source');
  assert.strictEqual(noLookup.joined, null);
});

test('an agent with no repository joins a running identical redeploy', async () => {
  const gate = createRedeployGate({ log: quiet });
  const { runs, run } = controlled();
  await gate.redeploy('hermes-a-1', 'k', run);
  runs[0].start();
  const second = await gate.redeploy('hermes-a-1', 'k', run, { sourceless: true });
  assert.strictEqual(second.joined, 'running');
  assert.strictEqual(runs.length, 1);
});

test('a different request, or another agent, is a different redeploy', async () => {
  const gate = createRedeployGate({ log: quiet });
  const { runs, run } = controlled();
  await gate.redeploy(REEL, 'k', run);
  assert.strictEqual((await gate.redeploy(REEL, 'k-edited-config', run)).joined, null);
  assert.strictEqual((await gate.redeploy('git-app-lobby-1', 'k', run)).joined, null);
  assert.strictEqual(runs.length, 3);
});

test('a finished redeploy, failed or not, is forgotten, and a join shares its failure', async () => {
  const gate = createRedeployGate({ log: quiet });
  const { runs, run } = controlled();
  const a = await gate.redeploy(REEL, 'k', run);
  const b = await gate.redeploy(REEL, 'k', run);
  runs[0].fail(new Error('Build failed, the agent was left running: boom'));
  await assert.rejects(a.promise, /boom/);
  await assert.rejects(b.promise, /boom/);
  assert.deepStrictEqual(gate.entries(REEL), []);

  const c = await gate.redeploy(REEL, 'k', run);
  assert.strictEqual(c.joined, null, 'the next request builds again');
  runs[1].finish();
  await c.promise;
  assert.deepStrictEqual(gate.entries(REEL), []);
});

test('a run that throws synchronously is a rejected redeploy, not a stuck entry', async () => {
  const gate = createRedeployGate({ log: quiet });
  const r = await gate.redeploy(REEL, 'k', () => { throw new Error('nope'); });
  await assert.rejects(r.promise, /nope/);
  assert.deepStrictEqual(gate.entries(REEL), []);
});

test('commits compare by abbreviation', () => {
  assert.ok(sameRevision('34f593e', '34F593E1c0ffee'));
  assert.ok(!sameRevision('34f593e', '34f593f'));
  assert.ok(!sameRevision(null, '34f593e'));
  assert.ok(!sameRevision('34f', '34f593e'), 'too short to be sure');
});

test('ls-remote: the branch, else the peeled tag, else a full ref name', () => {
  const out = [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/remotes/fork/main',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/heads/main',
    'cccccccccccccccccccccccccccccccccccccccc\trefs/tags/v1',
    'dddddddddddddddddddddddddddddddddddddddd\trefs/tags/v1^{}',
    ''
  ].join('\n');
  assert.strictEqual(pickRemoteRevision(out, 'main'), 'b'.repeat(40));
  assert.strictEqual(pickRemoteRevision(out, 'v1'), 'd'.repeat(40));
  assert.strictEqual(pickRemoteRevision(out, 'refs/tags/v1'), 'c'.repeat(40));
  assert.strictEqual(pickRemoteRevision(out, 'missing'), null);
});

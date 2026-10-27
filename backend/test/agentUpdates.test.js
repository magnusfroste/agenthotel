// Update markers on the Fleet (lib/agentUpdates.js): which agents could be
// updated, and how — without ever showing a marker that is not true.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const updates = require('../lib/agentUpdates');

beforeEach(() => updates.invalidate());

test('a Git App is behind only when both commits are known and differ', () => {
  assert.deepStrictEqual(updates.gitStatus('8cdfd63aaaa', '8cdfd63bbbb'), { kind: 'git', current: '8cdfd63', latest: '8cdfd63', updateAvailable: false, action: 'redeploy' });
  assert.strictEqual(updates.gitStatus('8cdfd63', 'a1b2c3d4').updateAvailable, true);
  assert.strictEqual(updates.gitStatus('8CDFD63', '8cdfd63').updateAvailable, false, 'case does not matter');
  assert.strictEqual(updates.gitStatus(null, 'a1b2c3d'), null, 'never deployed through the log: no marker');
  assert.strictEqual(updates.gitStatus('8cdfd63', null), null, 'ls-remote failed: no marker');
});

test('a template runtime: a newer panel build means redeploy, a newer upstream means rebuild', () => {
  assert.deepStrictEqual(updates.runtimeStatus({ version: 'Hermes Agent v0.21.5' }), { kind: 'runtime', current: 'Hermes Agent v0.21.5', updateAvailable: false });
  assert.strictEqual(updates.runtimeStatus({ behindPanel: true, upstreamNewer: true }).action, 'redeploy', 'the cheaper step first');
  assert.strictEqual(updates.runtimeStatus({ upstreamNewer: true }).action, 'rebuild');
});

function fixture() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE agents (id TEXT, name TEXT, runtime TEXT, config TEXT)');
  db.exec('CREATE TABLE deployments (id INTEGER PRIMARY KEY, agent_id TEXT, status TEXT, commit_sha TEXT)');
  const add = db.prepare('INSERT INTO agents VALUES (?,?,?,?)');
  add.run('git-reports', 'reports', 'git-app', JSON.stringify({ GIT_REPO: 'https://github.com/x/agentreports', GIT_REF: 'main' }));
  add.run('git-fresh', 'fresh', 'git-app', JSON.stringify({ GIT_REPO: 'https://github.com/x/other', GIT_REF: 'main' }));
  add.run('hermes-a', 'hermes-agent', 'hermes', '{}');
  add.run('app-x', 'nginx', 'docker-app', '{}');
  const dep = db.prepare('INSERT INTO deployments (agent_id, status, commit_sha) VALUES (?,?,?)');
  dep.run('git-reports', 'succeeded', '1111111aaa');
  dep.run('git-reports', 'failed', '9999999');            // a failed build is not what runs
  dep.run('git-reports', 'succeeded', '8cdfd63bbb');       // the latest that worked
  const calls = { lsRemote: 0 };
  const runtimes = {
    'git-app': { prepareBuild() {}, remoteRevision: async () => { calls.lsRemote++; return 'a1b2c3d4e5'; } },
    hermes: { name: 'Hermes' },
    'docker-app': { name: 'Docker App' }
  };
  const docker = {
    getContainer: () => ({ inspect: async () => ({ Image: 'sha256:running' }) }),
    getImage: () => ({ inspect: async () => ({ Id: 'sha256:newer-panel-build' }) })
  };
  const runtimeImage = {
    baseImageFor: (rt) => (rt === 'hermes' ? 'nousresearch/hermes-agent:latest' : null),
    upstreamStatus: async () => ({ newer: false }),
    versionCache: new Map([['sha256:running', 'Hermes Agent v0.21.5']])
  };
  return { deps: { db, docker, runtimes, runtimeImage, containerNameFor: (_, a) => `agenthotel-${a.id}` }, calls };
}

test('collect reports Git Apps and template runtimes, and leaves the rest alone', async () => {
  const { deps } = fixture();
  const out = await updates.collect(deps, { now: 1000 });
  assert.deepStrictEqual(Object.keys(out.agents).sort(), ['git-reports', 'hermes-a']);
  assert.deepStrictEqual(out.agents['git-reports'], { kind: 'git', current: '8cdfd63', latest: 'a1b2c3d', updateAvailable: true, action: 'redeploy', ref: 'main' });
  assert.strictEqual(out.agents['hermes-a'].action, 'redeploy', 'the panel holds a newer hermes build than the agent runs');
  assert.strictEqual(out.agents['hermes-a'].current, 'Hermes Agent v0.21.5');
});

test('the answer is cached for a quarter of an hour, and a deploy clears it', async () => {
  const { deps, calls } = fixture();
  await updates.collect(deps, { now: 1000 });
  await updates.collect(deps, { now: 1000 + updates.TTL_MS - 1 });
  assert.strictEqual(calls.lsRemote, 1);
  updates.invalidate();
  await updates.collect(deps, { now: 2000 });
  assert.strictEqual(calls.lsRemote, 2);
  await updates.collect(deps, { now: 2000, refresh: true });
  assert.strictEqual(calls.lsRemote, 3);
});

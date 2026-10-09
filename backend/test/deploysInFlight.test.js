// Deploys an upgrade would cut off, and what a restart left behind.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  deploysInFlight, upgradeConflict, recoverInterrupted, sweptHealth, INTERRUPTED_HEALTH
} = require('../lib/deploysInFlight');

const CLAW = 'openclaw-bot-1791560000000';

test('only rows mid-deploy count, with their build step', () => {
  const rows = [
    { id: CLAW, name: 'bot', status: 'creating' },
    { id: 'hermes-a-1791560000001', name: 'a', status: 'redeploying' },
    { id: 'hermes-b-1791560000002', name: 'b', status: 'running' },
    { id: 'hermes-c-1791560000003', name: 'c', status: 'failed' }
  ];
  const progress = new Map([[CLAW, { step: 7, total: 18, done: false }]]);
  const list = deploysInFlight(rows, progress);
  assert.deepStrictEqual(list.map(d => d.name), ['bot', 'a']);
  assert.deepStrictEqual(list[0], { id: CLAW, name: 'bot', status: 'creating', building: true, step: 7, total: 18 });
  assert.strictEqual(list[1].building, false);
});

test('a finished build is not in flight; an unattached running one is', () => {
  const progress = new Map([
    ['x-done-1791560000000', { step: 18, total: 18, done: true }],
    ['x-live-1791560000000', { step: 2, total: 9, done: false }]
  ]);
  const list = deploysInFlight([], progress);
  assert.deepStrictEqual(list.map(d => d.id), ['x-live-1791560000000']);
});

test('nothing running, nothing to refuse over', () => {
  assert.deepStrictEqual(deploysInFlight([{ id: 'a', status: 'running' }]), []);
});

test('the 409 names each agent and the way out', () => {
  const body = upgradeConflict([
    { id: CLAW, name: 'bot', status: 'creating', building: true, step: 7, total: 18 },
    { id: 'h', name: 'helper', status: 'redeploying', building: false, step: null, total: null }
  ]);
  assert.match(body.error, /^2 deploys are running: bot \(building, step 7\/18\), helper \(redeploying\)\./);
  assert.match(body.error, /force: true/);
  assert.strictEqual(body.deploys.length, 2);
  assert.match(upgradeConflict([{ name: 'bot', status: 'creating', building: false }]).error, /^A deploy is running: bot \(deploying\)/);
});

test('a create cut off with no container is failed, with the reason', async () => {
  const decisions = await recoverInterrupted(
    [{ id: CLAW, name: 'bot', status: 'creating' }],
    async () => { throw Object.assign(new Error('no such container'), { statusCode: 404 }); }
  );
  assert.deepStrictEqual(decisions, [{
    id: CLAW, name: 'bot', from: 'creating', status: 'failed', health: INTERRUPTED_HEALTH,
    message: 'Deploy of bot was interrupted by a panel restart — redeploy to finish'
  }]);
});

test('a redeploy cut off during its build left the old container serving', async () => {
  const [d] = await recoverInterrupted(
    [{ id: CLAW, name: 'bot', status: 'redeploying' }],
    async () => ({ Running: true })
  );
  assert.strictEqual(d.status, 'running');
  assert.strictEqual(d.health, null);
  assert.match(d.message, /^Redeploy of bot was interrupted by a panel restart — redeploy to finish; the previous container is still running$/);
});

test('a stopped container left by the restart is still failed', async () => {
  const [d] = await recoverInterrupted([{ id: CLAW, name: 'bot', status: 'redeploying' }], async () => ({ Running: false }));
  assert.strictEqual(d.status, 'failed');
});

test('rows not mid-deploy are left alone', async () => {
  let asked = 0;
  const decisions = await recoverInterrupted(
    [{ id: 'a', status: 'running' }, { id: 'b', status: 'stopped' }, { id: 'c', status: 'failed' }],
    async () => { asked++; return { Running: true }; }
  );
  assert.deepStrictEqual(decisions, []);
  assert.strictEqual(asked, 0);
});

test('the sweep keeps the interrupted reason while the container is missing', () => {
  const missing = { state: 'missing', reason: 'container not found' };
  assert.strictEqual(sweptHealth(INTERRUPTED_HEALTH, missing), INTERRUPTED_HEALTH);
  assert.strictEqual(sweptHealth('missing: container not found', missing), 'missing: container not found');
  assert.strictEqual(sweptHealth(null, missing), 'missing: container not found');
  // Once a container exists, the sweep reports it as usual.
  assert.strictEqual(sweptHealth(INTERRUPTED_HEALTH, { state: 'running', reason: 'ok' }), 'running: ok');
});

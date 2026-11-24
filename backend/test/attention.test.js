// Which guests the sidebar lists, and in what order (lib/attention.js), and
// the dashboard's per-day numbers (lib/fleetOverview.js).
const { test } = require('node:test');
const assert = require('node:assert');
const { assess, compare, lastEvents } = require('../lib/attention');
const { byDay, uptimeByAgent } = require('../lib/fleetOverview');

const running = { name: 'alpha', status: 'running', health: 'healthy: HTTP 200' };

test('a healthy guest needs nothing', () => {
  assert.strictEqual(assess(running), null);
  assert.strictEqual(assess(running, { modelErrors: { count: 0 } }), null);
});

test('a guest stopped on purpose is quiet; one that stopped by itself is not', () => {
  const stopped = { name: 'game', status: 'stopped', health: 'stopped: container exited' };
  // The fourteen skolappar stopped for their move to Shipholm (2026-11-21).
  assert.strictEqual(assess(stopped, { lastLifecycle: 'agent.stop' }), null);
  assert.strictEqual(assess(stopped, { lastLifecycle: 'agent.transfer' }), null);
  // Nothing in the log at all: stopped longer ago than the log keeps.
  assert.strictEqual(assess(stopped, {}), null);
  const crashed = assess(stopped, { lastLifecycle: 'agent.redeploy' });
  assert.strictEqual(crashed.level, 'critical');
  assert.match(crashed.text, /^Stopped by itself \(container exited\)$/);
});

test('each fault says what is wrong in words', () => {
  assert.deepStrictEqual(
    assess({ status: 'unhealthy', health: 'restarting: restarted 3 times' }).text, 'Keeps restarting (restarted 3 times)');
  assert.strictEqual(
    assess({ status: 'unhealthy', health: 'unhealthy: HTTP 502' }).text, 'Not healthy (HTTP 502)');
  assert.strictEqual(
    assess({ status: 'failed', health: 'missing: build failed: npm ci exited 1' }).text, 'Build failed: npm ci exited 1');
  assert.strictEqual(
    assess({ status: 'failed', health: 'missing: container not found' }).text, 'No container (container not found)');
  assert.match(assess({ status: 'running', health: 'interrupted: the panel restarted mid-deploy' }).text, /redeploy/);
});

test('a guest that runs but cannot answer is a warning, below a fault', () => {
  const down = assess(running, { uptimeDown: true });
  assert.deepStrictEqual([down.level, down.text], ['warning', 'Not answering at its domain']);
  const me = assess(running, { modelErrors: { count: 3, last: { at: 1000, advice: 'the key was refused' } } });
  assert.deepStrictEqual([me.level, me.text, me.since], ['warning', '3 replies failed at the model: the key was refused', 1000]);
});

test('a deploy in progress is shown as busy, never as a fault', () => {
  assert.deepStrictEqual(assess({ status: 'redeploying', health: 'building: step 4/10' }),
    { level: 'busy', text: 'Building, step 4/10', since: null });
  assert.strictEqual(assess({ status: 'creating', health: null }).text, 'Deploying');
  assert.strictEqual(assess({ status: 'running', health: 'queued: behind 2 builds' }).level, 'busy');
});

test('worst first, newest problem first within a level, then by name', () => {
  const rows = [
    { name: 'busy', attention: { level: 'busy' } },
    { name: 'warn', attention: { level: 'warning', since: 5 } },
    { name: 'old', attention: { level: 'critical', since: 1 } },
    { name: 'new', attention: { level: 'critical', since: 9 } },
    { name: 'b', attention: { level: 'critical', since: 1 } },
  ];
  assert.deepStrictEqual(rows.sort(compare).map(r => r.name), ['new', 'b', 'old', 'warn', 'busy']);
});

test('the last lifecycle event decides, and the last problem gives the time', () => {
  const ev = lastEvents([
    { agent_id: 'a', type: 'agent.start', ts: '2026-11-20 10:00:00' },
    { agent_id: 'a', type: 'agent.stop', ts: '2026-11-21 00:05:00' },
    { agent_id: 'b', type: 'agent.stop', ts: '2026-11-20 10:00:00' },
    { agent_id: 'b', type: 'agent.redeploy', ts: '2026-11-22 08:00:00' },
    { agent_id: 'b', type: 'agent.unhealthy', ts: '2026-11-23 09:00:00' },
  ]);
  assert.deepStrictEqual(ev.lifecycle, { a: 'agent.stop', b: 'agent.redeploy' });
  assert.strictEqual(ev.problem.b, Date.parse('2026-11-23T09:00:00Z'));
});

test('every day of the week is there, a quiet one as zeros', () => {
  const now = Date.parse('2026-11-24T12:00:00Z');
  const days = byDay([
    { day: '2026-11-24', type: 'agent.redeploy', n: 4 },
    { day: '2026-11-24', type: 'agent.create', n: 1 },
    { day: '2026-11-22', type: 'agent.down', n: 2 },
    { day: '2026-11-22', type: 'agent.model_error', n: 1 },
    { day: '2026-11-01', type: 'agent.redeploy', n: 99 },
  ], now);
  assert.strictEqual(days.length, 7);
  assert.strictEqual(days[0].day, '2026-11-18');
  assert.deepStrictEqual(days[6], { day: '2026-11-24', deploys: 5, incidents: 0, modelErrors: 0 });
  assert.deepStrictEqual(days[4], { day: '2026-11-22', deploys: 0, incidents: 2, modelErrors: 1 });
  assert.deepStrictEqual(days[5], { day: '2026-11-23', deploys: 0, incidents: 0, modelErrors: 0 });
});

test('uptime is a percentage with one decimal, and a guest never probed is left out', () => {
  assert.deepStrictEqual(uptimeByAgent([
    { agent_id: 'a', total: 1440, ok: 1437 },
    { agent_id: 'b', total: 0, ok: 0 },
  ]), { a: 99.8 });
});

// When an uptime probe becomes an alert (lib/uptimeAlerts.js): not on one
// failed probe, and one message when the host takes several guests down.
const { test } = require('node:test');
const assert = require('node:assert');
const { observe, notifications, eventMessage } = require('../lib/uptimeAlerts');

function run(probes, start) {
  let state = start, events = [];
  for (const up of probes) { const r = observe(state, up); state = r.state; events.push(r.event); }
  return { state, events };
}

test('one failed probe, or two, is not an outage', () => {
  const { events } = run([true, false, true, false, false, true]);
  assert.deepStrictEqual(events.filter(Boolean), []);
});

test('three failed probes in a row are, and the first good one ends it', () => {
  const { events } = run([true, false, false, false, false, true]);
  assert.deepStrictEqual(events, [null, null, null, 'down', null, 'up']);
});

test('a guest down from the start is still reported, after three probes', () => {
  const { events } = run([false, false, false, false]);
  assert.deepStrictEqual(events, [null, null, 'never-up', null]);
  assert.match(eventMessage({ name: 'x', event: 'never-up', statusCode: 502 }), /down \(502\) and has not answered/);
});

test('one guest at a time is named; several at once are one message', () => {
  const one = notifications([{ name: 'take', event: 'down', statusCode: 502 }]);
  assert.deepStrictEqual(one, ['Agent take is down (502)']);
  const host = notifications([
    { name: 'take', event: 'down' }, { name: 'reports', event: 'down' }, { name: 'hermes', event: 'never-up' },
  ]);
  assert.strictEqual(host.length, 1);
  assert.match(host[0], /^3 guests went down at once.*take, reports, hermes$/);
  const back = notifications([{ name: 'a', event: 'up' }, { name: 'b', event: 'up' }, { name: 'c', event: 'up' }]);
  assert.deepStrictEqual(back, ['3 guests are back up: a, b, c']);
});

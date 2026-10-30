// What the health check makes of a container's state (lib/agentHealth.js).
const { test } = require('node:test');
const assert = require('node:assert');
const { evaluateHealth } = require('../lib/agentHealth');

const agent = { id: 'hermes-x-1', name: 'x', runtime: 'hermes', port: 9119, config: '{}' };
const plugin = { healthCheck: { type: 'http', path: '/' } };

function dockerWith(state) {
  return {
    getContainer: () => ({
      inspect: async () => ({
        Id: 'abc',
        RestartCount: 0,
        State: { Running: true, Paused: false, Status: 'running', ...state },
        NetworkSettings: { Networks: { hotel: { IPAddress: '172.18.0.9' } } }
      })
    })
  };
}

test('a guest paused by a backup is paused, and no probe is sent', async () => {
  let probed = false;
  const fetch = async () => { probed = true; throw new Error('network timeout'); };
  const r = await evaluateHealth(dockerWith({ Paused: true, Status: 'paused' }), fetch, agent, plugin);
  assert.strictEqual(r.state, 'paused');
  assert.strictEqual(r.healthy, false);
  assert.strictEqual(probed, false);
});

test('a running guest that does not answer is still unhealthy', async () => {
  const fetch = async () => { throw new Error('network timeout'); };
  const r = await evaluateHealth(dockerWith({}), fetch, agent, plugin);
  assert.strictEqual(r.healthy, false);
  assert.match(r.reason, /unreachable: network timeout/);
});

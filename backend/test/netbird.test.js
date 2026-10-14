// NetBird as the hotel's front door and private network (lib/netbird.js), and
// how the throttle reads a visitor's address through NetBird's proxy.
const { test } = require('node:test');
const assert = require('node:assert');
const netbird = require('../lib/netbird');
const rateLimit = require('../lib/rateLimit');

test('a management URL is normalised; empty means NetBird Cloud', () => {
  assert.strictEqual(netbird.normalizeManagementUrl(''), netbird.CLOUD_MANAGEMENT_URL);
  assert.strictEqual(netbird.normalizeManagementUrl('netbird.example.com'), 'https://netbird.example.com:443');
  assert.strictEqual(netbird.normalizeManagementUrl('https://netbird.example.com/'), 'https://netbird.example.com:443');
  assert.strictEqual(netbird.normalizeManagementUrl('https://nb.example.com:33073'), 'https://nb.example.com:33073');
  assert.throws(() => netbird.normalizeManagementUrl('ftp://x.example.com'), /http or https/);
});

test('a peer name is one NetBird accepts', () => {
  assert.strictEqual(netbird.peerName('Panel.Froste.eu'), 'panel-froste-eu');
  assert.strictEqual(netbird.peerName(''), 'agenthotel');
  assert.strictEqual(netbird.peerName('--x--'), 'x');
});

test('the card says why the client is not connected', () => {
  const log = [
    '2026-10-14T12:02:34.692Z INFO client/cmd/service_controller.go:61: starting NetBird service',
    '2026-10-14T12:02:34.783Z WARN client/server/server.go:469: failed login: rpc error: code = PermissionDenied desc = couldn\'t add peer: setup key is invalid'
  ].join('\n');
  assert.strictEqual(netbird.lastError(log), "couldn't add peer: setup key is invalid");
  assert.strictEqual(netbird.lastError('all quiet'), null);
});

test('the client runs on the host network with its identity in a volume', async () => {
  const created = [];
  let removed = 0;
  const docker = {
    modem: { followProgress: (s, done) => done(null) },
    pull: async () => ({}),
    getImage: () => ({ inspect: async () => ({}) }),
    getVolume: () => ({ remove: async () => { removed++; } }),
    getContainer: () => ({ stop: async () => {}, remove: async () => {} }),
    createContainer: async (spec) => { created.push(spec); return { start: async () => {} }; }
  };
  await netbird.start(docker, { setupKey: 'ABCDEFGH-1234-5678-9ABC-DEF012345678', hostname: 'Panel' });
  const spec = created[0];
  assert.strictEqual(spec.HostConfig.NetworkMode, 'host');
  assert.ok(spec.HostConfig.CapAdd.includes('NET_ADMIN'));
  assert.deepStrictEqual(spec.HostConfig.Binds, ['agenthotel-netbird:/var/lib/netbird']);
  assert.ok(spec.Env.includes('NB_HOSTNAME=panel'));
  assert.ok(!spec.Env.some(e => e.startsWith('NB_MANAGEMENT_URL=')), 'Cloud needs no management URL');
  assert.strictEqual(removed, 0, 'the same key keeps the same peer');

  await netbird.start(docker, { setupKey: 'ABCDEFGH-1234-5678-9ABC-DEF012345678', managementUrl: 'nb.example.com', fresh: true });
  assert.ok(created[1].Env.includes('NB_MANAGEMENT_URL=https://nb.example.com:443'));
  assert.strictEqual(removed, 1, 'another account starts from a clean identity');
  await assert.rejects(netbird.start(docker, { setupKey: 'short' }), /setup key is required/);
});

test("through NetBird's proxy the visitor is the hop before it — only while NetBird is on", () => {
  rateLimit.setProxies({ caddy: ['172.18.0.5'] });
  const req = { socket: { remoteAddress: '172.18.0.5' }, headers: { 'x-forwarded-for': '203.0.113.9, 100.92.14.3' } };
  rateLimit.setMeshTrusted(false);
  assert.strictEqual(rateLimit.clientIp(req), '100.92.14.3');
  rateLimit.setMeshTrusted(true);
  assert.strictEqual(rateLimit.clientIp(req), '203.0.113.9');
  // A hop outside the mesh range is still the address Caddy saw.
  const direct = { socket: { remoteAddress: '172.18.0.5' }, headers: { 'x-forwarded-for': '100.200.1.1, 198.51.100.4' } };
  assert.strictEqual(rateLimit.clientIp(direct), '198.51.100.4');
  rateLimit.setMeshTrusted(false);
  rateLimit.setProxies({});
});

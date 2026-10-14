// Publishing guests through NetBird's reverse proxy (lib/netbirdPublish.js).
// The plan is the part that can take live sites down, so most of this is
// about what it leaves alone.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const nb = require('../lib/netbirdPublish');

const FREE = { id: 'd1', domain: 'eu1.netbird.services', type: 'free', validated: true };
const CUSTOM = { id: 'd2', domain: 'froste.eu', type: 'custom', validated: true, target_cluster: 'eu1.netbird.services' };

function dbWith(state) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  if (state) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(nb.STATE_KEY, JSON.stringify(state));
  return db;
}

beforeEach(() => nb.resetCache());

test('a guest gets its own domain under a validated custom domain, else a free name', () => {
  assert.deepStrictEqual(nb.publicNameFor('reel.froste.eu', [FREE, CUSTOM]), { publicName: 'reel.froste.eu', custom: 'froste.eu' });
  assert.deepStrictEqual(nb.publicNameFor('reel.froste.eu', [FREE]), { publicName: 'reel-froste-eu.eu1.netbird.services' });
  // A custom domain NetBird has not validated yet is not used.
  assert.deepStrictEqual(nb.publicNameFor('reel.froste.eu', [FREE, { ...CUSTOM, validated: false }]).publicName, 'reel-froste-eu.eu1.netbird.services');
  // "notfroste.eu" is not under "froste.eu".
  assert.strictEqual(nb.publicNameFor('notfroste.eu', [FREE, CUSTOM]).publicName, 'notfroste-eu.eu1.netbird.services');
  assert.match(nb.publicNameFor('x.example.com', []).error, /no free domain/);
});

test('the API base drops a default port', () => {
  assert.strictEqual(nb.apiBase('https://api.netbird.io:443'), 'https://api.netbird.io');
  assert.strictEqual(nb.apiBase('https://nb.example.com:33073'), 'https://nb.example.com:33073');
});

test('the plan creates what is missing, keeps what matches, and passes the Host header', () => {
  const services = [{
    id: 's1', domain: 'a-froste-eu.eu1.netbird.services', enabled: true, pass_host_header: true,
    targets: [{ target_id: 'peer1', target_type: 'peer', protocol: 'http', port: 80 }]
  }];
  const p = nb.plan({
    guests: ['a.froste.eu', 'b.froste.eu', '*.sites.froste.eu'],
    domains: [FREE], services, peerId: 'peer1',
    state: { 'a.froste.eu': { serviceId: 's1' } }
  });
  assert.deepStrictEqual(p.keep.map(k => k.domain), ['a.froste.eu']);
  assert.strictEqual(p.create.length, 1, 'a wildcard is never published');
  const body = p.create[0].body;
  assert.strictEqual(body.domain, 'b-froste-eu.eu1.netbird.services');
  assert.strictEqual(body.pass_host_header, true);
  assert.deepStrictEqual(body.targets[0], { target_id: 'peer1', target_type: 'peer', protocol: 'http', port: 80, path: '/', enabled: true });
});

test('a service the panel did not create is never changed or removed', () => {
  const handMade = { id: 'h1', domain: 'agenthotel.eu1.netbird.services', enabled: true, pass_host_header: true, targets: [] };
  const clash = { id: 'h2', domain: 'c-froste-eu.eu1.netbird.services', enabled: true, targets: [] };
  const p = nb.plan({
    guests: ['c.froste.eu'], domains: [FREE], services: [handMade, clash], peerId: 'peer1', state: {}
  });
  assert.deepStrictEqual(p.create, []);
  assert.deepStrictEqual(p.update, []);
  assert.deepStrictEqual(p.remove, []);
  assert.match(p.errors[0].error, /did not create/);
});

test('a service of ours that drifted is updated; one for a gone guest is removed', () => {
  const drifted = { id: 's1', domain: 'a-froste-eu.eu1.netbird.services', enabled: true, pass_host_header: false,
    targets: [{ target_id: 'peer1', target_type: 'peer', protocol: 'http', port: 80 }] };
  const p = nb.plan({
    guests: ['a.froste.eu'], domains: [FREE], services: [drifted], peerId: 'peer1',
    state: { 'a.froste.eu': { serviceId: 's1' }, 'gone.froste.eu': { serviceId: 's9' } }
  });
  assert.deepStrictEqual(p.update.map(u => u.serviceId), ['s1']);
  assert.deepStrictEqual(p.remove, [{ domain: 'gone.froste.eu', serviceId: 's9', exists: false }]);
});

function fakeNetBird(services = []) {
  const calls = [];
  let next = 1;
  const fetchImpl = async (url, opts) => {
    const path = url.replace('https://api.netbird.io', '');
    calls.push(`${opts.method} ${path}`);
    assert.strictEqual(opts.headers.Authorization, 'Token tok');
    const reply = (status, body) => ({ ok: status < 300, status, statusText: '', text: async () => body === undefined ? '' : JSON.stringify(body) });
    if (opts.method === 'GET' && path.startsWith('/api/peers')) return reply(200, [{ id: 'peer1', ip: '100.88.247.194' }]);
    if (opts.method === 'GET' && path === '/api/reverse-proxies/domains') return reply(200, [FREE]);
    if (opts.method === 'GET' && path === '/api/reverse-proxies/services') return reply(200, services);
    if (opts.method === 'POST') { const b = JSON.parse(opts.body); const s = { id: `s${next++}`, ...b }; services.push(s); return reply(200, s); }
    if (opts.method === 'DELETE') { const id = path.split('/').pop(); const i = services.findIndex(s => s.id === id); if (i < 0) return reply(404, { message: 'not found' }); services.splice(i, 1); return reply(200); }
    return reply(500, { message: 'unexpected' });
  };
  return { fetchImpl, calls, services };
}

test('sync publishes, gives Caddy the free name, and unpublishes only its own', async () => {
  const db = dbWith();
  const handMade = { id: 'h1', domain: 'agenthotel.eu1.netbird.services', enabled: true, targets: [] };
  const api = fakeNetBird([handMade]);
  const quiet = { log() {} };
  const report = await nb.sync({ db, token: 'tok', managementUrl: 'https://api.netbird.io:443', peerIp: '100.88.247.194', guests: ['reel.froste.eu'], fetchImpl: api.fetchImpl, log: quiet });
  assert.deepStrictEqual(report.published.map(p => p.publicName), ['reel-froste-eu.eu1.netbird.services']);
  assert.deepStrictEqual(nb.extraHosts(db, 'reel.froste.eu'), ['reel-froste-eu.eu1.netbird.services']);

  // The guest goes: its service goes, Caddy forgets the name.
  await nb.sync({ db, token: 'tok', peerIp: '100.88.247.194', guests: [], fetchImpl: api.fetchImpl, log: quiet });
  assert.deepStrictEqual(nb.extraHosts(db, 'reel.froste.eu'), []);
  assert.deepStrictEqual(api.services.map(s => s.id), ['h1'], 'the hand-made service stays');

  // Switching off removes ours and nothing else.
  await nb.sync({ db, token: 'tok', peerIp: '100.88.247.194', guests: ['x.froste.eu'], fetchImpl: api.fetchImpl, log: quiet });
  const off = await nb.unpublishAll({ db, token: 'tok', fetchImpl: api.fetchImpl, log: quiet });
  assert.strictEqual(off.removed, 1);
  assert.deepStrictEqual(api.services.map(s => s.id), ['h1']);
  assert.deepStrictEqual(nb.extraHosts(db, 'x.froste.eu'), []);
});

test('a token NetBird refuses says so', async () => {
  const db = dbWith();
  const fetchImpl = async () => ({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => '{"message":"token invalid"}' });
  await assert.rejects(nb.sync({ db, token: 'bad', peerIp: '100.1.1.1', guests: [], fetchImpl }), /refused the API token \(401\)/);
});

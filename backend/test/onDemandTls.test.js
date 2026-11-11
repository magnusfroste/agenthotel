// Certificates for wildcard guests, one name at a time.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const t = require('../lib/onDemandTls');

const lobby = { id: 'git-app-lobby-1', wildcards: ['*.example.com'] };
const deeper = { id: 'git-app-shops-2', wildcards: ['*.shops.example.com'] };

test('a name belongs to a wildcard guest only one label below it', () => {
  assert.strictEqual(t.guestForHost('cafe.example.com', [lobby]), lobby);
  assert.strictEqual(t.guestForHost('CAFE.Example.com.', [lobby]), lobby, 'case and a trailing dot do not matter');
  assert.strictEqual(t.guestForHost('example.com', [lobby]), null, 'the apex is not under the wildcard');
  assert.strictEqual(t.guestForHost('a.cafe.example.com', [lobby]), null, 'two levels down is not covered');
  assert.strictEqual(t.guestForHost('cafe.example.org', [lobby]), null);
  assert.strictEqual(t.guestForHost('', [lobby]), null);
  assert.strictEqual(t.guestForHost('-bad.example.com', [lobby]), null, 'not a hostname label');
  assert.strictEqual(t.guestForHost('a_b.example.com', [lobby]), null);
  assert.strictEqual(t.guestForHost('cafe.example.com', [{ id: 'x', wildcards: ['shop.example.com'] }]), null, 'a plain alias is not a wildcard');
});

test('the most specific wildcard wins', () => {
  assert.strictEqual(t.guestForHost('nike.shops.example.com', [lobby, deeper]), deeper);
  assert.strictEqual(t.guestForHost('shops.example.com', [lobby, deeper]), lobby);
});

test('the policy is on-demand, for the wildcard, with an id to replace it by', () => {
  assert.deepStrictEqual(t.policyFor('*.example.com', 'ops@example.com'), {
    '@id': 'ondemand-*.example.com',
    subjects: ['*.example.com'],
    on_demand: true,
    issuers: [{ module: 'acme', ca: 'https://acme-v02.api.letsencrypt.org/directory', contact: ['mailto:ops@example.com'] }]
  });
  assert.deepStrictEqual(t.policyFor('*.example.com').issuers[0].contact, undefined, 'no email, no contact');
});

test('Caddy asks over its own loopback, which forwards only the ask path', () => {
  assert.deepStrictEqual(t.onDemandConfig(), { permission: { module: 'http', endpoint: 'http://127.0.0.1:2020/tls-ask' } });
  const server = t.askServer('unix//run/agenthotel/backend.sock');
  assert.deepStrictEqual(server.listen, ['127.0.0.1:2020'], 'loopback only: no guest can reach it');
  assert.deepStrictEqual(server.automatic_https, { disable: true });
  assert.deepStrictEqual(server.routes[0].match, [{ path: ['/tls-ask'] }]);
  assert.strictEqual(server.routes[0].handle[0].upstreams[0].dial, 'unix//run/agenthotel/backend.sock');
  assert.strictEqual(server.routes[1].handle[0].status_code, 404);
});

test('a certificate only for a name the guest actually serves', async () => {
  // A stand-in for Lobby: one site, 404 for the rest, and one that hangs.
  const seen = [];
  const guest = http.createServer((req, res) => {
    seen.push(req.headers.host);
    if (req.headers.host === 'slow.example.com') return; // never answers
    res.writeHead(req.headers.host === 'cafe.example.com' ? 200 : 404).end();
  });
  await new Promise(r => guest.listen(0, '127.0.0.1', r));
  const port = guest.address().port;
  try {
    assert.strictEqual(await t.guestServes('cafe.example.com', '127.0.0.1', port), true);
    assert.strictEqual(await t.guestServes('random-12345.example.com', '127.0.0.1', port), false, 'a site Lobby does not have');
    assert.strictEqual(await t.guestServes('slow.example.com', '127.0.0.1', port, { timeoutMs: 200 }), false, 'a guest that does not answer');
    assert.strictEqual(await t.guestServes('cafe.example.com', '127.0.0.1', 1), false, 'a guest that is not running');
    assert.deepStrictEqual(seen.slice(0, 2), ['cafe.example.com', 'random-12345.example.com'], 'the guest is asked with the name as Host');
  } finally {
    guest.closeAllConnections?.();
    guest.close();
  }
});

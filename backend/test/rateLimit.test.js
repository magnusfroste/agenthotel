// What stands between the internet and a panel that is root on its host.
const { test } = require('node:test');
const assert = require('node:assert');
const { clientIp, hit, reset, setProxies } = require('../lib/rateLimit');

const req = (headers = {}, peer = '203.0.113.9') => ({ headers, socket: { remoteAddress: peer } });

test('a window allows exactly its limit and then refuses', () => {
  const ip = 'test-' + Math.random();
  for (let i = 0; i < 5; i++) assert.ok(hit('b', ip, 5, 60000).allowed, `call ${i + 1} should pass`);
  const blocked = hit('b', ip, 5, 60000);
  assert.strictEqual(blocked.allowed, false);
  assert.ok(blocked.retryAfter > 0, 'a refusal must say when to come back');
});

test('a successful login clears the count', () => {
  const ip = 'test-' + Math.random();
  for (let i = 0; i < 5; i++) hit('login', ip, 5, 60000);
  reset('login', ip);
  assert.ok(hit('login', ip, 5, 60000).allowed);
});

test('an expired window starts over', async () => {
  const ip = 'test-' + Math.random();
  hit('short', ip, 1, 30);
  assert.strictEqual(hit('short', ip, 1, 30).allowed, false);
  await new Promise(r => setTimeout(r, 45));
  assert.ok(hit('short', ip, 1, 30).allowed, 'the window should have lapsed');
});

// The topology these tests stand in: Caddy at .2, the tunnel at .3, a guest
// at .9, all on the panel's network; the internet beyond.
const CADDY = '172.18.0.2';
const TUNNEL = '172.18.0.3';
const GUEST = '172.18.0.9';
setProxies({ caddy: [CADDY], tunnel: [TUNNEL] });

test('through the tunnel, cloudflare says who is asking and is believed', () => {
  // cloudflared → Caddy → backend: Caddy appends the tunnel's address.
  assert.strictEqual(clientIp(req({ 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': TUNNEL }, CADDY)), '198.51.100.7');
});

test('a cloudflare header sent straight to the server\'s IP is not believed', () => {
  // No tunnel in the path: Caddy saw the sender itself. Ports 80/443 answer
  // even on a tunnelled panel, so this is the bypass that mattered.
  assert.strictEqual(clientIp(req({ 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '203.0.113.50' }, CADDY)), '203.0.113.50');
});

test('only the last forwarded-for entry is Caddy\'s; the ones before it are the sender\'s', () => {
  // As observed from a real Caddy: a private sender's own header is kept and
  // the sender's address appended.
  assert.strictEqual(clientIp(req({ 'x-forwarded-for': '6.6.6.6, 172.23.0.1' }, CADDY)), '172.23.0.1');
  assert.strictEqual(clientIp(req({ 'x-forwarded-for': '6.6.6.6, ' + GUEST, 'cf-connecting-ip': '7.7.7.7' }, CADDY)), GUEST);
});

test('a guest going around Caddy gets its own address and nothing it wrote', () => {
  assert.strictEqual(clientIp(req({ 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '198.51.100.8' }, GUEST)), GUEST);
  assert.strictEqual(clientIp(req({ 'cf-connecting-ip': '198.51.100.7' }, '::ffff:' + GUEST)), GUEST);
});

test('a tunnel pointed straight at the backend is still believed', () => {
  assert.strictEqual(clientIp(req({ 'cf-connecting-ip': '198.51.100.7' }, TUNNEL)), '198.51.100.7');
});

test('a cloudflare header that is not an address is ignored', () => {
  assert.strictEqual(clientIp(req({ 'cf-connecting-ip': 'x; drop', 'x-forwarded-for': TUNNEL }, CADDY)), TUNNEL);
});

test('with nothing to go on, the socket address is the answer', () => {
  assert.strictEqual(clientIp(req({}, '203.0.113.9')), '203.0.113.9');
});

test('before Caddy has been looked up, a private peer counts as Caddy — never the forged header', () => {
  setProxies({ caddy: [], tunnel: [] });
  try {
    assert.strictEqual(clientIp(req({ 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '6.6.6.6, 203.0.113.50' }, '172.18.0.4')), '203.0.113.50');
  } finally {
    setProxies({ caddy: [CADDY], tunnel: [TUNNEL] });
  }
});

test('a request on the backend\'s Unix socket came through Caddy, and is read like one', () => {
  // No peer address on a socket. 'unknown' would put every visitor in one bucket.
  assert.strictEqual(clientIp({ headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.50' }, socket: {} }), '203.0.113.50');
  assert.strictEqual(clientIp({ headers: { 'x-forwarded-for': TUNNEL, 'cf-connecting-ip': '198.51.100.7' }, socket: {} }), '198.51.100.7');
  assert.strictEqual(clientIp({ headers: { 'cf-connecting-ip': '198.51.100.7' }, socket: {} }), 'unknown');
});

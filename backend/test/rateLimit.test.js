// What stands between the internet and a panel that is root on its host.
const { test } = require('node:test');
const assert = require('node:assert');
const { clientIp, hit, reset } = require('../lib/rateLimit');

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

test('cloudflare says who is asking, and is believed', () => {
  assert.strictEqual(clientIp(req({ 'cf-connecting-ip': '198.51.100.7' })), '198.51.100.7');
});

test('a forwarded-for header is believed only from a local proxy', () => {
  // Trusting it from anywhere would let anyone pick their own bucket.
  assert.strictEqual(clientIp(req({ 'x-forwarded-for': '198.51.100.7' }, '172.18.0.2')), '198.51.100.7');
  assert.strictEqual(clientIp(req({ 'x-forwarded-for': '198.51.100.7' }, '203.0.113.9')), '203.0.113.9');
});

test('with nothing to go on, the socket address is the answer', () => {
  assert.strictEqual(clientIp(req({}, '203.0.113.9')), '203.0.113.9');
});

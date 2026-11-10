const { test } = require('node:test');
const assert = require('node:assert');
const { buildGuestRoute } = require('../lib/guestRoute');

const LAYOUT = { rootPort: 9120, mounts: [{ prefix: '/admin', port: 9119, assetsFromReferer: true }] };

test('a guest with no layout is one proxy to one port, as before', () => {
  const route = buildGuestRoute('a.example.com', 'agenthotel-a', 8000);
  assert.strictEqual(route['@id'], 'agent-a.example.com');
  assert.deepStrictEqual(route.match, [{ host: ['a.example.com'] }]);
  assert.strictEqual(route.handle.length, 1);
  assert.strictEqual(route.handle[0].handler, 'reverse_proxy');
  assert.deepStrictEqual(route.handle[0].upstreams, [{ dial: 'agenthotel-a:8000' }]);
  assert.deepStrictEqual(route.handle[0].headers.request.set, { 'X-Real-Ip': ['{http.vars.client_ip}'] });
});

test('a layout stays one route with one id, so removing a guest stays one call', () => {
  const route = buildGuestRoute('a.example.com', 'c', 9119, LAYOUT);
  assert.strictEqual(route['@id'], 'agent-a.example.com');
  assert.strictEqual(route.handle.length, 1);
  assert.strictEqual(route.handle[0].handler, 'subroute');
});

test('the mounted interface loses its prefix and is told what it was', () => {
  const [admin] = buildGuestRoute('a.example.com', 'c', 9119, LAYOUT).handle[0].routes;
  assert.deepStrictEqual(admin.match, [{ path: ['/admin', '/admin/*'] }]);
  assert.strictEqual(admin.terminal, true);
  assert.deepStrictEqual(admin.handle[0], { handler: 'rewrite', strip_path_prefix: '/admin' });
  assert.deepStrictEqual(admin.handle[1].upstreams, [{ dial: 'c:9119' }]);
  assert.deepStrictEqual(admin.handle[1].headers.request.set['X-Forwarded-Prefix'], ['/admin']);
});

test('assets asked for by a page under the prefix go to the mounted interface', () => {
  const [, assets] = buildGuestRoute('a.example.com', 'c', 9119, LAYOUT).handle[0].routes;
  assert.deepStrictEqual(assets.match[0].path, ['/assets/*']);
  assert.deepStrictEqual(assets.handle[0].upstreams, [{ dial: 'c:9119' }]);
  const re = new RegExp(assets.match[0].header_regexp.Referer.pattern);
  assert.ok(re.test('https://a.example.com/admin'));
  assert.ok(re.test('https://a.example.com/admin/chat'));
  assert.ok(!re.test('https://a.example.com/'), 'the root interface keeps its own assets');
  assert.ok(!re.test('https://a.example.com/administrator'), 'only that path, not a longer one');
});

test('everything else goes to the root port, last, and every proxy names the visitor', () => {
  const routes = buildGuestRoute('a.example.com', 'c', 9119, LAYOUT).handle[0].routes;
  const root = routes[routes.length - 1];
  assert.strictEqual(root.match, undefined);
  assert.deepStrictEqual(root.handle[0].upstreams, [{ dial: 'c:9120' }]);
  for (const r of routes) {
    const p = r.handle.find(h => h.handler === 'reverse_proxy');
    assert.deepStrictEqual(p.headers.request.set['X-Real-Ip'], ['{http.vars.client_ip}']);
  }
});

test('exact paths go to their interface as they are, before the mounts', () => {
  const layout = { rootPort: 9119, paths: [{ paths: ['/.well-known/agent-card.json'], port: 9900 }],
    mounts: [{ prefix: '/a2a', port: 9900 }] };
  const [card, a2a, root] = buildGuestRoute('a.example.com', 'c', 9119, layout).handle[0].routes;
  assert.deepStrictEqual(card.match, [{ path: ['/.well-known/agent-card.json'] }]);
  assert.strictEqual(card.terminal, true);
  assert.strictEqual(card.handle.length, 1, 'no rewrite: the path reaches the interface unchanged');
  assert.deepStrictEqual(card.handle[0].upstreams, [{ dial: 'c:9900' }]);
  assert.deepStrictEqual(a2a.handle[0], { handler: 'rewrite', strip_path_prefix: '/a2a' });
  assert.deepStrictEqual(root.handle[0].upstreams, [{ dial: 'c:9119' }]);
});

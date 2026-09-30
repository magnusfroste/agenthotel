// The half of route reconciliation that deletes. A mistake here removes live
// sites once a minute, so each way it could go wrong is pinned down.
const { test } = require('node:test');
const assert = require('node:assert');
const { unownedRoutes } = require('../lib/routeOwnership');

const route = (id, ...hosts) => ({ '@id': id, match: [{ host: hosts }] });

test('a route for a deleted agent is found', () => {
  const r = unownedRoutes([route('agent-gone.example.com', 'gone.example.com')], ['kept.example.com']);
  assert.deepStrictEqual(r.map(x => x.id), ['agent-gone.example.com']);
});

test('a route an agent owns is never touched', () => {
  const routes = [route('agent-lobby.pezcms.com', 'lobby.pezcms.com'), route('agent-*.pezcms.com', '*.pezcms.com')];
  assert.deepStrictEqual(unownedRoutes(routes, ['lobby.pezcms.com', '*.pezcms.com']), []);
});

test("the panel's own route is never removed, owned or not", () => {
  assert.deepStrictEqual(unownedRoutes([route('panel-route', 'panel.example.com')], []), []);
});

test('routes added to Caddy by hand are not ours', () => {
  assert.deepStrictEqual(unownedRoutes([route('something-else', 'x.example.com'), { match: [{ host: ['y'] }] }], []), []);
});

test('a route with no host is left alone rather than guessed at', () => {
  assert.deepStrictEqual(unownedRoutes([{ '@id': 'agent-weird', match: [] }], []), []);
});

test('hostnames compare without regard to case', () => {
  assert.deepStrictEqual(unownedRoutes([route('agent-Lobby.PezCMS.com', 'Lobby.PezCMS.com')], ['lobby.pezcms.com']), []);
});

test('a route shared by several hosts stays while any of them is owned', () => {
  assert.deepStrictEqual(unownedRoutes([route('agent-a', 'a.example.com', 'b.example.com')], ['b.example.com']), []);
});

test('an empty owner list removes only agent routes', () => {
  // The worst case: every agent deleted. Still never the panel's route.
  const routes = [route('panel-route', 'panel.example.com'), route('agent-x', 'x.example.com')];
  assert.deepStrictEqual(unownedRoutes(routes, []).map(x => x.id), ['agent-x']);
});

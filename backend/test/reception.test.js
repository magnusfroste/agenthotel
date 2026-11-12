// The reception, end to end over real HTTP: a guest's MCP client on one side,
// a place that is an MCP server on the other, and the reception in between
// holding the place's token.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fetch = require('node-fetch');
const {
  createReception, createUseLog, listPlaces, guestForKey, parseReply, firstLine, TOOLS
} = require('../lib/reception');

const PLACE_TOKEN = 'place-token-never-shown-to-a-guest';
const ROOM_KEY = 'room-key-of-magnus';

// A place: an MCP server behind a bearer token, with a session it hands out at
// initialize and then insists on. `sse` answers as an event stream instead.
function fakePlace({ sse = false } = {}) {
  const seen = [];
  let sessions = 0;
  let live = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const message = JSON.parse(body);
      seen.push({ method: message.method, headers: req.headers, params: message.params });
      if (req.headers.authorization !== `Bearer ${PLACE_TOKEN}`) { res.writeHead(401); return res.end('{"error":"bad token"}'); }
      const reply = (result, extra = {}) => {
        const payload = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
        if (sse) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', ...extra });
          return res.end(`event: message\ndata: ${payload}\n\n`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json', ...extra });
        res.end(payload);
      };
      if (message.method === 'initialize') {
        live = `session-${++sessions}`;
        return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'lobby' }, instructions: 'A site is one markdown file. Call describe_format first.' }, { 'Mcp-Session-Id': live });
      }
      if (message.id === undefined) { res.writeHead(202); return res.end(); }
      if (req.headers['mcp-session-id'] !== live) { res.writeHead(404); return res.end('{"error":"unknown session"}'); }
      if (message.method === 'tools/list') {
        return reply({ tools: [
          { name: 'list_sites', description: 'Every site in the lobby. One line each.\nMore detail here.', inputSchema: { type: 'object', properties: {} } },
          { name: 'write_site', description: 'Store a site.', inputSchema: { type: 'object', properties: { host: { type: 'string' }, content: { type: 'string' } }, required: ['host', 'content'] } }
        ] });
      }
      if (message.method === 'tools/call') {
        const { name, arguments: args } = message.params;
        if (name === 'list_sites') return reply({ content: [{ type: 'text', text: 'a.example\nb.example' }] });
        if (name === 'write_site') {
          if (!args.host || !args.content) return reply({ content: [{ type: 'text', text: 'host and content are required' }], isError: true });
          return reply({ content: [{ type: 'text', text: `stored ${args.host} for ${req.headers['x-hotel-guest']}` }] });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `Unknown tool: ${name}` } }));
      }
      res.writeHead(400); res.end('{}');
    });
  });
  return { server, seen, forget: () => { live = 'gone'; } };
}

const listenOn = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

let place, placePort, receptionServer, url, open = true;
const used = [];
const agents = () => [
  { id: 'g1', name: 'magnus', runtime: 'hermes', status: 'running', created_at: '2026-01-01', config: '{}' },
  { id: 'p1', name: 'loby', runtime: 'git-app', template: 'lobby', status: 'running', port: placePort, domain: 'lobby.example.com',
    created_at: '2026-01-02', config: JSON.stringify({ LOBBY_API_TOKEN: PLACE_TOKEN, LOBBY_ADMIN_PASSWORD: 'admin-password' }) }
];
const templates = { lobby: { name: 'Lobby', description: 'A web hotel for landing pages.\n', place: { mcp: '/mcp', auth: 'bearer', tokenEnv: 'LOBBY_API_TOKEN' } } };

before(async () => {
  place = fakePlace();
  placePort = await listenOn(place.server);
  const reception = createReception({
    enabled: () => open,
    keys: () => [{ agent_id: 'g1', key: ROOM_KEY }, { agent_id: 'gone', key: 'key-of-a-guest-that-left' }],
    agents,
    templateOf: id => templates[id] || null,
    targetOf: agent => ({ container: '127.0.0.1', port: agent.port }),
    fetch,
    logUse: entry => used.push(entry),
    hotelName: () => 'hotel.example.com'
  });
  receptionServer = http.createServer(reception.handle);
  url = `http://127.0.0.1:${await listenOn(receptionServer)}/reception`;
});
after(() => { place.server.close(); receptionServer.close(); });

let nextId = 1;
const replies = [];
async function rpc(method, params, { key = ROOM_KEY, to = url, httpMethod = 'POST', id = nextId++ } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const message = id === null ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params };
  const res = await fetch(to, { method: httpMethod, headers, body: httpMethod === 'POST' ? JSON.stringify(message) : undefined });
  const text = await res.text();
  replies.push(text);
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}
async function tool(name, args) {
  const { body } = await rpc('tools/call', { name, arguments: args });
  const result = body.result;
  return { result, parts: result.content.map(c => { try { return JSON.parse(c.text); } catch (e) { return c.text; } }) };
}

test('without a room key there is no reception', async () => {
  assert.strictEqual((await rpc('tools/list', {}, { key: null })).status, 401);
  assert.strictEqual((await rpc('tools/list', {}, { key: 'a-guess' })).status, 401);
  // A key whose guest has left is no key.
  assert.strictEqual((await rpc('tools/list', {}, { key: 'key-of-a-guest-that-left' })).status, 401);
  // The place's own token is not a room key either.
  assert.strictEqual((await rpc('tools/list', {}, { key: PLACE_TOKEN })).status, 401);
});

test('the listener answers the reception and nothing else', async () => {
  const get = await rpc('tools/list', {}, { httpMethod: 'GET' });
  assert.strictEqual(get.status, 405);
  assert.strictEqual(get.headers.get('allow'), 'POST');
  assert.strictEqual((await rpc('tools/list', {}, { to: url.replace('/reception', '/api/agents') })).status, 404);
  assert.strictEqual((await rpc('tools/list', {}, { to: url.replace('/reception', '/mcp') })).status, 404);
  const health = await fetch(url.replace('/reception', '/healthz'));
  assert.strictEqual(await health.text(), 'ok');
});

test('closed by the operator, it is closed to every guest', async () => {
  open = false;
  try {
    const res = await rpc('tools/list', {});
    assert.strictEqual(res.status, 403);
    assert.match(res.body.error.message, /turned it off/);
  } finally { open = true; }
});

test('the handshake says where to start, and a ping is answered', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hermes' } });
  assert.strictEqual(init.body.result.protocolVersion, '2025-06-18');
  assert.match(init.body.result.instructions, /hotel_guide/);
  assert.strictEqual((await rpc('notifications/initialized', undefined, { id: null })).status, 202);
  assert.deepStrictEqual((await rpc('ping')).body.result, {});
  assert.strictEqual((await rpc('resources/list')).body.error.code, -32601);
});

test('the tool list is three tools that do not change with the places', async () => {
  const { body } = await rpc('tools/list', {});
  assert.deepStrictEqual(body.result.tools.map(t => t.name), ['hotel_guide', 'place_tools', 'use_place']);
  assert.deepStrictEqual(body.result.tools, TOOLS);
});

test('the guide names the places, what they are for and how to use them', async () => {
  const { parts: [guide] } = await tool('hotel_guide', {});
  assert.strictEqual(guide.hotel, 'hotel.example.com');
  assert.strictEqual(guide.you, 'magnus');
  assert.deepStrictEqual(guide.places, [{ place: 'loby', kind: 'Lobby', about: 'A web hotel for landing pages.', address: 'https://lobby.example.com' }]);
  assert.match(guide.how.join(' '), /use_place\(place, tool, arguments\)/);
});

test('a place answers for itself: its own instructions and its own tools, read live', async () => {
  const { parts: [listed] } = await tool('place_tools', { place: 'loby' });
  assert.strictEqual(listed.instructions, 'A site is one markdown file. Call describe_format first.');
  assert.deepStrictEqual(listed.tools, [
    { name: 'list_sites', description: 'Every site in the lobby.' },
    { name: 'write_site', description: 'Store a site.' }
  ]);
  const { parts: [one] } = await tool('place_tools', { place: 'loby', tool: 'write_site' });
  assert.deepStrictEqual(one.tool.inputSchema.required, ['host', 'content']);
  const missing = await tool('place_tools', { place: 'loby', tool: 'publish' });
  assert.strictEqual(missing.result.isError, true);
  assert.deepStrictEqual(missing.parts[0].tools, ['list_sites', 'write_site']);
});

test('a call goes to the place with the hotel\'s token, the guest\'s name and one session', async () => {
  place.seen.length = 0;
  const { result } = await tool('use_place', { place: 'loby', tool: 'write_site', arguments: { host: 'a.example', content: '# Hi' } });
  assert.ok(!result.isError);
  assert.strictEqual(result.content[0].text, 'stored a.example for magnus');
  const call = place.seen.find(s => s.method === 'tools/call');
  assert.strictEqual(call.headers.authorization, `Bearer ${PLACE_TOKEN}`);
  assert.strictEqual(call.headers['x-hotel-guest'], 'magnus');
  assert.strictEqual(call.headers['mcp-session-id'], 'session-1');
  assert.ok(!place.seen.some(s => s.method === 'initialize'), 'the handshake from place_tools is reused');
});

test('arguments handed over as a JSON string are taken as meant', async () => {
  const { result } = await tool('use_place', { place: 'loby', tool: 'write_site', arguments: '{"host":"b.example","content":"x"}' });
  assert.strictEqual(result.content[0].text, 'stored b.example for magnus');
  assert.strictEqual((await tool('use_place', { place: 'loby', tool: 'list_sites' })).result.content[0].text, 'a.example\nb.example');
  assert.strictEqual((await tool('use_place', { place: 'loby', tool: 'write_site', arguments: [1] })).result.isError, true);
});

test('a failed call comes back with the tool\'s schema, so the next one can be right', async () => {
  const { result, parts } = await tool('use_place', { place: 'loby', tool: 'write_site', arguments: { host: 'a.example' } });
  assert.strictEqual(result.isError, true);
  assert.strictEqual(parts[0], 'host and content are required');
  assert.deepStrictEqual(parts[1].inputSchema.required, ['host', 'content']);

  const unknown = await tool('use_place', { place: 'loby', tool: 'publish', arguments: {} });
  assert.strictEqual(unknown.result.isError, true);
  assert.deepStrictEqual(unknown.parts[1].tools, ['list_sites', 'write_site']);
});

test('a place that is not in the guide cannot be reached, whatever it is called', async () => {
  for (const name of ['pool', 'http://127.0.0.1:1/mcp', 'agenthotel-backend', '']) {
    const { result, parts } = await tool('use_place', { place: name, tool: 'list_sites' });
    assert.strictEqual(result.isError, true);
    assert.deepStrictEqual(parts[0].places, ['loby']);
  }
});

test('a place that restarted and forgot the session is opened again, unnoticed', async () => {
  place.forget();
  const { result } = await tool('use_place', { place: 'loby', tool: 'list_sites' });
  assert.ok(!result.isError);
  assert.strictEqual(result.content[0].text, 'a.example\nb.example');
});

test('what is logged is who, where, what and how it went, never what was sent', () => {
  assert.ok(used.length >= 5);
  for (const entry of used) {
    assert.deepStrictEqual(Object.keys(entry).sort(), ['guest', 'ms', 'ok', 'place', 'tool']);
    assert.strictEqual(entry.guest.name, 'magnus');
    assert.strictEqual(entry.place, 'loby');
  }
  assert.ok(used.some(e => e.tool === 'write_site' && e.ok) && used.some(e => e.tool === 'write_site' && !e.ok));
});

test('nothing the reception ever answered holds the place\'s token or its other secrets', () => {
  assert.ok(replies.length > 20);
  for (const text of replies) {
    assert.ok(!text.includes(PLACE_TOKEN));
    assert.ok(!text.includes('admin-password'));
    assert.ok(!text.includes(`127.0.0.1:${placePort}`), 'nor the address it calls');
  }
});

test('a place that answers as an event stream is read the same way', async () => {
  const streaming = fakePlace({ sse: true });
  const port = await listenOn(streaming.server);
  const reception = createReception({
    enabled: () => true, keys: () => [], fetch,
    agents: () => [{ id: 'p2', name: 'cinema', template: 'lobby', status: 'running', port, config: { LOBBY_API_TOKEN: PLACE_TOKEN } }],
    templateOf: id => templates[id], targetOf: a => ({ container: '127.0.0.1', port: a.port })
  });
  try {
    const reply = await reception.respond({ id: 'g1', name: 'magnus' }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'use_place', arguments: { place: 'cinema', tool: 'list_sites' } } });
    assert.strictEqual(reply.result.content[0].text, 'a.example\nb.example');
  } finally { streaming.server.close(); }
});

test('a place that refuses the hotel\'s token says it is the hotel\'s to fix', async () => {
  const reception = createReception({
    enabled: () => true, keys: () => [], fetch,
    agents: () => [{ id: 'p1', name: 'loby', template: 'lobby', status: 'running', port: placePort, config: { LOBBY_API_TOKEN: 'rotated-away' } }],
    templateOf: id => templates[id], targetOf: a => ({ container: '127.0.0.1', port: a.port })
  });
  const reply = await reception.respond({ id: 'g1', name: 'magnus' }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'place_tools', arguments: { place: 'loby' } } });
  assert.strictEqual(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /tell the operator/);
  assert.ok(!reply.result.content[0].text.includes('rotated-away'));
});

test('a room key is found whole or not at all', () => {
  const keys = [{ agent_id: 'a', key: 'k-one' }, { agent_id: 'b', key: 'k-two' }, { agent_id: 'c', key: '' }];
  assert.strictEqual(guestForKey(keys, 'k-two'), 'b');
  assert.strictEqual(guestForKey(keys, 'k-tw'), null);
  assert.strictEqual(guestForKey(keys, ''), null, 'an empty key matches no one, not the guest without one');
  assert.strictEqual(guestForKey(keys, undefined), null);
  assert.strictEqual(guestForKey([], 'k-one'), null);
});

test('the places open to a guest: running, declared, reachable, and not itself', () => {
  const template = { name: 'Pages', description: 'Static sites', place: { mcp: '/mcp', auth: 'header', header: 'X-API-Key', tokenEnv: 'PAGES_KEY' } };
  const all = [
    { id: '1', name: 'pages', template: 'pages', status: 'running', port: 80, created_at: '1', config: { PAGES_KEY: 'k1' } },
    { id: '2', name: 'pages', template: 'pages', status: 'running', port: 80, created_at: '2', config: { COMPOSE_ENV: 'OTHER=1\nPAGES_KEY=k2\n' } },
    { id: '3', name: 'stopped', template: 'pages', status: 'stopped', port: 80, created_at: '3', config: { PAGES_KEY: 'k3' } },
    { id: '4', name: 'keyless', template: 'pages', status: 'running', port: 80, created_at: '4', config: {} },
    { id: '5', name: 'plain', template: 'other', status: 'running', port: 80, created_at: '5', config: {} },
    { id: '6', name: 'agent', runtime: 'hermes', status: 'running', created_at: '6', config: {} }
  ];
  const templateOf = id => (id === 'pages' ? template : { name: 'Other' });
  const targetOf = a => ({ container: `agenthotel-${a.id}`, port: a.port });
  const places = listPlaces(all, templateOf, targetOf, '6');
  assert.deepStrictEqual(places.map(p => [p.id, p.url, p.headers]), [
    ['pages', 'http://agenthotel-1:80/mcp', { 'X-API-Key': 'k1' }],
    ['pages-2', 'http://agenthotel-2:80/mcp', { 'X-API-Key': 'k2' }]
  ]);
  // A place does not list itself, and its name stays what the others call it.
  assert.deepStrictEqual(listPlaces(all, templateOf, targetOf, '1').map(p => p.id), ['pages-2']);
});

test('a reply is found in JSON and in an event stream, by its id', () => {
  assert.deepStrictEqual(parseReply('{"jsonrpc":"2.0","id":3,"result":{"ok":true}}', 'application/json', 3).result, { ok: true });
  const stream = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"ok":true}}\n\n';
  assert.deepStrictEqual(parseReply(stream, 'text/event-stream; charset=utf-8', 3).result, { ok: true });
  assert.strictEqual(parseReply(stream, 'text/event-stream', 4), null);
  assert.strictEqual(parseReply('<html>502</html>', 'text/html', 3), null);
});

test('a tool is listed by its first sentence', () => {
  assert.strictEqual(firstLine('Every site in the lobby. One line each.\nMore.'), 'Every site in the lobby.');
  assert.strictEqual(firstLine('Short'), 'Short');
  assert.strictEqual(firstLine('x'.repeat(300)).length, 198);
});

test('the activity log gets one line for a burst of calls, not one per call', () => {
  const lines = [];
  const log = createUseLog((guest, message) => lines.push([guest.id, message]), 60 * 1000);
  const guest = { id: 'g1', name: 'magnus' };
  for (const [tool, ok] of [['write_site', true], ['write_site', true], ['read_site', true], ['write_site', false]]) {
    log.add({ guest, place: 'loby', tool, ok, ms: 100 });
  }
  log.add({ guest, place: 'cinema', tool: 'new_take', ok: true, ms: 40 });
  assert.deepStrictEqual(lines, [], 'nothing until the minute is up');
  log.flushAll();
  assert.deepStrictEqual(lines, [
    ['g1', 'magnus used loby 4 times (write_site ×3, read_site), 1 failed, 100 ms on average'],
    ['g1', 'magnus used cinema once (new_take), 40 ms on average']
  ]);
  log.flushAll();
  assert.strictEqual(lines.length, 2);
});

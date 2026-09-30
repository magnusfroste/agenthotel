// Connecting an agent to SkillHub in one click. Each of these was a step done
// by hand, and most were done wrong at least once.
const { test } = require('node:test');
const assert = require('node:assert');
const L = require('../lib/skillhubLink');

const ENV = 'SERVICE_ROLE_KEY=svc\nMCP_KEY_01=k1\nMCP_KEY_02=k2\nMCP_KEY_03=k3\nMCP_KEY_04=\n';
const hub = { id: 'hub', runtime: 'git-compose', config: { COMPOSE_ENV: ENV } };
const agent = (id, servers) => ({ id, runtime: 'hermes', config: { MCP_SERVERS: servers ? JSON.stringify(servers) : '' } });
const URL = 'https://skillhub.example.com';

test('a SkillHub is recognised by what it holds, not its name', () => {
  assert.ok(L.isSkillhub(hub));
  assert.ok(!L.isSkillhub({ ...hub, runtime: 'hermes' }));
  assert.ok(!L.isSkillhub({ runtime: 'git-compose', config: { COMPOSE_ENV: 'FOO=1' } }));
});

test('an empty key is not a slot — a SkillHub from before key generation has none', () => {
  assert.deepStrictEqual(L.slots(L.parseEnv(ENV)).map(s => s.id), ['agent_01', 'agent_02', 'agent_03']);
  assert.deepStrictEqual(L.slots(L.parseEnv('MCP_KEY_01=\nMCP_KEY_02=')), []);
});

test('who holds a key is read back from the agents themselves', () => {
  const s = L.slots(L.parseEnv(ENV));
  const held = L.holders([agent('a', { skillhub: { url: URL + '/skillhub', headers: { apikey: 'k1' } } }), agent('b')], s);
  assert.strictEqual(held.get('k1'), 'a');
  assert.strictEqual(L.freeSlot(s, held).id, 'agent_02');
});

test('no free slot is null, not a shared key', () => {
  const s = L.slots(L.parseEnv('MCP_KEY_01=k1'));
  const held = L.holders([agent('a', { x: { url: 'u', headers: { apikey: 'k1' } } })], s);
  assert.strictEqual(L.freeSlot(s, held), null);
});

test("connecting keeps the agent's other MCP servers", () => {
  const out = JSON.parse(L.withSkillhub(JSON.stringify({ github: { url: 'https://gh' } }), URL, 'k2'));
  assert.deepStrictEqual(Object.keys(out).sort(), ['github', 'skillhub']);
  assert.strictEqual(out.skillhub.url, URL + '/skillhub');
  assert.strictEqual(out.skillhub.headers.apikey, 'k2');
  assert.ok(!out.supabase_admin, 'the administrator door is opt-in');
});

test('a caretaker gets the second door, and loses it when reconnected as an agent', () => {
  const asCaretaker = L.withSkillhub('', URL, 'k2', 'svc');
  assert.strictEqual(JSON.parse(asCaretaker).supabase_admin.url, URL + '/mcp');
  assert.ok(!JSON.parse(L.withSkillhub(asCaretaker, URL, 'k2')).supabase_admin);
});

test('the connection is read back, with the slot and whether it is a caretaker', () => {
  const s = L.slots(L.parseEnv(ENV));
  const a = agent('a', JSON.parse(L.withSkillhub('', URL + '/', 'k3', 'svc')));
  assert.deepStrictEqual(L.connectionOf(a, URL, s), { slot: s[2], caretaker: true });
  assert.strictEqual(L.connectionOf(agent('b'), URL, s), null);
});

test('disconnecting removes only what points at this SkillHub', () => {
  const both = JSON.stringify({ skillhub: { url: URL + '/skillhub' }, supabase_admin: { url: URL + '/mcp' }, github: { url: 'https://gh' } });
  assert.deepStrictEqual(Object.keys(JSON.parse(L.withoutSkillhub(both, URL))), ['github']);
  assert.strictEqual(L.withoutSkillhub(JSON.stringify({ skillhub: { url: URL + '/skillhub' } }), URL), '');
});

test('generating keys fills the empty ones and keeps the rest', () => {
  const { text, filled } = L.withGeneratedKeys(ENV);
  assert.strictEqual(filled, 1);
  assert.match(text, /^MCP_KEY_01=k1$/m);
  assert.match(text, /^MCP_KEY_04=[0-9a-f]{48}$/m);
});

test('a row an operator named is left alone', () => {
  assert.ok(L.mayName({ name: null, role: null }));
  assert.ok(L.mayName({ name: 'Knatte', role: 'Vacant — a key waiting for an agent' }));
  assert.ok(L.mayName({ name: 'x', role: L.ROLE_PREFIX + ' — x' }));
  assert.ok(!L.mayName({ name: 'Långben', role: 'Caretaker — looks after this store' }));
});

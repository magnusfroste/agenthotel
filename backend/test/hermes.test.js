// The hermes runtime's own decisions: what reaches the container's environment,
// and what it is told about the tools it may use.
const { test } = require('node:test');
const assert = require('node:assert');
// The plugin opens the panel database at import to look up providers. A test
// gets its own empty one rather than the live file.
const os = require('node:os');
const path = require('node:path');
process.env.DB_PATH = path.join(os.tmpdir(), `agenthotel-test-${process.pid}.db`);
const Database = require('better-sqlite3');
new Database(process.env.DB_PATH).exec('CREATE TABLE IF NOT EXISTS providers (name TEXT, type TEXT, apiKey TEXT, baseUrl TEXT, models TEXT)');

const hermes = require('../plugins/hermes');

const envOf = (config) => Object.fromEntries(hermes.buildEnv(config).map(e => {
  const i = e.indexOf('=');
  return [e.slice(0, i), e.slice(i + 1)];
}));

test('an MCP server gets an Accept header that streamable HTTP accepts', () => {
  // Supabase's MCP server answers 406 without both media types; hermes then
  // retries over SSE, which that server does not offer, and never connects.
  const block = hermes.generateMcpBlock({ MCP_SERVERS: JSON.stringify({ s: { url: 'https://example.com/mcp' } }) });
  assert.match(block, /Accept: "application\/json, text\/event-stream"/);
});

test('an explicit header wins over the default', () => {
  const block = hermes.generateMcpBlock({ MCP_SERVERS: JSON.stringify({ s: { url: 'u', headers: { Accept: 'text/plain' } } }) });
  assert.match(block, /Accept: "text\/plain"/);
});

test('malformed MCP_SERVERS costs the tools, not the deploy', () => {
  assert.strictEqual(hermes.generateMcpBlock({ MCP_SERVERS: '{not json' }), null);
  assert.strictEqual(hermes.generateMcpBlock({}), null);
  assert.strictEqual(hermes.generateMcpBlock({ MCP_SERVERS: '{"s":{"headers":{}}}' }), null, 'a url is required');
});

test('a new agent gets its own dashboard password and signing key', () => {
  const a = hermes.buildConfig({ name: 'a', config: {} });
  const b = hermes.buildConfig({ name: 'b', config: {} });
  assert.notStrictEqual(a.HERMES_DASHBOARD_BASIC_AUTH_PASSWORD, b.HERMES_DASHBOARD_BASIC_AUTH_PASSWORD);
  assert.notStrictEqual(a.HERMES_DASHBOARD_BASIC_AUTH_SECRET, b.HERMES_DASHBOARD_BASIC_AUTH_SECRET);
  assert.ok(Buffer.from(a.HERMES_DASHBOARD_BASIC_AUTH_SECRET, 'base64').length >= 32);
});

test('a signing key too short is refused, with the field the operator meant', () => {
  // Nine characters here stopped hermes registering its auth provider at all,
  // reported as "no auth providers are registered".
  assert.throws(() => hermes.buildEnv({ HERMES_DASHBOARD_BASIC_AUTH_SECRET: 'berga1992' }),
    /too short[\s\S]*HERMES_DASHBOARD_BASIC_AUTH_PASSWORD/);
});

test('an agent created before signing keys existed still starts', () => {
  // No secret at all means hermes generates its own; an empty one means a key of
  // nothing. The first is the old behaviour and must survive.
  const env = envOf({});
  assert.strictEqual(env.HERMES_DASHBOARD_BASIC_AUTH_SECRET, undefined);
  assert.ok(env.HERMES_DASHBOARD_BASIC_AUTH_PASSWORD, 'the fallback password must still be set');
});

test('the dashboard credentials are written exactly once', () => {
  // They were written twice, explicitly and again through the unknown-key
  // pass-through, which also defeated the guard above.
  const config = hermes.buildConfig({ name: 'x', config: {} });
  const env = hermes.buildEnv(config);
  for (const key of ['HERMES_DASHBOARD_BASIC_AUTH_PASSWORD', 'HERMES_DASHBOARD_BASIC_AUTH_SECRET', 'HERMES_DASHBOARD_BASIC_AUTH_USERNAME']) {
    assert.strictEqual(env.filter(e => e.startsWith(key + '=')).length, 1, `${key} appears more than once`);
  }
});

test('the model reaches the container bare, with routing left to config.yaml', () => {
  // A prefixed value makes hermes look up "openai" as a provider name and fail.
  assert.strictEqual(envOf({ HERMES_MODEL: 'openai/gpt-5.6-luna' }).HERMES_MODEL, 'gpt-5.6-luna');
});

// What a guest is handed about the operator's providers.
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { injectProviderEnv } = require('../lib/providerEnv');

function dbWith(providers) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE providers (id TEXT, name TEXT, type TEXT, baseUrl TEXT, apiKey TEXT, models TEXT)');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT, agent_id TEXT, message TEXT)');
  const ins = db.prepare('INSERT INTO providers VALUES (?,?,?,?,?,?)');
  providers.forEach((p, i) => ins.run(`p${i}`, p.name, p.type || '', p.baseUrl || '', p.apiKey || '', JSON.stringify(p.models || [])));
  return db;
}

// A runtime that takes credentials but declares no model to choose, so the
// test is about the env and not about probing.
const plugin = { name: 'test', providerCredentials: 'required' };

test('a built-in hands over its key and nothing else', async () => {
  const db = dbWith([{ name: 'OpenAI', apiKey: 'sk-1', models: ['gpt-5.6-luna', 'gpt-4'] },
                     { name: 'OpenRouter', apiKey: 'or-1', models: ['openai/gpt-5.6-luna'] }]);
  const env = await injectProviderEnv(db, {}, plugin);
  assert.strictEqual(env.OPENAI_API_KEY, 'sk-1');
  assert.strictEqual(env.OPENROUTER_API_KEY, 'or-1');
  for (const k of ['OPENAI_BASE_URL', 'OPENAI_MODELS', 'OPENROUTER_BASE_URL', 'OPENROUTER_MODELS']) {
    assert.strictEqual(env[k], undefined, `${k} should not be injected for a built-in`);
  }
});

test('an own endpoint hands over its key, its address and what it serves', async () => {
  const db = dbWith([{ name: 'DGX Spark', baseUrl: 'https://glm.example.se/v1/', apiKey: 'k', models: ['glm-5.3-flash'] }]);
  const env = await injectProviderEnv(db, {}, plugin);
  assert.strictEqual(env.DGXSPARK_API_KEY, 'k');
  assert.strictEqual(env.DGXSPARK_BASE_URL, 'https://glm.example.se/v1');
  assert.strictEqual(env.DGXSPARK_MODELS, 'glm-5.3-flash');
});

test('what the operator set on the agent is never overwritten', async () => {
  const db = dbWith([{ name: 'OpenAI', apiKey: 'sk-1', models: ['gpt-4'] }]);
  const env = await injectProviderEnv(db, { OPENAI_API_KEY: 'mine', OPENAI_BASE_URL: 'https://proxy.example/v1' }, plugin);
  assert.strictEqual(env.OPENAI_API_KEY, 'mine');
  assert.strictEqual(env.OPENAI_BASE_URL, 'https://proxy.example/v1');
});

test('leftover rows from a built-in are named for removal; an operator\'s proxy is not', async () => {
  const { builtinLeftovers } = require('../lib/providerEnv');
  const gone = builtinLeftovers({
    OPENAI_API_KEY: 'sk', OPENAI_MODELS: 'gpt-4,gpt-5.6-luna', OPENAI_BASE_URL: 'https://api.openai.com/v1/',
    OPENROUTER_MODELS: 'x', OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
    DGXSPARK_BASE_URL: 'https://glm.example.se/v1', DGXSPARK_MODELS: 'glm-5.3-flash',
    HERMES_MODEL: 'openai/gpt-5.6-luna'
  });
  assert.deepStrictEqual(gone.sort(), ['OPENAI_BASE_URL', 'OPENAI_MODELS', 'OPENROUTER_BASE_URL', 'OPENROUTER_MODELS']);
  assert.deepStrictEqual(builtinLeftovers({ OPENAI_BASE_URL: 'https://proxy.example/v1', OPENAI_API_KEY: 'sk' }), []);
});

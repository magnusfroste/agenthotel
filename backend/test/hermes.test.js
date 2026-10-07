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

// A model named without a prefix. This sent a GLM model running on the
// operator's own hardware to api.openai.com, and hermes — which reads the glm-
// family as Z.ai — asked for a Z.ai key for it.
const PROVIDERS = {
  DGXSPARK_BASE_URL: 'https://glm.example/v1', DGXSPARK_API_KEY: 'sk-spark', DGXSPARK_MODELS: 'glm-5.3-flash',
  OPENAI_BASE_URL: 'https://api.openai.com/v1', OPENAI_API_KEY: 'sk-proj', OPENAI_MODELS: 'gpt-4,gpt-5.6-luna',
};
const providerOf = (model, extra = {}) => {
  const block = hermes.generateConfig({ ...PROVIDERS, ...extra, HERMES_MODEL: model });
  return block ? (/provider: (\S+)/.exec(block) || [])[1] : null;
};

test('a bare model name goes to whichever provider lists it', () => {
  assert.strictEqual(providerOf('glm-5.3-flash'), 'dgxspark');
  const block = hermes.generateConfig({ ...PROVIDERS, HERMES_MODEL: 'glm-5.3-flash' });
  assert.match(block, /base_url: https:\/\/glm\.example\/v1/, 'and to that provider\'s endpoint');
  assert.match(block, /key_env: DGXSPARK_API_KEY/, 'with that provider\'s key');
});

test('a prefix and a listing agree', () => {
  assert.strictEqual(providerOf('dgxspark/glm-5.3-flash'), 'dgxspark');
});

test("a provider's own model still routes to it", () => {
  assert.strictEqual(providerOf('gpt-5.6-luna'), 'openai-api');
});

test('an unknown model keeps the old assumption', () => {
  // Nothing claims it, so the OpenAI-compatible default is as good a guess as
  // any — and the operator gets a "model not found" that names the endpoint.
  assert.strictEqual(providerOf('something-nobody-lists'), 'openai-api');
});

test('two providers listing one id is not guessed at', () => {
  // Ambiguity is the operator's to settle with a prefix.
  assert.strictEqual(providerOf('glm-5.3-flash', { OPENAI_MODELS: 'glm-5.3-flash' }), 'openai-api');
});

// ---- Model ids from proxies, and every own endpoint in the model picker ----
{
  const yaml = require('js-yaml');
  const { splitModel, ownEndpoints } = hermes._internals;
  const keys = { OPENAI_API_KEY: 'sk', OPENROUTER_API_KEY: 'or' };
  const garage = { GARAGEAI_API_KEY: 'g', GARAGEAI_BASE_URL: 'https://llm.example/v1',
    GARAGEAI_MODELS: 'garage/autoversio/deepseek/deepseek-v4.1-flash,deepseek/deepseek-v4.1-flash' };
  const dgx = { DGXSPARK_API_KEY: 'd', DGXSPARK_BASE_URL: 'https://glm.example/v1', DGXSPARK_MODELS: 'glm-5.3-flash' };

  test("a proxy's own id, written without the proxy's name, finds the proxy", () => {
    assert.deepStrictEqual(splitModel('garage/autoversio/deepseek/deepseek-v4.1-flash', { ...keys, ...garage }),
      { providerIn: 'garageai', model: 'garage/autoversio/deepseek/deepseek-v4.1-flash' });
  });

  test("an id that looks like a vendor's goes to the proxy that lists it when there is no such vendor here", () => {
    assert.deepStrictEqual(splitModel('deepseek/deepseek-v4.1-flash', { ...keys, ...garage }),
      { providerIn: 'garageai', model: 'deepseek/deepseek-v4.1-flash' });
  });

  test('a prefix the agent has always wins — every id that worked before still does', () => {
    assert.deepStrictEqual(splitModel('garageai/deepseek/deepseek-v4.1-flash', { ...keys, ...garage }),
      { providerIn: 'garageai', model: 'deepseek/deepseek-v4.1-flash' });
    assert.deepStrictEqual(splitModel('deepseek/deepseek-v4.1-flash', { ...keys, ...garage, DEEPSEEK_API_KEY: 'ds' }),
      { providerIn: 'deepseek', model: 'deepseek-v4.1-flash' }, 'with a DeepSeek key, deepseek/ means DeepSeek');
    assert.deepStrictEqual(splitModel('openai/gpt-6-sol', { ...keys, ...garage }), { providerIn: 'openai', model: 'gpt-6-sol' });
    assert.deepStrictEqual(splitModel('dgxspark/glm-5.3-flash', { ...keys, ...dgx }), { providerIn: 'dgxspark', model: 'glm-5.3-flash' });
  });

  test('a typo with nothing to match stays as written — the page warns, the panel does not guess', () => {
    assert.deepStrictEqual(splitModel('autoversi/autoversio', { ...keys, AUTOVERSIO_API_KEY: 'a', AUTOVERSIO_BASE_URL: 'https://x/v1', AUTOVERSIO_MODELS: 'autoversio' }),
      { providerIn: 'autoversi', model: 'autoversio' });
  });

  test('every own endpoint is in the picker, the default first, even when the default is OpenAI', () => {
    const cfg = { ...keys, ...garage, ...dgx, HERMES_MODEL: 'openai/gpt-6-sol' };
    const parsed = yaml.load(hermes.generateConfig(cfg));
    assert.deepStrictEqual(parsed.model, { provider: 'openai-api', default: 'gpt-6-sol', base_url: 'https://api.openai.com/v1' });
    assert.deepStrictEqual(parsed.custom_providers.map(p => p.name), ['dgxspark', 'garageai']);
    assert.strictEqual(parsed.custom_providers[1].model, 'garage/autoversio/deepseek/deepseek-v4.1-flash');

    const own = yaml.load(hermes.generateConfig({ ...cfg, HERMES_MODEL: 'garageai/deepseek/deepseek-v4.1-flash' }));
    assert.deepStrictEqual(own.model, { provider: 'garageai', default: 'deepseek/deepseek-v4.1-flash' });
    assert.deepStrictEqual(own.custom_providers.map(p => p.name), ['garageai', 'dgxspark']);
    assert.strictEqual(own.custom_providers[0].model, 'deepseek/deepseek-v4.1-flash');
    assert.strictEqual(own.custom_providers[0].key_env, 'GARAGEAI_API_KEY');
  });

  test('a keyless default endpoint is kept, and named as the model id wrote it', () => {
    const ollama = yaml.load(hermes.generateConfig({ ...keys, HERMES_MODEL: 'ollama/llama3.3', OLLAMA_BASE_URL: 'http://10.0.0.5:11434/v1' }));
    assert.deepStrictEqual(ollama.custom_providers.map(p => p.name), ['ollama']);
    const hyphen = yaml.load(hermes.generateConfig({ ...keys, ...dgx, HERMES_MODEL: 'dgx-spark/glm-5.3-flash' }));
    assert.strictEqual(hyphen.model.provider, 'dgx-spark');
    assert.deepStrictEqual(hyphen.custom_providers.map(p => p.name), ['dgx-spark']);
  });

  test('not a model provider: a stray FOO_BASE_URL, or a name hermes uses for its own', () => {
    const names = ownEndpoints({ ...keys, FOO_BASE_URL: 'https://foo.example', OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
      CUSTOM_BASE_URL: 'https://c.example', CUSTOM_API_KEY: 'c', ...dgx }).map(e => e.name);
    assert.deepStrictEqual(names, ['dgxspark']);
  });

  test('model ids with colons and slashes survive the YAML', () => {
    const cfg = { ...keys, HERMES_MODEL: 'openai/gpt-6-sol', UNSLOTH_API_KEY: 'u', UNSLOTH_BASE_URL: 'https://u.example/v1',
      UNSLOTH_MODELS: 'unsloth/Qwen3.8-Flash-Next-GGUF:UD-Q2_K_XL' };
    assert.strictEqual(yaml.load(hermes.generateConfig(cfg)).custom_providers[0].model, 'unsloth/Qwen3.8-Flash-Next-GGUF:UD-Q2_K_XL');
  });
}

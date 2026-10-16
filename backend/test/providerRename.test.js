// A renamed or deleted provider takes its env back out of the agents
// (2026-10-16: "api" renamed to "garageai" would have left API_API_KEY,
// API_BASE_URL and API_MODELS in every agent beside the new GARAGEAI_* ones).
const { test } = require('node:test');
const assert = require('node:assert');
const { withoutProviderEnv } = require('../lib/providerEnv');

const api = { name: 'api', apiKey: 'sk-garage', baseUrl: 'https://api.garageai.eu/v1', models: JSON.stringify(['qwen/qwen3.8-27b', 'garageai/auto']) };

test('what the provider injected is removed, the rest stays', () => {
  const config = {
    API_API_KEY: 'sk-garage',
    API_BASE_URL: 'https://api.garageai.eu/v1',
    API_MODELS: 'qwen/qwen3.8-27b,garageai/auto,xiaomi/mimo-v2.6-flash', // refreshed since
    LITEIT_API_KEY: 'sk-liteit',
    HERMES_MODEL: 'dgxspark/mimo-v2.6-flash'
  };
  assert.deepStrictEqual(withoutProviderEnv(config, api), { LITEIT_API_KEY: 'sk-liteit', HERMES_MODEL: 'dgxspark/mimo-v2.6-flash' });
});

test('a key the operator typed under the same name is not touched', () => {
  const config = { API_API_KEY: 'sk-my-own', API_BASE_URL: 'https://elsewhere.example/v1', API_MODELS: 'x' };
  assert.deepStrictEqual(withoutProviderEnv(config, api), config);
});

test('the input is not mutated, and a nameless provider changes nothing', () => {
  const config = { API_API_KEY: 'sk-garage' };
  withoutProviderEnv(config, api);
  assert.strictEqual(config.API_API_KEY, 'sk-garage');
  assert.deepStrictEqual(withoutProviderEnv(config, { name: '' }), config);
});

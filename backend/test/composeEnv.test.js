// What a compose stack's .env ends up containing.
const { test } = require('node:test');
const assert = require('node:assert');
const { buildComposeEnv, envLine } = require('../lib/composeEnv');

const cfg = (extra) => ({
  COMPOSE_ENV: 'DB_PASSWORD=abc\nOPENAI_API_KEY=set-by-hand',
  OPENAI_API_KEY: 'sk-injected', OPENAI_BASE_URL: 'https://api.openai.com/v1',
  DGXSPARK_API_KEY: 'sk-spark', DGXSPARK_MODELS: 'glm-5.3-flash',
  HERMES_DASHBOARD_BASIC_AUTH_PASSWORD: 'not-a-provider-key',
  ...extra,
});

test('without opting in, the .env is exactly what the operator wrote', () => {
  assert.strictEqual(buildComposeEnv(cfg()), 'DB_PASSWORD=abc\nOPENAI_API_KEY=set-by-hand');
});

test('opting in adds the provider keys — which used to be discarded', () => {
  const env = buildComposeEnv(cfg({ INJECT_PROVIDER_ENV: 'true' }));
  assert.match(env, /^DGXSPARK_API_KEY=sk-spark$/m);
  assert.match(env, /^DGXSPARK_MODELS=glm-5.3-flash$/m);
  assert.match(env, /^OPENAI_BASE_URL=https:\/\/api.openai.com\/v1$/m);
});

test('what the operator wrote wins over injection', () => {
  const env = buildComposeEnv(cfg({ INJECT_PROVIDER_ENV: 'yes' }));
  assert.match(env, /^OPENAI_API_KEY=set-by-hand$/m);
  assert.doesNotMatch(env, /sk-injected/);
});

test('only provider keys are injected, not the rest of the agent config', () => {
  assert.doesNotMatch(buildComposeEnv(cfg({ INJECT_PROVIDER_ENV: '1' })), /HERMES_DASHBOARD/);
});

test('a value with a line break is refused rather than splitting the file', () => {
  assert.throws(() => envLine('X_API_KEY', 'a\nEVIL=1'), /line break/);
});

test('values compose would misread are quoted and escaped', () => {
  assert.strictEqual(envLine('A_API_KEY', 'plain-value_1.2/3:4'), 'A_API_KEY=plain-value_1.2/3:4');
  assert.strictEqual(envLine('A_API_KEY', 'has space'), 'A_API_KEY="has space"');
  assert.strictEqual(envLine('A_API_KEY', 'q"u$o'), 'A_API_KEY="q\\"u\\$o"');
});

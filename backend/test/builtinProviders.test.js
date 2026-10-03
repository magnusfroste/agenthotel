// A provider is a built-in or the operator's own endpoint, decided by its name.
const { test } = require('node:test');
const assert = require('node:assert');
const { builtinFor, effectiveBaseUrl, modelsRequest, normalizeModelId, slugify } = require('../lib/builtinProviders');

test('the name settles it, however it is spelled', () => {
  assert.strictEqual(builtinFor('OpenAI').keyEnv, 'OPENAI_API_KEY');
  assert.strictEqual(builtinFor('Open AI').keyEnv, 'OPENAI_API_KEY');
  assert.strictEqual(builtinFor('openai').keyEnv, 'OPENAI_API_KEY');
  assert.strictEqual(builtinFor('Z.ai').keyEnv, 'ZAI_API_KEY');
  assert.strictEqual(builtinFor('dgxspark'), null);
});

test('a built-in answers at its own address, whatever the row stored', () => {
  assert.strictEqual(effectiveBaseUrl({ name: 'OpenAI', baseUrl: 'https://proxy.example/v1' }), 'https://api.openai.com/v1');
  assert.strictEqual(effectiveBaseUrl({ name: 'OpenAI', baseUrl: '' }), 'https://api.openai.com/v1');
});

test('an own endpoint is wherever it says, without a trailing slash', () => {
  assert.strictEqual(effectiveBaseUrl({ name: 'dgxspark', baseUrl: 'https://glm.example.se/v1/' }), 'https://glm.example.se/v1');
  assert.strictEqual(effectiveBaseUrl({ name: 'dgxspark' }), '');
});

test('everyone is asked GET /models with a bearer token, except Anthropic', () => {
  const o = modelsRequest({ name: 'OpenAI', apiKey: 'sk-1' });
  assert.strictEqual(o.url, 'https://api.openai.com/v1/models');
  assert.strictEqual(o.headers.Authorization, 'Bearer sk-1');
  const a = modelsRequest({ name: 'Anthropic', apiKey: 'ak-1' });
  assert.strictEqual(a.url, 'https://api.anthropic.com/v1/models');
  assert.strictEqual(a.headers['x-api-key'], 'ak-1');
  assert.ok(a.headers['anthropic-version']);
  assert.strictEqual(a.headers.Authorization, undefined);
  const own = modelsRequest({ name: 'dgxspark', baseUrl: 'https://glm.example.se/v1', apiKey: 'k' });
  assert.strictEqual(own.url, 'https://glm.example.se/v1/models');
});

test("Gemini's listing says models/…; agents write it bare", () => {
  assert.strictEqual(normalizeModelId('Gemini', 'models/gemini-2.5-pro'), 'gemini-2.5-pro');
  assert.strictEqual(normalizeModelId('OpenAI', 'models/odd-name'), 'models/odd-name');
});

test('the slug is the prefix an agent writes and the stem of its env vars', () => {
  assert.strictEqual(slugify('DGX Spark'), 'dgxspark');
  assert.strictEqual(`${slugify('DGX Spark').toUpperCase()}_API_KEY`, 'DGXSPARK_API_KEY');
});

test('only models an agent can chat with count; an unfamiliar id does', () => {
  const { isChatModel } = require('../lib/builtinProviders');
  for (const id of ['gpt-5.6-luna', 'gpt-6.1-sol', 'gpt-5.2-codex', 'gpt-3.5-turbo-1106', 'openai/gpt-6.1-sol-pro',
                    'anthropic/claude-sonnet-5.5', 'glm-5.3-flash', 'unsloth/Qwen3.8-Flash-Next-GGUF:UD-Q2_K_XL', 'gpt-4o-search-preview'])
    assert.ok(isChatModel(id), `${id} should count as chat`);
  for (const id of ['gpt-4o-mini-tts-2025-03-20', 'gpt-audio-mini', 'gpt-4o-transcribe', 'gpt-image-2.5-flare', 'whisper-1',
                    'text-embedding-3-small', 'omni-moderation-latest', 'dall-e-3', 'gpt-realtime', 'sora-2',
                    'google/gemini-3.1-flash-image', 'openai/gpt-5.4-image-2', 'davinci-002'])
    assert.ok(!isChatModel(id), `${id} should not count as chat`);
});

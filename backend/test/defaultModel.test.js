// Which model a new agent gets when its form leaves the field empty.
const { test } = require('node:test');
const assert = require('node:assert');
const { pinnedDefaultModel } = require('../lib/providerEnv');

const providers = [
  { name: 'OpenAI', apiKey: 'sk-x', models: '["gpt-4","gpt-5.6-luna"]' },
  { name: 'DGX Spark', apiKey: 'k', models: '["glm-5.3-flash"]' },
  { name: 'NoKey', apiKey: '', models: '["m"]' },
];

test('the operator\'s pick is taken as written, provider and all', () => {
  assert.deepStrictEqual(pinnedDefaultModel('dgxspark/glm-5.3-flash', providers), { model: 'dgxspark/glm-5.3-flash', reason: null });
});

test('a model id with its own slash keeps it', () => {
  assert.strictEqual(pinnedDefaultModel('openai/org/model-x', providers).model, 'openai/org/model-x');
});

test('nothing set means the panel chooses, and says nothing about it', () => {
  assert.deepStrictEqual(pinnedDefaultModel('', providers), { model: null, reason: null });
  assert.deepStrictEqual(pinnedDefaultModel(undefined, providers), { model: null, reason: null });
});

test('a bare model name is refused — the prefix is what picks the provider', () => {
  const r = pinnedDefaultModel('glm-5.3-flash', providers);
  assert.strictEqual(r.model, null);
  assert.match(r.reason, /provider\/model/);
});

test('a provider that is gone, or has no key, falls back with a reason', () => {
  assert.match(pinnedDefaultModel('anthropic/claude', providers).reason, /"anthropic"/);
  assert.match(pinnedDefaultModel('nokey/m', providers).reason, /no configured key/);
});

// The Python that splices the panel's blocks into hermes's config.yaml, run for
// real when python3 is on the machine (it is on CI's runner and in every hermes
// image). Fixtures are shaped like files hermes actually writes.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');
const { buildPatchScript } = require('../lib/hermesConfigPatch');

let python = null;
for (const p of ['python3', 'python']) {
  try { execFileSync(p, ['--version'], { stdio: 'ignore' }); python = p; break; } catch (e) { /* next */ }
}

function patch(text, modelBlock, mcpBlock = null, cwd = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-'));
  const file = path.join(dir, 'config.yaml');
  fs.writeFileSync(file, text);
  execFileSync(python, ['-c', buildPatchScript(modelBlock, mcpBlock, cwd), file]);
  return fs.readFileSync(file, 'utf8');
}

// What hermes left after a redeploy: it appended api_mode and models to the
// panel's custom_providers entry below the file's header comments.
const WRITTEN_BY_HERMES = `mcp_servers:
  reel-studio:
    url: "https://reel.example/mcp"
    enabled: true
model:
  provider: garageai
  default: deepseek/deepseek-v4.1-flash
custom_providers:
  - name: garageai
    base_url: https://llm.example/v1
    key_env: GARAGEAI_API_KEY
# Hermes Agent CLI Configuration
# Copy settings from this example into ~/.hermes/config.yaml

    api_mode: codex_responses
    models:
      deepseek/deepseek-v4.1-flash: {}
    models_discovered: true

# How the terminal behaves.
terminal:
  backend: local
  timeout: 180
memory:
  enabled: true
`;

const NEW_BLOCK = `model:
  provider: openai-api
  default: gpt-6-sol
  base_url: https://api.openai.com/v1
custom_providers:
- name: garageai
  base_url: https://llm.example/v1
  key_env: GARAGEAI_API_KEY
  model: "deepseek/deepseek-v4.1-flash"
`;

test('lines hermes left below comments inside a block go with the block', { skip: !python && 'no python3' }, () => {
  const out = patch(WRITTEN_BY_HERMES, NEW_BLOCK);
  const parsed = yaml.load(out); // threw before: orphaned api_mode under the new entry
  assert.deepStrictEqual(parsed.model, { provider: 'openai-api', default: 'gpt-6-sol', base_url: 'https://api.openai.com/v1' });
  assert.deepStrictEqual(parsed.custom_providers, [{ name: 'garageai', base_url: 'https://llm.example/v1', key_env: 'GARAGEAI_API_KEY', model: 'deepseek/deepseek-v4.1-flash' }]);
});

test('everything the panel does not own is kept, including comments before the next key', { skip: !python && 'no python3' }, () => {
  const out = patch(WRITTEN_BY_HERMES, NEW_BLOCK);
  const parsed = yaml.load(out);
  assert.deepStrictEqual(parsed.terminal, { backend: 'local', timeout: 180 });
  assert.deepStrictEqual(parsed.memory, { enabled: true });
  assert.deepStrictEqual(Object.keys(parsed.mcp_servers), ['reel-studio'], 'no panel MCP block: the operator\'s servers stay');
  assert.match(out, /# How the terminal behaves\.\nterminal:/);
});

test('patching twice is patching once', { skip: !python && 'no python3' }, () => {
  const once = patch(WRITTEN_BY_HERMES, NEW_BLOCK);
  assert.strictEqual(patch(once, NEW_BLOCK), once);
});

test('terminal.cwd is set in place, its siblings untouched', { skip: !python && 'no python3' }, () => {
  const parsed = yaml.load(patch(WRITTEN_BY_HERMES, NEW_BLOCK, null, '/opt/data/workspace'));
  assert.deepStrictEqual(parsed.terminal, { backend: 'local', timeout: 180, cwd: '/opt/data/workspace' });
});

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
const { buildPatchScript, gatewayRestartCommand } = require('../lib/hermesConfigPatch');

let python = null;
for (const p of ['python3', 'python']) {
  try { execFileSync(p, ['--version'], { stdio: 'ignore' }); python = p; break; } catch (e) { /* next */ }
}

function patch(text, modelBlock, mcpBlock = null, cwd = '', webapp = null, hotel = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-'));
  const file = path.join(dir, 'config.yaml');
  fs.writeFileSync(file, text);
  execFileSync(python, ['-c', buildPatchScript(modelBlock, mcpBlock, cwd, webapp, hotel), file]);
  return fs.readFileSync(file, 'utf8');
}

const WEBAPP_ON = 'webapp:\n  enabled: true\n  host: 0.0.0.0\n  port: 9120\n  public_url: https://a.example.com\n';

test('the webapp block replaces the one hermes wrote and leaves the rest', { skip: !python && 'no python3' }, () => {
  const out = patch('memory:\n  enabled: true\nwebapp:\n  enabled: false\n  host: 127.0.0.1\nterminal:\n  timeout: 180\n', null, null, '', WEBAPP_ON);
  const parsed = yaml.load(out);
  assert.deepStrictEqual(parsed.webapp, { enabled: true, host: '0.0.0.0', port: 9120, public_url: 'https://a.example.com' });
  assert.deepStrictEqual(parsed.terminal, { timeout: 180 });
  assert.deepStrictEqual(parsed.memory, { enabled: true });
});

test('with no webapp block a guest keeps what it set itself', { skip: !python && 'no python3' }, () => {
  const out = patch('webapp:\n  enabled: true\n  port: 9555\n', null);
  assert.deepStrictEqual(yaml.load(out).webapp, { enabled: true, port: 9555 });
});

test('the gateway restart cannot match its own shell', () => {
  const cmd = gatewayRestartCommand();
  assert.match(cmd, /s6-svc -r \/run\/hermes-service\/gateway-default/);
  // pgrep -f matches the sh -c running this very string. The bracket form does
  // not contain the text it searches for.
  const pattern = /pgrep -f "([^"]+)"/.exec(cmd)[1];
  assert.ok(!new RegExp(pattern).test(cmd), 'the fallback would signal its own shell');
  assert.ok(new RegExp(pattern).test('/usr/bin/python hermes gateway run'));
});

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

// The reception: one entry the panel writes into whatever mcp_servers: block the
// guest has, so the servers an operator added inside hermes are not lost.
const RECEPTION = 'http://agenthotel-backend:8090/reception';
const hotelEntry = (key) => `  hotel:\n    url: "${RECEPTION}"\n    headers:\n      Authorization: "Bearer ${key}"\n    enabled: true\n    timeout: 120\n`;
const HOTEL = { name: 'hotel', mark: RECEPTION, entry: hotelEntry('key-1') };
const HOTEL_OFF = { name: 'hotel', mark: RECEPTION, entry: '' };

test('the reception is added beside the servers a guest already has', { skip: !python && 'no python3' }, () => {
  const out = patch(WRITTEN_BY_HERMES, null, null, '', null, HOTEL);
  const parsed = yaml.load(out);
  assert.deepStrictEqual(Object.keys(parsed.mcp_servers), ['hotel', 'reel-studio']);
  assert.deepStrictEqual(parsed.mcp_servers['reel-studio'], { url: 'https://reel.example/mcp', enabled: true });
  assert.strictEqual(parsed.mcp_servers.hotel.url, RECEPTION);
  assert.strictEqual(parsed.model.provider, 'garageai', 'nothing else moved');
  assert.strictEqual(patch(out, null, null, '', null, HOTEL), out, 'and a second patch changes nothing');
});

test('a new room key replaces the old entry instead of adding a second', { skip: !python && 'no python3' }, () => {
  const once = patch(WRITTEN_BY_HERMES, null, null, '', null, HOTEL);
  const out = patch(once, null, null, '', null, { ...HOTEL, entry: hotelEntry('key-2') });
  assert.strictEqual(out.match(/^  hotel:/gm).length, 1);
  assert.strictEqual(yaml.load(out).mcp_servers.hotel.headers.Authorization, 'Bearer key-2');
  assert.ok(!out.includes('key-1'));
});

test('a guest with no MCP servers gets the block, one with an empty one gets it filled', { skip: !python && 'no python3' }, () => {
  const bare = yaml.load(patch('model:\n  provider: openai\nterminal:\n  timeout: 180\n', null, null, '', null, HOTEL));
  assert.deepStrictEqual(Object.keys(bare.mcp_servers), ['hotel']);
  assert.deepStrictEqual(bare.terminal, { timeout: 180 });
  for (const empty of ['mcp_servers: {}', 'mcp_servers:', 'mcp_servers: null', 'mcp_servers: {}  # none yet']) {
    const parsed = yaml.load(patch(`memory:\n  enabled: true\n${empty}\nterminal:\n  timeout: 180\n`, null, null, '', null, HOTEL));
    assert.deepStrictEqual(Object.keys(parsed.mcp_servers), ['hotel'], empty);
    assert.deepStrictEqual(parsed.terminal, { timeout: 180 }, empty);
  }
});

test('a block indented deeper than the panel writes gets the entry at its own depth', { skip: !python && 'no python3' }, () => {
  const deep = 'mcp_servers:\n    lobby:\n        url: "http://lobby/mcp"\n        headers:\n            Authorization: "Bearer x"\nterminal:\n  timeout: 180\n';
  const parsed = yaml.load(patch(deep, null, null, '', null, HOTEL));
  assert.deepStrictEqual(Object.keys(parsed.mcp_servers), ['hotel', 'lobby']);
  assert.strictEqual(parsed.mcp_servers.hotel.headers.Authorization, 'Bearer key-1');
  assert.strictEqual(parsed.mcp_servers.lobby.headers.Authorization, 'Bearer x');
});

test('the reception goes into the block the panel writes too', { skip: !python && 'no python3' }, () => {
  const panel = 'mcp_servers:\n  supabase:\n    url: "https://example.com/mcp"\n    enabled: true\n';
  const parsed = yaml.load(patch(WRITTEN_BY_HERMES, NEW_BLOCK, panel, '', null, HOTEL));
  assert.deepStrictEqual(Object.keys(parsed.mcp_servers), ['hotel', 'supabase'], 'the panel\'s block replaced the old one, the reception joined it');
  assert.strictEqual(parsed.model.provider, 'openai-api');
});

test('a closed reception is taken out, and only the reception', { skip: !python && 'no python3' }, () => {
  const withHotel = patch(WRITTEN_BY_HERMES, null, null, '', null, HOTEL);
  assert.strictEqual(patch(withHotel, null, null, '', null, HOTEL_OFF), WRITTEN_BY_HERMES, 'the file is as it was before the reception');

  // The last server gone, the block goes too rather than standing empty.
  const only = patch('terminal:\n  timeout: 180\n', null, null, '', null, HOTEL);
  assert.strictEqual(patch(only, null, null, '', null, HOTEL_OFF), 'terminal:\n  timeout: 180\n');

  // A server someone else named hotel is theirs: it does not point at the reception.
  const theirs = 'mcp_servers:\n  hotel:\n    url: "https://booking.example/mcp"\n';
  assert.strictEqual(patch(theirs, null, null, '', null, HOTEL_OFF), theirs);
  assert.strictEqual(patch(WRITTEN_BY_HERMES, null, null, '', null, HOTEL_OFF), WRITTEN_BY_HERMES, 'nothing to take out is no change');
});

test('with the reception on, the name hotel is the reception\'s', { skip: !python && 'no python3' }, () => {
  const theirs = 'mcp_servers:\n  hotel:\n    url: "https://booking.example/mcp"\n  other:\n    url: "https://o.example/mcp"\n';
  const parsed = yaml.load(patch(theirs, null, null, '', null, HOTEL));
  assert.strictEqual(parsed.mcp_servers.hotel.url, RECEPTION);
  assert.strictEqual(parsed.mcp_servers.other.url, 'https://o.example/mcp');
});

test('a servers block written on one line is left alone rather than guessed at', { skip: !python && 'no python3' }, () => {
  const inline = 'mcp_servers: {lobby: {url: "http://lobby/mcp"}}\nterminal:\n  timeout: 180\n';
  assert.strictEqual(patch(inline, null, null, '', null, HOTEL), inline);
});

test('a name that is not a plain word is never written into the script', () => {
  const script = buildPatchScript(null, null, '', null, { name: 'x"; import os #', mark: RECEPTION, entry: 'x' });
  assert.ok(!script.includes('import os #'));
});

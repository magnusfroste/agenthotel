#!/bin/sh
set -e

CONFIG_PATH="/home/node/.openclaw/openclaw.json"
mkdir -p /home/node/.openclaw

# Build openclaw.json from environment variables
node -e "
const fs = require('fs');
const e = process.env;
const configPath = '$CONFIG_PATH';

let config = {};
try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')) || {}; } catch (_) {}
if (typeof config !== 'object' || Array.isArray(config)) config = {};

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const merge = (t, s) => {
  for (const k of Object.keys(s)) {
    if (isObj(s[k]) && isObj(t[k])) merge(t[k], s[k]);
    else t[k] = s[k];
  }
  return t;
};

const essentials = {
  gateway: {
    mode: 'local',
    auth: {
      token: e.OPENCLAW_GATEWAY_TOKEN || ''
    },
    trustedProxies: (e.OPENCLAW_TRUSTED_PROXIES || '127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16')
      .split(',').map(s => s.trim()),
    controlUi: {
      allowedOrigins: e.OPENCLAW_ALLOWED_ORIGINS
        ? e.OPENCLAW_ALLOWED_ORIGINS.split(',').map(s => s.trim())
        : [],
      dangerouslyAllowHostHeaderOriginFallback: true,
      dangerouslyDisableDeviceAuth: e.OPENCLAW_DISABLE_DEVICE_AUTH === '1'
    }
  },
  browser: { noSandbox: true }
};

// Canonical providers: default base URL + API mode. Custom providers
// configured in AgentHotel (e.g. Hetzner) arrive as <SLUG>_API_KEY /
// <SLUG>_BASE_URL / <SLUG>_MODELS env triplets and become selectable
// providers too — anything OpenAI-compatible defaults to
// 'openai-completions'.
const KNOWN = {
  openai:     { baseUrl: 'https://api.openai.com/v1',                               api: 'openai-completions' },
  anthropic:  { baseUrl: 'https://api.anthropic.com',                                api: 'anthropic-messages' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1',                             api: 'openai-completions' },
  gemini:     { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',  api: 'openai-completions' },
};

const providers = {};
const primary = (e.OPENCLAW_MODEL_PRIMARY || '').trim();

for (const [envName, apiKey] of Object.entries(e)) {
  const m = envName.match(/^([A-Z0-9]+)_API_KEY$/);
  if (!m || !apiKey) continue;
  const name = m[1].toLowerCase();
  const slugUpper = m[1];
  // NOTE: string concatenation only — no template literals here; this
  // script runs inside a double-quoted shell string and any dollar-brace
  // or backtick sequence would be interpreted by the shell before node
  // ever sees it. (Yes, even inside JS comments — it's all one shell
  // string.)
  const baseUrl = e[slugUpper + '_BASE_URL'] || (KNOWN[name] && KNOWN[name].baseUrl);
  if (!baseUrl) continue; // no endpoint known — can't build a provider entry
  const providerEntry = { baseUrl, apiKey, api: (KNOWN[name] && KNOWN[name].api) || 'openai-completions' };
  const models = (e[slugUpper + '_MODELS'] || '').split(',').map(s => s.trim()).filter(Boolean);
  if (primary.startsWith(name + '/')) {
    const modelId = primary.slice(name.length + 1);
    if (!models.includes(modelId)) models.push(modelId);
  }
  if (models.length) providerEntry.models = models.map(id => ({ id, name: id }));
  providers[name] = providerEntry;
}

if (Object.keys(providers).length) essentials.models = { providers };

const fallbacks = (e.OPENCLAW_MODEL_FALLBACKS || '').split(',').map(s => s.trim()).filter(Boolean);
if (primary) {
  const model = { primary };
  if (fallbacks.length) model.fallbacks = fallbacks;
  essentials.agents = { defaults: { model } };
}

merge(config, essentials);

// Continuity defaults — seeded only when the operator hasn't decided already,
// so they survive a redeploy without clobbering hand-tuned config.
//
// OpenClaw's built-in reset policy is mode 'daily' at 04:00, which silently
// archives the transcript to <session>.jsonl.reset.<iso> and starts an empty
// one. For a panel agent that is meant to be a long-lived assistant that
// reads as amnesia every morning, so switch to an idle policy with a window
// long enough never to fire in practice (idleMinutes must be > 0).
if (!config.session || !config.session.reset) {
  config.session = Object.assign({}, config.session, {
    reset: { mode: 'idle', idleMinutes: 525600 }
  });
}

// active-memory injects relevant prior memory into prompt context; it ships
// disabled, which leaves a fresh session with no recall of earlier ones.
if (!config.plugins || !config.plugins.entries || !config.plugins.entries['active-memory']) {
  const plugins = Object.assign({}, config.plugins);
  plugins.entries = Object.assign({}, plugins.entries, { 'active-memory': { enabled: true, config: {} } });
  config.plugins = plugins;
}

config.meta = Object.assign({}, config.meta, { lastTouchedAt: new Date().toISOString() });
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('openclaw.json written successfully');

// OpenClaw's embedded agent runtime auto-enables the 'codex' harness when
// OpenAI auth is detected. The codex harness reads its own auth.json from
// codex-home instead of the OPENAI_API_KEY env var, so we must pre-seed it
// BEFORE the gateway starts (same pattern as clawclass bootstrap).
if (e.OPENAI_API_KEY) {
  const codexHomeDir = '/home/node/.openclaw/agents/main/agent/codex-home';
  fs.mkdirSync(codexHomeDir, { recursive: true });
  fs.writeFileSync(
    codexHomeDir + '/auth.json',
    JSON.stringify({ OPENAI_API_KEY: e.OPENAI_API_KEY }, null, 2)
  );
  console.log('codex-home/auth.json written successfully');
}
"

mkdir -p /home/node/.openclaw/agents/main/agent/codex-home
chown -R node:node /home/node/.openclaw
exec sudo -u node openclaw gateway --bind lan --port 18789

ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:latest
FROM ${OPENCLAW_IMAGE}

USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
    sudo build-essential \
    python3 python3-pip python3-venv python3-dev \
    git ripgrep curl wget ca-certificates \
    jq unzip zip openssh-client \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages uv \
    || (curl -LsSf https://astral.sh/uv/install.sh | sh)

ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
RUN node /app/node_modules/playwright-core/cli.js install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

ENV PATH=/home/node/.local/bin:$PATH
RUN mkdir -p /home/node/.local/bin /home/node/.cache /home/node/.openclaw /data /config \
    && chown -R node:node /home/node/.local /home/node/.cache /home/node/.openclaw

RUN echo 'node ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/node \
    && chmod 0440 /etc/sudoers.d/node

VOLUME ["/home/node/.openclaw", "/home/node/.cache", "/home/node/.local", "/data", "/config"]

EXPOSE 18789

COPY --chmod=755 <<'ENTRYPOINT' /entrypoint.sh
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

const PROVIDER_MAP = {
  openai:     { baseUrl: 'https://api.openai.com/v1',                               api: 'openai-completions',    keyEnv: 'OPENAI_API_KEY' },
  anthropic:  { baseUrl: 'https://api.anthropic.com',                                api: 'anthropic-messages',    keyEnv: 'ANTHROPIC_API_KEY' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1',                             api: 'openai-completions',    keyEnv: 'OPENROUTER_API_KEY' },
  gemini:     { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',  api: 'openai-completions',    keyEnv: 'GEMINI_API_KEY' },
};

const providers = {};
const primary = (e.OPENCLAW_MODEL_PRIMARY || '').trim();

for (const [name, conf] of Object.entries(PROVIDER_MAP)) {
  const key = e[conf.keyEnv];
  if (key) {
    const providerEntry = { baseUrl: conf.baseUrl, apiKey: key, api: conf.api };
    if (primary.startsWith(name + '/')) {
      const modelId = primary.slice(name.length + 1);
      providerEntry.models = [{ id: modelId, name: modelId }];
    }
    providers[name] = providerEntry;
  }
}

if (Object.keys(providers).length) essentials.models = { providers };

const fallbacks = (e.OPENCLAW_MODEL_FALLBACKS || '').split(',').map(s => s.trim()).filter(Boolean);
if (primary) {
  const model = { primary };
  if (fallbacks.length) model.fallbacks = fallbacks;
  essentials.agents = { defaults: { model } };
}

merge(config, essentials);
config.meta = Object.assign({}, config.meta, { lastTouchedAt: new Date().toISOString() });
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('openclaw.json written successfully');
"

chown node:node "$CONFIG_PATH"
exec sudo -u node openclaw gateway --bind lan --port 18789
ENTRYPOINT

ENTRYPOINT ["/entrypoint.sh"]

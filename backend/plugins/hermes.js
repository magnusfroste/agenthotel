const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || '/data/agenthotel.db');

function getProvider(name) {
  return db.prepare('SELECT apiKey, baseUrl FROM providers WHERE LOWER(name) = LOWER(?)').get(name);
}

// Provider name → base_url. Hermes auto-detects the provider from the base_url
// host (see _URL_TO_PROVIDER) and from it knows the model's context length and
// the correct API mode. We therefore ONLY set provider: auto + base_url + the
// bare model — no api_mode and no custom_providers (those triggered
// "Context length exceeded" / "session_id" bugs in v0.19.0).
const PROVIDER_BASE_URL = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  deepseek: 'https://api.deepseek.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1'
};

// API key env var per canonical provider name.
const PROVIDER_KEYS = {
  openai: { keyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL' },
  openrouter: { keyEnv: 'OPENROUTER_API_KEY' },
  anthropic: { keyEnv: 'ANTHROPIC_API_KEY' },
  gemini: { keyEnv: 'GEMINI_API_KEY' },
  deepseek: { keyEnv: 'DEEPSEEK_API_KEY' },
  groq: { keyEnv: 'GROQ_API_KEY' },
  xai: { keyEnv: 'XAI_API_KEY' },
  mistral: { keyEnv: 'MISTRAL_API_KEY' }
};

// Model-prefix → valid auth registry provider (auth.py PROVIDER_REGISTRY +
// provider plugins in v0.19.0). Anything unmapped falls back to `custom`
// (which resolves against the configured base_url).
const PROVIDER_REGISTRY_NAME = {
  openai: 'openai-api',
  openrouter: 'openrouter',
  anthropic: 'anthropic',
  gemini: 'gemini',
  zai: 'zai',
  deepseek: 'deepseek',
  xai: 'xai'
};

module.exports = {
  name: 'Hermes Agent',
  description: 'NousResearch Hermes Agent — multi-tool AI agent with MCP support',
  defaultImage: 'nousresearch/hermes-agent:latest',
  defaultPort: 9119,
  // Hermes sends reasoning.effort; models that predate it reject the request.
  // Declared here so lib/modelSelect.js can probe for it rather than relying
  // on a hardcoded model name being right on someone else's account.
  modelConfigKey: 'HERMES_MODEL',
  // The dashboard answers 302 (login redirect) when healthy — anything under
  // 500 means the app is up and talking.
  healthCheck: { type: 'http', path: '/', expectBelow: 500 },
  modelRequirements: { reasoning: { effort: 'low' } },
  fallbackModel: 'gpt-5.4',
  configFields: [
    { key: 'HERMES_MODEL', label: 'Model', type: 'text', default: 'openai/gpt-5.4', placeholder: 'provider/model (e.g. openai/gpt-5.4, openrouter/anthropic/claude-3.5-sonnet)' },
    { key: 'OPENAI_API_KEY', label: 'OpenAI API Key', type: 'password', required: false },
    { key: 'OPENAI_BASE_URL', label: 'OpenAI-compatible Base URL', type: 'text', required: false, placeholder: 'Only for custom/vLLM/Ollama endpoints' },
    { key: 'OPENROUTER_API_KEY', label: 'OpenRouter Key', type: 'password', required: false },
    { key: 'ANTHROPIC_API_KEY', label: 'Anthropic Key', type: 'password', required: false },
    { key: 'GEMINI_API_KEY', label: 'Gemini Key', type: 'password', required: false },
    { key: 'DEEPSEEK_API_KEY', label: 'DeepSeek Key', type: 'password', required: false },
    { key: 'GROQ_API_KEY', label: 'Groq Key', type: 'password', required: false }
  ],

  buildConfig({ name, domain, image, port, config }) {
    const autoConfig = { ...config };
    // Auto-inject provider credentials, mapped by provider NAME (not type).
    for (const [providerName, { keyEnv, baseUrlEnv }] of Object.entries(PROVIDER_KEYS)) {
      const row = getProvider(providerName);
      if (row) {
        if (!autoConfig[keyEnv] && row.apiKey) autoConfig[keyEnv] = row.apiKey;
        if (baseUrlEnv && !autoConfig[baseUrlEnv] && row.baseUrl) autoConfig[baseUrlEnv] = row.baseUrl;
      }
    }
    if (!autoConfig.HERMES_MODEL) autoConfig.HERMES_MODEL = 'openai/gpt-5.4';
    return autoConfig;
  },

  buildEnv(config) {
    // Newer Hermes image fails closed: a non-loopback dashboard needs an auth
    // provider. Use HTTP Basic Auth so the chat UI is reachable via Caddy.
    const user = config.HERMES_DASHBOARD_BASIC_AUTH_USERNAME || 'admin';
    const pass = config.HERMES_DASHBOARD_BASIC_AUTH_PASSWORD || (config.HERMES_DASHBOARD_PASSWORD || 'agenthotel');

    const env = [
      'HERMES_DASHBOARD=1',
      'HERMES_DASHBOARD_HOST=0.0.0.0',
      'HERMES_DASHBOARD_PORT=9119',
      'HERMES_DASHBOARD_TUI=1',
      `HERMES_DASHBOARD_BASIC_AUTH_USERNAME=${user}`,
      `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=${pass}`
    ];

    // HERMES_MODEL must be the BARE model name here (provider routing lives in
    // config.yaml; a prefixed value like "openai/gpt-5.4" triggers "Unknown
    // provider 'openai'" because hermes looks up "openai" as a provider name).
    if (config.HERMES_MODEL) {
      const bare = config.HERMES_MODEL.includes('/')
        ? config.HERMES_MODEL.split('/').slice(1).join('/')
        : config.HERMES_MODEL;
      env.push(`HERMES_MODEL=${bare}`);
    }

    const keys = [
      'OPENAI_API_KEY', 'OPENAI_BASE_URL',
      'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY',
      'DEEPSEEK_API_KEY', 'GROQ_API_KEY', 'XAI_API_KEY', 'MISTRAL_API_KEY'
    ];
    for (const key of keys) {
      if (config[key]) env.push(`${key}=${config[key]}`);
    }
    require('../lib/envPassthrough').appendUnknownEnv(env, config, [...keys, 'HERMES_MODEL']);
    return env;
  },

  // Generate a model: block for /opt/data/config.yaml.
  //
  // Critical (verified 2026-07-31 against v0.19.0, dashboard WS flow):
  // `provider: auto` + `base_url: api.openai.com` makes the CLI work but breaks
  // the dashboard/TUI gateway agent build — the gateway derives the provider
  // from the base_url host (agent/model_metadata.py _URL_TO_PROVIDER maps
  // api.openai.com → "openai") and "openai" is NOT a valid auth provider
  // (auth.py PROVIDER_REGISTRY: openai-api, openrouter, custom, anthropic,
  // gemini, zai, …), yielding "agent init failed: Unknown provider 'openai'".
  // The explicit registry name `openai-api` (API key from OPENAI_API_KEY, base
  // URL override from OPENAI_BASE_URL) works for BOTH CLI and dashboard.
  // Do NOT set api_mode or custom_providers — those triggered "Context length
  // exceeded" / "session_id" bugs in v0.19.0.
  generateConfig(config) {
    let providerIn = 'openai';
    let bareModel = 'gpt-5.4';
    if (config.HERMES_MODEL) {
      const parts = config.HERMES_MODEL.split('/');
      if (parts.length >= 2) { providerIn = parts[0]; bareModel = parts.slice(1).join('/'); }
      else bareModel = config.HERMES_MODEL;
    }

    // Resolve the base URL. Honour a user-provided OPENAI_BASE_URL for custom
    // OpenAI-compatible endpoints; otherwise use the canonical provider URL.
    let baseUrl;
    if (config.OPENAI_BASE_URL && (providerIn === 'openai' || !PROVIDER_BASE_URL[providerIn])) {
      baseUrl = config.OPENAI_BASE_URL;
    } else {
      baseUrl = PROVIDER_BASE_URL[providerIn] || config.OPENAI_BASE_URL || PROVIDER_BASE_URL.openai;
    }

    const provider = PROVIDER_REGISTRY_NAME[providerIn] || 'custom';

    return `model:
  provider: ${provider}
  default: ${bareModel}
  base_url: ${baseUrl}
`;
  }
};

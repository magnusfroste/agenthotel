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

// Split "provider/model" — except a model id may itself contain slashes, and
// may even repeat the provider's name: this endpoint serves
// "unsloth/Qwen3.8-Flash-Next-GGUF" from a provider named "unsloth". Splitting
// on the first slash then cannot tell a prefix from part of the id, and got it
// wrong in exactly that case, writing a model the server had never heard of.
//
// The operator's own model list for that provider settles it: prefer whichever
// candidate actually appears in <SLUG>_MODELS. With no list to consult, fall
// back to stripping one segment, which is right for canonical providers.
function splitModel(value, config) {
  const raw = (value || '').trim();
  if (!raw.includes('/')) return { providerIn: 'openai', model: raw };

  const providerIn = raw.slice(0, raw.indexOf('/'));
  const stripped = raw.slice(raw.indexOf('/') + 1);
  const slug = providerIn.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const listed = String((config && config[`${slug}_MODELS`]) || '')
    .split(',').map(m => m.trim()).filter(Boolean);

  if (listed.length) {
    if (listed.includes(raw)) return { providerIn, model: raw };
    if (listed.includes(stripped)) return { providerIn, model: stripped };
  }
  return { providerIn, model: stripped };
}

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
  // Deliberately NO extra probe parameters. An earlier version required
  // `reasoning: { effort: 'low' }`, inferred from a comment about what hermes
  // sends internally — but /chat/completions rejects that key at the top level
  // ("Unknown parameter: 'reasoning'"), so the probe failed EVERY OpenAI model
  // including gpt-5.6-luna, which hermes runs happily in production. It then
  // steered hermes to whichever provider merely tolerated the extra key, and
  // would have excluded a private endpoint for a reason that had nothing to do
  // with the model. Probing that a model exists and answers is the honest test
  // at this layer; which model reasons well is a choice, not a capability the
  // panel can detect from here.
  modelRequirements: {},
  // Hermes refuses to start on a model whose window is under this, and says so
  // itself: "has a context window of 8,192 tokens, which is below the minimum
  // 64,000 required by Hermes Agent". Its own prompt is ~23k, so the floor is
  // the agent's rule, not a consequence of prompt size. Declared here so the
  // panel can decline such a model instead of selecting one that cannot run.
  //
  // OpenClaw deliberately declares no floor: it never states one, and inventing
  // a number from an observed prompt size would repeat the mistake that made
  // hermes probe for a `reasoning` parameter it does not accept.
  minContextTokens: 64000,
  // How to hand this runtime a task and get its answer back, as argv so no
  // quoting of the message is required. -z is hermes's one-shot mode: it runs a
  // single turn and exits rather than opening a session.
  dispatch: (message) => ['hermes', '-z', message],
  fallbackModel: 'gpt-5.4',
  configFields: [
    { key: 'HERMES_MODEL', label: 'Model', type: 'text', default: 'openai/gpt-5.4', placeholder: 'provider/model (e.g. openai/gpt-5.4, openrouter/anthropic/claude-3.5-sonnet)' },
    // hermes warns on every start when TERMINAL_CWD is in the environment and
    // terminal.cwd is left at the non-explicit default ("." / "auto" / ""), so
    // an explicit path silences it — see hermes_cli/config.py. /opt/data is
    // also the better default in its own right: it is the agent's persistent
    // volume, where its work actually lives, rather than /opt/hermes where the
    // application happens to be installed.
    { key: 'HERMES_TERMINAL_CWD', label: 'Terminal working directory', type: 'text', default: '/opt/data', placeholder: 'Where the agent shell and terminal tools start' },
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

    // Deliberately NOT hijacking the OPENAI_* slot for a private provider any
    // more. That worked, but made the private endpoint the ONLY one hermes
    // could reach, since it overwrote the real OpenAI credentials. A private
    // endpoint belongs in custom_providers instead, where it appears in the
    // model picker under its own name and coexists with the hosted providers —
    // which is what the operator expected, and what OpenClaw already does.
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
      env.push(`HERMES_MODEL=${splitModel(config.HERMES_MODEL, config).model}`);
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
      const parsed = splitModel(config.HERMES_MODEL, config);
      providerIn = parsed.providerIn;
      bareModel = parsed.model;
    }

    // Resolve the base URL. Honour a user-provided OPENAI_BASE_URL for custom
    // OpenAI-compatible endpoints; otherwise use the canonical provider URL.
    let baseUrl;
    if (config.OPENAI_BASE_URL && (providerIn === 'openai' || !PROVIDER_BASE_URL[providerIn])) {
      baseUrl = config.OPENAI_BASE_URL;
    } else {
      baseUrl = PROVIDER_BASE_URL[providerIn] || config.OPENAI_BASE_URL || PROVIDER_BASE_URL.openai;
    }

    // 'custom' is not a usable provider here: it is absent from hermes's model
    // picker and its auth registry, so a private endpoint configured that way
    // answers every request with "401: Invalid token payload" no matter which
    // key is injected. Every provider the panel supports is OpenAI-compatible
    // — providerEnv routes unknown ones through the OPENAI_* slots — so an
    // unrecognised name is an openai-api endpoint with a different base URL,
    // which resolves auth from OPENAI_API_KEY and honours the override.
    // A private, OpenAI-compatible endpoint must NOT be pinned here. hermes
    // resolves those from OPENAI_BASE_URL + OPENAI_API_KEY + a bare
    // HERMES_MODEL entirely on its own — that is how the earlier Easypanel
    // deployment of this same image worked against this same endpoint, with no
    // config.yaml block at all. Patching one in fights that resolution: it
    // pinned `provider: custom`, which is absent from hermes's auth registry
    // and answered every request with "401: Invalid token payload".
    //
    // The patch exists for the canonical hosted providers, where the image
    // bakes a wrong default. Returning null for anything else leaves hermes to
    // configure itself from the environment, which is what it does best.
    // A non-canonical provider is a custom endpoint. Hermes has a first-class
    // slot for those — custom_providers in config.yaml — which is the entry the
    // model picker shows as "Custom endpoint" when it is empty. Filling it in
    // makes the endpoint appear under its own name, keyed to the env var the
    // panel already injects, without displacing the hosted providers.
    const canonical = PROVIDER_REGISTRY_NAME[providerIn];
    if (!canonical) {
      const slug = providerIn.replace(/[^a-z0-9]/g, '').toUpperCase();
      const customBaseUrl = config[`${slug}_BASE_URL`];
      // No base URL means nothing to point at; leave hermes to its own
      // environment resolution rather than writing a broken entry.
      if (!customBaseUrl) return null;
      return `model:
  provider: ${providerIn}
  default: ${bareModel}
custom_providers:
- name: ${providerIn}
  base_url: ${customBaseUrl}
  key_env: ${slug}_API_KEY
  model: ${bareModel}
`;
    }
    const provider = canonical;

    return `model:
  provider: ${provider}
  default: ${bareModel}
  base_url: ${baseUrl}
`;
  }
};

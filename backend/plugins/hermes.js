const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || '/data/agentpanel.db');

function getProvider(name) {
  return db.prepare('SELECT apiKey, baseUrl FROM providers WHERE LOWER(name) = LOWER(?)').get(name);
}

// Provider name → (keyEnv, defaultBaseUrl). Built-in providers have endpoints
// baked into Hermes; we only need the API key + a HERMES_MODEL prefixed by the
// provider name (e.g. "openai/gpt-4o", "anthropic/claude-3-5-sonnet").
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

module.exports = {
  name: 'Hermes Agent',
  description: 'NousResearch Hermes Agent — multi-tool AI agent with MCP support',
  defaultImage: 'nousresearch/hermes-agent:latest',
  defaultPort: 9119,
  configFields: [
    { key: 'HERMES_MODEL', label: 'Model', type: 'text', default: 'openai/gpt-4o', placeholder: 'provider/model (e.g. openai/gpt-4o, anthropic/claude-3-5-sonnet)' },
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

    // Auto-inject provider credentials from the Providers table.
    // IMPORTANT: match on provider NAME (not type) so the right key wins.
    for (const [providerName, { keyEnv, baseUrlEnv }] of Object.entries(PROVIDER_KEYS)) {
      const row = getProvider(providerName);
      if (row) {
        if (!autoConfig[keyEnv] && row.apiKey) autoConfig[keyEnv] = row.apiKey;
        if (baseUrlEnv && !autoConfig[baseUrlEnv] && row.baseUrl) autoConfig[baseUrlEnv] = row.baseUrl;
      }
    }

    // Sensible default model if none specified.
    if (!autoConfig.HERMES_MODEL) autoConfig.HERMES_MODEL = 'openai/gpt-4o';

    return autoConfig;
  },

  buildEnv(config) {
    // The newer Hermes image "fails closed": a non-loopback dashboard requires
    // an auth provider. Use HTTP Basic Auth so the chat UI is reachable through
    // Caddy without an extra OAuth setup. Credentials surface in the portal.
    const user = config.HERMES_DASHBOARD_BASIC_AUTH_USERNAME || 'admin';
    const pass = config.HERMES_DASHBOARD_BASIC_AUTH_PASSWORD || (config.HERMES_DASHBOARD_PASSWORD || 'agentpanel');

    const env = [
      'HERMES_DASHBOARD=1',
      'HERMES_DASHBOARD_HOST=0.0.0.0',
      'HERMES_DASHBOARD_PORT=9119',
      'HERMES_DASHBOARD_TUI=1',
      `HERMES_DASHBOARD_BASIC_AUTH_USERNAME=${user}`,
      `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=${pass}`
    ];

    if (config.HERMES_MODEL) env.push(`HERMES_MODEL=${config.HERMES_MODEL}`);

    // Forward every recognized provider key + base url. Only those set (by the
    // user or auto-injected) are emitted.
    const keys = [
      'OPENAI_API_KEY', 'OPENAI_BASE_URL',
      'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY',
      'DEEPSEEK_API_KEY', 'GROQ_API_KEY', 'XAI_API_KEY', 'MISTRAL_API_KEY'
    ];
    for (const key of keys) {
      if (config[key]) env.push(`${key}=${config[key]}`);
    }
    return env;
  }
};

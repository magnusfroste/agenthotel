const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || '/data/agenthotel.db');

function getProvider(name) {
  return db.prepare('SELECT apiKey, baseUrl FROM providers WHERE LOWER(name) = LOWER(?)').get(name);
}

module.exports = {
  name: 'OpenClaw',
  description: 'OpenClaw — persistent AI agent with gateway, tools and browser',
  defaultImage: 'ghcr.io/openclaw/openclaw:latest',
  defaultPort: 18789,
  // The entrypoint starts as root but sudo's down to node for the gateway, so the
  // state volumes are owned by node. Exec'ing a terminal as root would litter them
  // with root-owned files that OpenClaw can no longer write.
  terminalUser: 'node',
  configFields: [
    { key: 'OPENCLAW_GATEWAY_TOKEN', label: 'Gateway Token', type: 'password', required: false },
    { key: 'OPENCLAW_MODEL_PRIMARY', label: 'Primary Model', type: 'text', default: 'openai/gpt-5.3' },
    { key: 'OPENAI_API_KEY', label: 'OpenAI Key', type: 'password', required: false },
    { key: 'OPENAI_BASE_URL', label: 'OpenAI Base URL', type: 'text', required: false },
    { key: 'ANTHROPIC_API_KEY', label: 'Anthropic Key', type: 'password', required: false },
    { key: 'OPENROUTER_API_KEY', label: 'OpenRouter Key', type: 'password', required: false },
    { key: 'ZAI_API_KEY', label: 'Z.ai Key', type: 'password', required: false },
    { key: 'OPENCLAW_ZAI_BASE_URL', label: 'Z.ai Base URL Override', type: 'text', required: false },
    { key: 'OPENCLAW_MODEL_FALLBACKS', label: 'Fallback Models (comma-sep)', type: 'text', required: false }
  ],

  buildConfig({ name, domain, image, port, config }) {
    const crypto = require('crypto');
    const autoToken = config.OPENCLAW_GATEWAY_TOKEN || crypto.randomBytes(32).toString('hex');
    
    const autoConfig = { ...config, domain, OPENCLAW_GATEWAY_TOKEN: autoToken };
    
    const openai = getProvider('OpenAI');
    if (!autoConfig.OPENAI_API_KEY && openai?.apiKey) autoConfig.OPENAI_API_KEY = openai.apiKey;
    if (!autoConfig.OPENAI_BASE_URL && openai?.baseUrl) autoConfig.OPENAI_BASE_URL = openai.baseUrl;
    
    const anthropic = getProvider('Anthropic');
    if (!autoConfig.ANTHROPIC_API_KEY && anthropic?.apiKey) autoConfig.ANTHROPIC_API_KEY = anthropic.apiKey;
    
    const openrouter = getProvider('OpenRouter');
    if (!autoConfig.OPENROUTER_API_KEY && openrouter?.apiKey) autoConfig.OPENROUTER_API_KEY = openrouter.apiKey;
    
    const zai = getProvider('ZAI');
    if (!autoConfig.ZAI_API_KEY && zai?.apiKey) autoConfig.ZAI_API_KEY = zai.apiKey;
    if (!autoConfig.OPENCLAW_ZAI_BASE_URL && zai?.baseUrl) autoConfig.OPENCLAW_ZAI_BASE_URL = zai.baseUrl;
    
    return autoConfig;
  },

  buildEnv(config) {
    const env = [
      'OPENCLAW_GATEWAY_MODE=local',
      'HOME=/home/node',
      'TERM=xterm-256color',
      'OPENCLAW_STATE_DIR=/home/node/.openclaw',
      'OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json',
      'OPENCLAW_DISABLE_BONJOUR=1',
      'OPENCLAW_DISABLE_DEVICE_AUTH=1'
    ];
    const keys = [
      'OPENCLAW_GATEWAY_TOKEN', 'OPENCLAW_MODEL_PRIMARY',
      'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY',
      'ZAI_API_KEY', 'OPENCLAW_ZAI_BASE_URL', 'OPENCLAW_MODEL_FALLBACKS'
    ];
    for (const key of keys) {
      if (config[key]) env.push(`${key}=${config[key]}`);
    }
    require('../lib/envPassthrough').appendUnknownEnv(env, config, keys);
    if (config.domain) {
      env.push(`OPENCLAW_ALLOWED_ORIGINS=https://${config.domain}`);
      env.push('OPENCLAW_TRUSTED_PROXIES=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16');
    }
    return env;
  }
};

module.exports = {
  name: 'OpenClaw',
  description: 'OpenClaw — persistent AI agent with gateway, tools and browser',
  defaultImage: 'ghcr.io/openclaw/openclaw:latest',
  defaultPort: 18789,
  configFields: [
    { key: 'OPENCLAW_GATEWAY_TOKEN', label: 'Gateway Token', type: 'password', required: false },
    { key: 'OPENCLAW_MODEL_PRIMARY', label: 'Primary Model', type: 'text', default: 'openai/gpt-4.1' },
    { key: 'OPENAI_API_KEY', label: 'OpenAI Key', type: 'password', required: false },
    { key: 'ANTHROPIC_API_KEY', label: 'Anthropic Key', type: 'password', required: false },
    { key: 'OPENROUTER_API_KEY', label: 'OpenRouter Key', type: 'password', required: false },
    { key: 'ZAI_API_KEY', label: 'Z.ai Key', type: 'password', required: false },
    { key: 'OPENCLAW_ZAI_BASE_URL', label: 'Z.ai Base URL Override', type: 'text', required: false },
    { key: 'OPENCLAW_MODEL_FALLBACKS', label: 'Fallback Models (comma-sep)', type: 'text', required: false }
  ],

  buildConfig({ name, domain, image, port, config }) {
    const crypto = require('crypto');
    const autoToken = config.OPENCLAW_GATEWAY_TOKEN || crypto.randomBytes(32).toString('hex');
    return { ...config, domain, OPENCLAW_GATEWAY_TOKEN: autoToken };
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
      'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY',
      'ZAI_API_KEY', 'OPENCLAW_ZAI_BASE_URL', 'OPENCLAW_MODEL_FALLBACKS'
    ];
    for (const key of keys) {
      if (config[key]) env.push(`${key}=${config[key]}`);
    }
    if (config.domain) {
      env.push(`OPENCLAW_ALLOWED_ORIGINS=https://${config.domain}`);
      env.push('OPENCLAW_TRUSTED_PROXIES=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16');
    }
    return env;
  }
};

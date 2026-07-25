const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || '/data/agentpanel.db');

function getProvider(name) {
  return db.prepare('SELECT apiKey, baseUrl FROM providers WHERE LOWER(name) = LOWER(?)').get(name);
}

module.exports = {
  name: 'Hermes Agent',
  description: 'NousResearch Hermes Agent — multi-tool AI agent with MCP support',
  defaultImage: 'nousresearch/hermes-agent:latest',
  defaultPort: 9119,
  configFields: [
    { key: 'OPENAI_API_KEY', label: 'OpenAI API Key', type: 'password', required: false },
    { key: 'OPENAI_BASE_URL', label: 'Custom Base URL', type: 'text', required: false },
    { key: 'HERMES_MODEL', label: 'Model', type: 'text', default: 'openai/gpt-5.4' },
    { key: 'OPENROUTER_API_KEY', label: 'OpenRouter Key', type: 'password', required: false },
    { key: 'ANTHROPIC_API_KEY', label: 'Anthropic Key', type: 'password', required: false },
    { key: 'GEMINI_API_KEY', label: 'Gemini Key', type: 'password', required: false },
    { key: 'DEEPSEEK_API_KEY', label: 'DeepSeek Key', type: 'password', required: false },
    { key: 'GROQ_API_KEY', label: 'Groq Key', type: 'password', required: false }
  ],

  buildConfig({ name, domain, image, port, config }) {
    const autoConfig = { ...config };
    
    const openai = getProvider('OpenAI');
    if (!autoConfig.OPENAI_API_KEY && openai?.apiKey) autoConfig.OPENAI_API_KEY = openai.apiKey;
    if (!autoConfig.OPENAI_BASE_URL && openai?.baseUrl) autoConfig.OPENAI_BASE_URL = openai.baseUrl;
    
    const openrouter = getProvider('OpenRouter');
    if (!autoConfig.OPENROUTER_API_KEY && openrouter?.apiKey) autoConfig.OPENROUTER_API_KEY = openrouter.apiKey;
    
    const anthropic = getProvider('Anthropic');
    if (!autoConfig.ANTHROPIC_API_KEY && anthropic?.apiKey) autoConfig.ANTHROPIC_API_KEY = anthropic.apiKey;
    
    const gemini = getProvider('Gemini');
    if (!autoConfig.GEMINI_API_KEY && gemini?.apiKey) autoConfig.GEMINI_API_KEY = gemini.apiKey;
    
    const deepseek = getProvider('DeepSeek');
    if (!autoConfig.DEEPSEEK_API_KEY && deepseek?.apiKey) autoConfig.DEEPSEEK_API_KEY = deepseek.apiKey;
    
    const groq = getProvider('Groq');
    if (!autoConfig.GROQ_API_KEY && groq?.apiKey) autoConfig.GROQ_API_KEY = groq.apiKey;
    
    return autoConfig;
  },

  buildEnv(config) {
    const env = [
      'HERMES_DASHBOARD=1',
      'HERMES_DASHBOARD_BASIC_AUTH_USERNAME=admin',
      `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=${config.HERMES_DASHBOARD_PASSWORD || 'agentpanel'}`
    ];
    const keys = [
      'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'HERMES_MODEL',
      'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY',
      'DEEPSEEK_API_KEY', 'GROQ_API_KEY', 'XAI_API_KEY', 'MISTRAL_API_KEY'
    ];
    for (const key of keys) {
      if (config[key]) env.push(`${key}=${config[key]}`);
    }
    return env;
  }
};

module.exports = {
  name: 'Hermes Agent',
  description: 'NousResearch Hermes Agent — multi-tool AI agent with MCP support',
  defaultImage: 'nousresearch/hermes-agent:latest',
  defaultPort: 3000,
  configFields: [
    { key: 'OPENAI_API_KEY', label: 'OpenAI API Key', type: 'password', required: true },
    { key: 'OPENAI_BASE_URL', label: 'Custom Base URL', type: 'text', required: false },
    { key: 'HERMES_MODEL', label: 'Model', type: 'text', default: 'openai/gpt-4.1' },
    { key: 'OPENROUTER_API_KEY', label: 'OpenRouter Key', type: 'password', required: false },
    { key: 'ANTHROPIC_API_KEY', label: 'Anthropic Key', type: 'password', required: false },
    { key: 'GEMINI_API_KEY', label: 'Gemini Key', type: 'password', required: false },
    { key: 'DEEPSEEK_API_KEY', label: 'DeepSeek Key', type: 'password', required: false },
    { key: 'GROQ_API_KEY', label: 'Groq Key', type: 'password', required: false }
  ],

  buildConfig({ name, domain, image, port, config }) {
    return { ...config };
  },

  buildEnv(config) {
    const env = [];
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

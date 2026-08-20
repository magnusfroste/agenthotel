module.exports = {
  name: 'Odysseus',
  description: 'Self-hosted AI workspace — chat, agents, deep research, memory',
  defaultImage: 'odysseus:latest',
  defaultPort: 7000,
  // uvicorn answers 302 to /login when healthy.
  healthCheck: { type: 'http', path: '/', expectBelow: 500 },
  configFields: [
    { key: 'OPENAI_API_KEY', label: 'OpenAI API Key', type: 'password', required: false },
    { key: 'LLM_HOST', label: 'LLM Host', type: 'text', required: false },
    { key: 'AUTH_ENABLED', label: 'Auth Enabled', type: 'select', options: ['true', 'false'], default: 'true' },
    // setup.py seeds the admin from BOTH env vars; without the username it fell
    // back to a generated password nobody could read. Both are sent through.
    { key: 'ODYSSEUS_ADMIN_USER', label: 'Admin Username', type: 'text', default: 'admin' },
    { key: 'ODYSSEUS_ADMIN_PASSWORD', label: 'Admin Password', type: 'password', required: true }
  ],

  buildConfig({ name, domain, image, port, config }) {
    return { ...config };
  },

  buildEnv(config) {
    const env = [
      'APP_BIND=0.0.0.0',
      'APP_PORT=7000',
      'CHROMADB_HOST=chromadb',
      'CHROMADB_PORT=8000',
      'SEARXNG_INSTANCE=http://searxng:8080'
    ];
    const keys = ['OPENAI_API_KEY', 'LLM_HOST', 'AUTH_ENABLED', 'ODYSSEUS_ADMIN_USER', 'ODYSSEUS_ADMIN_PASSWORD'];
    for (const key of keys) {
      if (config[key]) env.push(`${key}=${config[key]}`);
    }
    require('../lib/envPassthrough').appendUnknownEnv(env, config, keys);
    return env;
  }
};

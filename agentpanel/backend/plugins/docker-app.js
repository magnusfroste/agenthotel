module.exports = {
  name: 'Docker App',
  description: 'Any Docker image — generic app deployment',
  defaultImage: '',
  defaultPort: 80,
  configFields: [
    { key: 'IMAGE', label: 'Docker Image', type: 'text', required: true },
    { key: 'PORT', label: 'Container Port', type: 'number', default: 80 },
    { key: 'CUSTOM_ENV', label: 'Extra Env (KEY=VALUE per line)', type: 'textarea', required: false }
  ],

  buildConfig({ name, domain, image, port, config }) {
    return { ...config };
  },

  buildEnv(config) {
    const env = [];
    if (config.CUSTOM_ENV) {
      const lines = config.CUSTOM_ENV.split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) env.push(line);
    }
    return env;
  }
};

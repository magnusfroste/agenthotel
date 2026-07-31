module.exports = {
  name: 'Docker App',
  description: 'Any Docker image — generic app deployment',
  defaultImage: '',
  defaultPort: 80,
  configFields: [
    { key: 'IMAGE', label: 'Docker Image', type: 'text', required: true },
    { key: 'PORT', label: 'Container Port', type: 'number', default: 80 },
    { key: 'VOLUMES', label: 'Volumes (host:container per line)', type: 'textarea', required: false },
    { key: 'CUSTOM_ENV', label: 'Extra Env (KEY=VALUE per line)', type: 'textarea', required: false }
  ],

  buildConfig({ name, domain, image, port, config }) {
    const result = { ...config };
    // Parse the VOLUMES textarea ("/host:/container[:ro]" per line) into the
    // volumes array that deployAgent consumes.
    if (typeof result.VOLUMES === 'string' && result.VOLUMES.trim()) {
      result.volumes = result.VOLUMES.split('\n')
        .map(l => l.trim())
        .filter(l => l && l.includes(':'));
    }
    return result;
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

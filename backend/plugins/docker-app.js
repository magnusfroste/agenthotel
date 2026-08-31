module.exports = {
  name: 'Docker App',
  description: 'Any Docker image — generic app deployment',
  defaultImage: '',
  // Hosts arbitrary images, so it is not handed provider credentials
  // unless the guest opts in with INJECT_PROVIDER_ENV.
  providerCredentials: 'optional',
  defaultPort: 80,
  configFields: [
    { key: 'IMAGE', label: 'Docker Image', type: 'text', required: true },
    { key: 'PORT', label: 'Container Port', type: 'number', default: 80 },
    { key: 'VOLUMES', label: 'Volumes (host:container per line)', type: 'textarea', required: false },
    { key: 'CUSTOM_ENV', label: 'Extra Env (KEY=VALUE per line)', type: 'textarea', required: false },
    { key: 'HEALTHCHECK_PATH', label: 'Health check path (e.g. /)', type: 'text', required: false },
    { key: 'INJECT_PROVIDER_ENV', label: 'Inject provider API keys (true/false)', type: 'text', required: false }
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
    // Everything else in the config is environment too — provider credentials
    // injected by the panel, and anything set later with set_agent_env. Without
    // this they were stored and silently dropped at container creation, so a
    // Docker App guest never saw the OPENAI_API_KEY the manual promised it.
    require('../lib/envPassthrough').appendUnknownEnv(env, config, ['IMAGE', 'PORT', 'VOLUMES']);
    return env;
  }
};

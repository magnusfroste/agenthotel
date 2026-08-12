// Pass through UPPER_SNAKE config keys a plugin doesn't explicitly know
// about — e.g. provider slug vars (HERTZNER_API_KEY, HERTZNER_BASE_URL)
// injected by injectProviderEnv. Plugins that whitelist their env keys
// would otherwise silently drop injected provider credentials.
const INTERNAL_KEYS = new Set(['domain', 'volumes', 'CUSTOM_ENV', 'MEMORY_LIMIT_MB', 'CPU_LIMIT']);

function appendUnknownEnv(env, config, knownKeys) {
  const known = new Set(knownKeys);
  for (const [key, value] of Object.entries(config || {})) {
    if (known.has(key) || INTERNAL_KEYS.has(key)) continue;
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    if (!value) continue;
    env.push(`${key}=${value}`);
  }
  return env;
}

module.exports = { appendUnknownEnv };

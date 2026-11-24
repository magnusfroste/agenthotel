// Pass through config keys a plugin doesn't explicitly know about — e.g.
// provider slug vars (HERTZNER_API_KEY, HERTZNER_BASE_URL) injected by
// injectProviderEnv. Plugins that whitelist their env keys would otherwise
// silently drop injected provider credentials.
//
// A key starts with a capital letter and may hold lower case after it
// (2026-11-24). ZeroClaw's settings are ZEROCLAW_<path>, with the config
// path in lower case (ZEROCLAW_gateway__require_pairing); with UPPER_SNAKE
// only, every one of them was stored, shown on the Environment tab and never
// given to the container, so the ZeroClaw template's settings did nothing.
// The panel's own config keys (domain, volumes) start in lower case and stay
// out.
const INTERNAL_KEYS = new Set(['domain', 'volumes', 'CUSTOM_ENV', 'MEMORY_LIMIT_MB', 'CPU_LIMIT', 'CONTAINER_RUNTIME']);

const ENV_KEY_RE = /^[A-Z][A-Za-z0-9_]*$/;

function appendUnknownEnv(env, config, knownKeys) {
  const known = new Set(knownKeys);
  for (const [key, value] of Object.entries(config || {})) {
    if (known.has(key) || INTERNAL_KEYS.has(key)) continue;
    if (!ENV_KEY_RE.test(key)) continue;
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    if (!value) continue;
    env.push(`${key}=${value}`);
  }
  return env;
}

module.exports = { appendUnknownEnv, ENV_KEY_RE };

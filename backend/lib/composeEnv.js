// The .env a compose stack is started with.
//
// INJECT_PROVIDER_ENV=true is the documented way for a compose guest to receive
// the operator's provider keys. injectProviderEnv() put them into the agent's
// config — and both compose plugins then wrote only COMPOSE_ENV to the .env,
// so the keys never reached a single service (review, 2026-09-30). One writer
// for both plugins now, so they cannot drift apart again.

// The keys provider injection adds, and nothing else from the agent's config.
const PROVIDER_KEY = /^[A-Z][A-Z0-9]*_(API_KEY|BASE_URL|MODELS)$/;

const optedIn = (config) => /^(1|true|yes)$/i.test(String(config.INJECT_PROVIDER_ENV || '').trim());

// A value compose reads back exactly as written. Plain when it is safe to be,
// otherwise double-quoted with the few characters that matter escaped. A
// newline is refused outright: in a .env it silently starts another variable.
function envLine(key, value) {
  const v = String(value);
  if (/[\r\n]/.test(v)) throw new Error(`${key} contains a line break and cannot be written to a .env`);
  if (/^[A-Za-z0-9._\-\/:+=@,]*$/.test(v)) return `${key}=${v}`;
  return `${key}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`;
}

// COMPOSE_ENV as the operator wrote it, then — if they opted in — the provider
// keys it does not already set. What the operator wrote always wins: injection
// fills gaps, never overrides.
function buildComposeEnv(config) {
  const written = String(config.COMPOSE_ENV || '');
  if (!optedIn(config)) return written;

  const already = new Set(
    written.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && l.includes('='))
      .map(l => l.replace(/^export\s+/, '').split('=')[0].trim())
  );
  const added = Object.keys(config)
    .filter(k => PROVIDER_KEY.test(k) && !already.has(k) && config[k] !== undefined && config[k] !== '')
    .sort()
    .map(k => envLine(k, config[k]));
  if (!added.length) return written;

  const head = written && !written.endsWith('\n') ? written + '\n' : written;
  return head + '# Injected by AgentHotel from Providers (INJECT_PROVIDER_ENV)\n' + added.join('\n') + '\n';
}

module.exports = { buildComposeEnv, envLine, PROVIDER_KEY };

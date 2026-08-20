// Shared provider env injection for agent creation (server.js + mcp.js).
//
// Auto-inject API keys from providers, mapped by provider NAME (not type).
// Several providers share the "openai" protocol type, so matching on type
// would make OpenRouter's key clobber OpenAI's. Each canonical provider
// maps to its own env var; custom OpenAI-compatible providers (unknown
// name) fall back to the OPENAI_API_KEY/OPENAI_BASE_URL slots.
const PROVIDER_ENV_MAP = {
  openai: { key: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
  openrouter: { key: 'OPENROUTER_API_KEY' },
  anthropic: { key: 'ANTHROPIC_API_KEY' },
  gemini: { key: 'GEMINI_API_KEY' },
  deepseek: { key: 'DEEPSEEK_API_KEY' },
  groq: { key: 'GROQ_API_KEY' },
  xai: { key: 'XAI_API_KEY' },
  mistral: { key: 'MISTRAL_API_KEY' }
};

const slugify = (name) => (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Returns a new config object with provider env vars and default models
// injected. Never mutates the input.
async function injectProviderEnv(db, config, plugin) {
  const finalConfig = { ...(config || {}) };

  const providers = db.prepare('SELECT name, type, apiKey, baseUrl, models FROM providers').all();
  // Canonical providers must be handled before custom OpenAI-compatible ones.
  // Both compete for the OPENAI_* slots on a first-writer-wins basis, so with
  // plain table order a custom provider that happened to be created earlier
  // (e.g. DGX1 before OpenAI) would hijack the real OpenAI provider's slots.
  const ordered = [...providers].sort((a, b) => {
    const rank = (p) => (PROVIDER_ENV_MAP[slugify(p.name)] ? 0 : 1);
    return rank(a) - rank(b);
  });
  for (const provider of ordered) {
    const slug = slugify(provider.name);
    // Every provider also gets its own slug-based env vars (e.g. Hetzner →
    // HETZNER_API_KEY / HERTZNER_BASE_URL), so providers that don't map to a
    // canonical slot are still visible inside agents — previously a custom
    // OpenAI-compatible provider silently injected nothing whenever a real
    // OpenAI provider had already claimed the OPENAI_* slots.
    const slugUpper = slug.toUpperCase();
    if (slugUpper) {
      if (!finalConfig[`${slugUpper}_API_KEY`] && provider.apiKey) {
        finalConfig[`${slugUpper}_API_KEY`] = provider.apiKey;
      }
      if (!finalConfig[`${slugUpper}_BASE_URL`] && provider.baseUrl) {
        finalConfig[`${slugUpper}_BASE_URL`] = provider.baseUrl;
      }
      if (!finalConfig[`${slugUpper}_MODELS`] && provider.models) {
        try {
          const list = JSON.parse(provider.models);
          if (Array.isArray(list) && list.length) finalConfig[`${slugUpper}_MODELS`] = list.join(',');
        } catch (_) {}
      }
    }
    const mapping = PROVIDER_ENV_MAP[slug];
    if (mapping) {
      if (!finalConfig[mapping.key] && provider.apiKey) finalConfig[mapping.key] = provider.apiKey;
      if (mapping.baseUrl && !finalConfig[mapping.baseUrl] && provider.baseUrl) {
        finalConfig[mapping.baseUrl] = provider.baseUrl;
      }
    } else if (provider.type === 'openai' && provider.apiKey) {
      // Custom OpenAI-compatible provider (e.g. self-hosted vLLM, DGX1).
      // Use the OPENAI slots only if a real OpenAI provider hasn't claimed them.
      if (!finalConfig.OPENAI_API_KEY) finalConfig.OPENAI_API_KEY = provider.apiKey;
      if (!finalConfig.OPENAI_BASE_URL && provider.baseUrl) finalConfig.OPENAI_BASE_URL = provider.baseUrl;
    }
  }

  // Set default model if not specified. Hermes needs a model that accepts
  // reasoning.effort; gpt-5.4 works, whereas gpt-4o rejects it.
  // Which model to default to is a question only the runtime and the
  // operator's provider can answer together: the runtime knows what it sends,
  // the provider knows what it has. A hardcoded literal guesses at both and
  // was wrong on this account twice over — first naming a model that did not
  // exist, then one that existed but was too old for the request shape.
  //
  // So the runtime declares its requirements (plugin.modelRequirements) and
  // lib/modelSelect.js probes the operator's configured models with exactly
  // those parameters, caching each verdict. Runtimes with no declaration
  // (odysseus, docker-app, compose) never reach this and are unaffected.
  const modelKey = plugin && plugin.modelConfigKey;
  if (modelKey && !finalConfig[modelKey]) {
    const { selectModel } = require('./modelSelect');
    const candidates = [
      { envKey: 'OPENAI_API_KEY', name: 'OpenAI', prefix: 'openai' },
      { envKey: 'OPENROUTER_API_KEY', name: 'OpenRouter', prefix: 'openrouter' }
    ];
    for (const { envKey, name, prefix } of candidates) {
      if (!finalConfig[envKey]) continue;
      const row = providers.find(p => (p.name || '').toLowerCase() === name.toLowerCase());
      if (!row) continue;
      let chosen = null;
      try {
        chosen = await selectModel(db, row, plugin.name || modelKey, plugin.modelRequirements);
      } catch (err) {
        console.warn(`[ProviderEnv] Model selection failed for ${name}: ${err.message}`);
      }
      // Nothing passed (or probing was not possible): fall back to the
      // runtime's literal so a deploy still produces a usable config rather
      // than an agent with no model at all.
      finalConfig[modelKey] = `${prefix}/${chosen || plugin.fallbackModel}`;
      if (!chosen) {
        console.warn(`[ProviderEnv] No configured ${name} model satisfied ${plugin.name || modelKey}; using ${plugin.fallbackModel}`);
      }
      break;
    }
  }

  return finalConfig;
}

module.exports = { injectProviderEnv, PROVIDER_ENV_MAP };

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

// Returns a new config object with provider env vars and default models
// injected. Never mutates the input.
function injectProviderEnv(db, config) {
  const finalConfig = { ...(config || {}) };

  const providers = db.prepare('SELECT name, type, apiKey, baseUrl FROM providers').all();
  for (const provider of providers) {
    const slug = provider.name.toLowerCase().replace(/[^a-z0-9]/g, '');
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
  if (!finalConfig.OPENCLAW_MODEL_PRIMARY && !finalConfig.HERMES_MODEL) {
    if (finalConfig.OPENAI_API_KEY) {
      finalConfig.OPENCLAW_MODEL_PRIMARY = 'openai/gpt-5.3';
      finalConfig.HERMES_MODEL = 'openai/gpt-5.4';
    } else if (finalConfig.OPENROUTER_API_KEY) {
      finalConfig.OPENCLAW_MODEL_PRIMARY = 'openrouter/openai/gpt-5.3';
      finalConfig.HERMES_MODEL = 'openrouter/openai/gpt-5.4';
    }
  }

  return finalConfig;
}

module.exports = { injectProviderEnv, PROVIDER_ENV_MAP };

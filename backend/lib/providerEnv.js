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
// The operator's pick for new agents, when it can be honoured.
//
// default_provider only chose the provider; the model under it was still
// whichever passed the probe first, in list order. With gpt-4 listed first
// under OpenAI, every new agent got gpt-4 — the operator had no way to say
// "dgxspark/glm-5.3-flash" short of typing it into each deploy form
// (2026-10-02). A whole id names both, so it is taken as written: no probe,
// because choosing it was the operator's test.
//
// Honoured only when its provider is configured with a key, since an id whose
// prefix names nothing deploys an agent that cannot start. Then the reason is
// returned instead, for the caller to log.
function pinnedDefaultModel(value, providers) {
  const id = String(value || '').trim();
  if (!id) return { model: null, reason: null };
  const at = id.indexOf('/');
  if (at < 1 || at === id.length - 1) {
    return { model: null, reason: `Default model "${id}" is not written as provider/model` };
  }
  const prefix = id.slice(0, at);
  const owner = (providers || []).find(p => slugify(p.name) === prefix && p.apiKey);
  if (!owner) {
    return { model: null, reason: `Default model "${id}" names provider "${prefix}", which has no configured key` };
  }
  return { model: id, reason: null };
}

async function injectProviderEnv(db, config, plugin) {
  const finalConfig = { ...(config || {}) };

  // Agent runtimes need the provider credentials — that is what they are for.
  // Runtimes that host arbitrary images do not: a video renderer or an MCP
  // tool checked in from someone else's repository has no business holding
  // the operator's whole provider wallet. Those declare 'optional' and get
  // nothing unless the guest asks, which keeps the documented case of pointing
  // a generic OpenAI-compatible app at a provider working.
  if (plugin && plugin.providerCredentials === 'optional') {
    const wanted = String(finalConfig.INJECT_PROVIDER_ENV || '').toLowerCase();
    if (wanted !== 'true' && wanted !== '1' && wanted !== 'yes') return finalConfig;
  }

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
    let pinned = '';
    try {
      pinned = db.prepare("SELECT value FROM settings WHERE key = 'default_model'").get()?.value || '';
    } catch (_) { /* settings table not ready: choose automatically */ }
    const { model, reason } = pinnedDefaultModel(pinned, providers);
    if (model) finalConfig[modelKey] = model;
    if (reason) {
      // Falling back is never silent: the operator chose a model on purpose.
      console.warn(`[ProviderEnv] ${reason} — choosing automatically`);
      try {
        db.prepare('INSERT INTO events (type, agent_id, message) VALUES (?, ?, ?)')
          .run('provider.fallback', null, `${reason} — choosing automatically`);
      } catch (_) { /* event log is best-effort */ }
    }
  }
  if (modelKey && !finalConfig[modelKey]) {
    const { selectModel } = require('./modelSelect');

    // Every configured provider is a candidate, not just the two hosted ones
    // that used to be hardcoded here. Pointing a whole fleet at a private,
    // self-hosted endpoint is the point of the product, and an operator whose
    // only provider was a private OpenAI-compatible box got no model selected
    // at all — the runtime then fell back to a literal like gpt-5.4 that such
    // an endpoint has never heard of.
    //
    // Order is deliberate and backward compatible: an explicitly chosen
    // default_provider wins, then the canonical hosted ones so existing
    // installs behave exactly as before, then anything else configured. Set
    // default_provider to a private endpoint to make it the fleet default.
    const preferred = (() => {
      try {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'default_provider'").get();
        return (row && row.value || '').toLowerCase();
      } catch (_) { return ''; }
    })();

    const rank = (name) => {
      const n = (name || '').toLowerCase();
      if (preferred && n === preferred) return 0;
      if (n === 'openai') return 1;
      if (n === 'openrouter') return 2;
      return 3;
    };

    const candidates = providers
      .filter(p => p.apiKey && (p.models || '').trim() && (p.models || '').trim() !== '[]')
      .sort((a, b) => rank(a.name) - rank(b.name) || (a.name || '').localeCompare(b.name || ''));

    for (const row of candidates) {
      // The prefix is the provider's own name, which is also how the runtimes
      // resolve it. Model ids that themselves contain a slash are fine: the
      // runtimes split on the FIRST one, so "unsloth/unsloth/Qwen3.8-GGUF"
      // resolves to provider "unsloth", model "unsloth/Qwen3.8-GGUF".
      const prefix = slugify(row.name) || (row.name || '').toLowerCase();
      let chosen = null;
      try {
        chosen = await selectModel(db, row, plugin.name || modelKey, plugin.modelRequirements, plugin.minContextTokens);
      } catch (err) {
        console.warn(`[ProviderEnv] Model selection failed for ${row.name}: ${err.message}`);
      }
      if (chosen) {
        finalConfig[modelKey] = `${prefix}/${chosen}`;
        // Falling through from a named default_provider to a different one is
        // never a detail. Someone who points the fleet at private hardware does
        // it so the traffic stays there; quietly routing it to a hosted API
        // instead is the one failure they must not discover later. Say it.
        if (preferred && (row.name || '').toLowerCase() !== preferred) {
          const msg = `Default provider "${preferred}" could not serve a model — using ${row.name} instead`;
          console.warn(`[ProviderEnv] ${msg}`);
          try {
            db.prepare('INSERT INTO events (type, agent_id, message) VALUES (?, ?, ?)')
              .run('provider.fallback', null, msg);
          } catch (_) { /* event log is best-effort */ }
        }
        break;
      }
      console.warn(`[ProviderEnv] No ${row.name} model satisfied ${plugin.name || modelKey}`);
    }

    // Nothing configured passed: keep the runtime's literal so a deploy still
    // produces a usable config rather than an agent with no model at all.
    if (!finalConfig[modelKey] && plugin.fallbackModel) {
      const host = candidates.length ? slugify(candidates[0].name) : 'openai';
      finalConfig[modelKey] = `${host}/${plugin.fallbackModel}`;
    }
  }

  return finalConfig;
}

module.exports = { injectProviderEnv, pinnedDefaultModel, PROVIDER_ENV_MAP };

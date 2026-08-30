const fetch = require('node-fetch');

// Picking a model that EXISTS is not the same as picking one that WORKS.
//
// Deriving the default from the operator's provider list fixed
// "model_not_found", but this account's first-listed model is gpt-4, which
// exists and then failed every OpenClaw turn with
// "unknown_parameter: Invalid value: 'custom'" on tools — too old for the tool
// schema OpenClaw sends. Model ids carry no reliable capability information and
// list order is a weak signal, so instead of hardcoding which models are good,
// a runtime declares the request parameters it will actually send and we probe
// the operator's own models with exactly those.
//
// Self-updating by construction: a new model works the day the operator adds
// it, with no table of model knowledge to maintain here.

// Verdicts are cached per (provider, model, runtime) so a deploy costs at most
// one tiny completion per untried candidate.
function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_probes (
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      runtime TEXT NOT NULL,
      ok INTEGER NOT NULL,
      detail TEXT,
      checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (provider, model, runtime)
    )
  `);
}

function cachedVerdict(db, provider, model, runtime) {
  try {
    const row = db.prepare(
      'SELECT ok, detail FROM model_probes WHERE provider = ? AND model = ? AND runtime = ?'
    ).get(provider, model, runtime);
    return row ? { ok: !!row.ok, detail: row.detail } : null;
  } catch (_) {
    return null;
  }
}

function recordVerdict(db, provider, model, runtime, ok, detail) {
  try {
    db.prepare(`
      INSERT INTO model_probes (provider, model, runtime, ok, detail, checked_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(provider, model, runtime) DO UPDATE SET
        ok = excluded.ok, detail = excluded.detail, checked_at = CURRENT_TIMESTAMP
    `).run(provider, model, runtime, ok ? 1 : 0, (detail || '').slice(0, 300));
  } catch (err) {
    console.error('[ModelSelect] Could not cache verdict:', err.message);
  }
}

// Send the smallest request that still carries the runtime's declared
// parameters. Deliberately no max_tokens: newer models reject it in favour of
// max_completion_tokens, and a probe must never fail on something we added.
async function probeModel(provider, model, requirements) {
  const base = (provider.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const body = {
    model,
    messages: [{ role: 'user', content: 'ping' }],
    ...(requirements || {})
  };

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify(body),
    timeout: 30000
  });

  if (res.ok) return { ok: true, detail: 'accepted' };

  const text = (await res.text().catch(() => '')).slice(0, 300);
  // 401/403/429 and 5xx say nothing about the model — the key is wrong, we are
  // throttled, or the provider is unwell. Report as indeterminate so the
  // verdict is not cached and a later deploy tries again.
  if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) {
    return { indeterminate: true, detail: `HTTP ${res.status}: ${text}` };
  }
  return { ok: false, detail: `HTTP ${res.status}: ${text}` };
}

// The id an operator configures is often not the id the server reports. This
// endpoint lists "unsloth/Qwen3.8-Flash-Next-GGUF" while the configured model
// carries a quantisation tag: "...-GGUF:UD-Q2_K_XL". An exact-match lookup
// silently found nothing, read that as "context unknown", and let a model
// through that the gate existed to stop — a check that never fires is worse
// than no check, because it looks like protection.
function lookupContext(byModel, model) {
  if (byModel.has(model)) return byModel.get(model);
  const withoutTag = model.includes(':') ? model.slice(0, model.lastIndexOf(':')) : null;
  if (withoutTag && byModel.has(withoutTag)) return byModel.get(withoutTag);
  // Last resort: a reported id the configured one extends, longest first so
  // "foo-GGUF" is preferred over a shorter "foo".
  const prefixes = [...byModel.keys()]
    .filter(id => model.startsWith(id))
    .sort((a, b) => b.length - a.length);
  return prefixes.length ? byModel.get(prefixes[0]) : undefined;
}

/**
 * Return the first model from the provider's configured list that accepts the
 * runtime's declared request parameters, or null when none does.
 */
async function selectModel(db, provider, runtime, requirements, minContextTokens) {
  ensureSchema(db);

  let candidates = [];
  try {
    const parsed = JSON.parse(provider.models || '[]');
    if (Array.isArray(parsed)) candidates = parsed.filter(m => typeof m === 'string' && m);
  } catch (_) { /* unparseable list — nothing to choose from */ }
  if (!candidates.length || !provider.apiKey) return null;

  // A runtime may need a minimum context window. hermes states its own floor
  // in its refusal ("below the minimum 64,000 required"), and providers report
  // what they have — so a model too small to run is knowable before an agent
  // is ever pointed at it, instead of both failing later in different ways.
  //
  // Absent is not small: a model that reports no window passes. A local server
  // reports nothing at all while loading, and excluding on ignorance would
  // lock out an endpoint for being mid-restart.
  let contextByModel = new Map();
  if (minContextTokens) {
    try {
      const listed = await fetchProviderModels(provider);
      contextByModel = new Map(listed.map(m => [m.id, m.contextLength]));
    } catch (err) {
      console.warn(`[ModelSelect] Could not read ${provider.name} model list: ${err.message}`);
    }
  }

  for (const model of candidates) {
    if (minContextTokens) {
      const ctx = lookupContext(contextByModel, model);
      if (Number.isFinite(ctx) && ctx < minContextTokens) {
        const detail = `context ${ctx} < ${minContextTokens} required`;
        console.log(`[ModelSelect] ${runtime}: ${provider.name}/${model} skipped — ${detail}`);
        recordVerdict(db, provider.name, model, runtime, false, detail);
        continue;
      }
    }
    const cached = cachedVerdict(db, provider.name, model, runtime);
    if (cached) {
      if (cached.ok) return model;
      continue;
    }
    let verdict;
    try {
      verdict = await probeModel(provider, model, requirements);
    } catch (err) {
      console.warn(`[ModelSelect] ${provider.name}/${model} probe failed: ${err.message}`);
      continue; // network trouble — do not cache, try the next candidate
    }
    if (verdict.indeterminate) {
      console.warn(`[ModelSelect] ${provider.name}/${model} indeterminate: ${verdict.detail}`);
      continue;
    }
    recordVerdict(db, provider.name, model, runtime, verdict.ok, verdict.detail);
    if (verdict.ok) {
      console.log(`[ModelSelect] ${runtime}: chose ${provider.name}/${model}`);
      return model;
    }
    console.log(`[ModelSelect] ${runtime}: ${provider.name}/${model} rejected — ${verdict.detail}`);
  }
  return null;
}

// What a provider offers, with the context window it reports per model.
// One source of truth for both the deploy-time gate below and the provider
// screen, so the number an operator reads is the number selection acts on.
//
// Servers report this under different keys, and a llama.cpp-style box reports
// NOTHING at all while a model is loading — which is why an absent value must
// never be treated as a small one.
async function fetchProviderModels(provider) {
  const base = (provider.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const headers = {};
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  const res = await fetch(`${base}/models`, { headers, timeout: 25000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const items = data.data || data.models || [];
  return (Array.isArray(items) ? items : []).map(m => {
    const id = typeof m === 'string' ? m : (m.id || m.name || '');
    const ctx = typeof m === 'object'
      ? (m.context_length ?? m.max_context_length ?? m.n_ctx ?? (m.meta && m.meta.n_ctx))
      : undefined;
    return {
      id,
      contextLength: Number.isFinite(parseInt(ctx)) ? parseInt(ctx) : null
    };
  }).filter(m => m.id);
}

module.exports = { selectModel, probeModel, ensureSchema, fetchProviderModels };

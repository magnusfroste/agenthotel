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

/**
 * Return the first model from the provider's configured list that accepts the
 * runtime's declared request parameters, or null when none does.
 */
async function selectModel(db, provider, runtime, requirements) {
  ensureSchema(db);

  let candidates = [];
  try {
    const parsed = JSON.parse(provider.models || '[]');
    if (Array.isArray(parsed)) candidates = parsed.filter(m => typeof m === 'string' && m);
  } catch (_) { /* unparseable list — nothing to choose from */ }
  if (!candidates.length || !provider.apiKey) return null;

  for (const model of candidates) {
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

module.exports = { selectModel, probeModel, ensureSchema };

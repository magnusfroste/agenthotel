// The providers the panel knows by name.
//
// A hosted provider has one address and one way to list its models; the only
// thing an operator can contribute is the key. The form still asked for a
// type, a base URL and a comma-separated model list for every provider, and
// three plugins each kept their own copy of the addresses (2026-10-03). Now
// the name settles it: a provider called OpenAI — or "Open AI", or "openai" —
// is this entry, and anything not listed here is the operator's own endpoint,
// where the URL and the fetched model list are the whole point.
//
// The slug is also the prefix an agent writes: openai/gpt-5.6-luna, and it is
// the stem of the env vars a guest receives: OPENAI_API_KEY.

const slugify = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const BUILTIN = {
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL' },
  openrouter: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY' },
  anthropic: { name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', keyEnv: 'ANTHROPIC_API_KEY', models: 'anthropic' },
  gemini: { name: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'GEMINI_API_KEY' },
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', keyEnv: 'DEEPSEEK_API_KEY' },
  groq: { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY' },
  xai: { name: 'xAI', baseUrl: 'https://api.x.ai/v1', keyEnv: 'XAI_API_KEY' },
  mistral: { name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', keyEnv: 'MISTRAL_API_KEY' },
  zai: { name: 'Z.ai', baseUrl: 'https://api.z.ai/api/paas/v4', keyEnv: 'ZAI_API_KEY' }
};

// The entry a provider name refers to, or null for an operator's own endpoint.
function builtinFor(name) {
  return BUILTIN[slugify(name)] || null;
}

// Where requests to this provider go. A built-in has one address, whatever a
// row from before this module stored; an own endpoint is wherever it says.
function effectiveBaseUrl(provider) {
  const entry = builtinFor(provider && provider.name);
  if (entry) return entry.baseUrl;
  return String((provider && provider.baseUrl) || '').trim().replace(/\/+$/, '');
}

// How to ask a provider what it serves. Everyone speaks GET /models with a
// bearer token except Anthropic, whose API has its own header and version.
function modelsRequest(provider) {
  const entry = builtinFor(provider && provider.name);
  const base = effectiveBaseUrl(provider);
  const headers = {};
  if (entry && entry.models === 'anthropic') {
    if (provider.apiKey) headers['x-api-key'] = provider.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (provider && provider.apiKey) {
    headers.Authorization = `Bearer ${provider.apiKey}`;
  }
  return { url: `${base}/models`, headers };
}

// The id an agent should write. Gemini's OpenAI-compatible listing says
// "models/gemini-2.5-pro"; the chat endpoint, and every client, wants it bare.
function normalizeModelId(providerName, id) {
  const value = String(id || '');
  if (slugify(providerName) === 'gemini') return value.replace(/^models\//, '');
  return value;
}

function listBuiltin() {
  return Object.entries(BUILTIN).map(([slug, e]) => ({ slug, name: e.name, baseUrl: e.baseUrl, keyEnv: e.keyEnv }));
}

module.exports = { BUILTIN, slugify, builtinFor, effectiveBaseUrl, modelsRequest, normalizeModelId, listBuiltin };

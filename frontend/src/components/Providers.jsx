import { useState, useEffect } from 'react';
import { authFetch, authFetchOk } from '../lib/auth';
import { useToast } from './Toast';
import OwnModelWizard from './OwnModelWizard';
import ModelSearch from './ModelSearch';
import { Plus, Edit, Trash2, CheckCircle, XCircle, Code, Cpu } from 'lucide-react';

// The prefix an agent's model field expects, derived exactly as the backend
// derives the <SLUG>_API_KEY / _BASE_URL / _MODELS it injects: lowercase, letters
// and digits only. "DGX Spark" and "dgxspark" are the same provider.
const providerSlug = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Mirrors backend/lib/builtinProviders.js isChatModel — keep the two in step.
const NOT_CHAT = /(^|[\/-])(tts|transcribe|whisper|embed(ding)?s?|dall-e|moderation|sora|davinci|babbage)([\/-]|$)|text-embedding|omni-moderation|-image(-|$)|^gpt-image|-audio(-|$)|^gpt-audio|-realtime(-|$)|^gpt-realtime/i;
const isChatModel = (id) => !NOT_CHAT.test(String(id || ''));

function Providers() {
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [showOwn, setShowOwn] = useState(false);
  const [editingProvider, setEditingProvider] = useState(null);
  const [rawOpen, setRawOpen] = useState(false)
  const [rawText, setRawText] = useState('')
  const [liveModels, setLiveModels] = useState(null)
  const [runtimeFloor, setRuntimeFloor] = useState(0)
  // What a new agent gets when its deploy form leaves the model empty.
  // '' means the panel chooses, which used to be the only option.
  const [defaultModel, setDefaultModel] = useState('')
  // The built-in providers the panel knows, with the ones already added marked.
  const [builtinList, setBuiltinList] = useState([])
  const [refreshing, setRefreshing] = useState({})
  const [formData, setFormData] = useState({
    name: '',
    type: 'openai',
    baseUrl: '',
    apiKey: '',
    models: ''
  });
  const [testResults, setTestResults] = useState({}); // { providerId: { success, response/error, model } }
  const [testModels, setTestModels] = useState({}); // { providerId: selectedModel }
  const [testingProviders, setTestingProviders] = useState({}); // { providerId: boolean }
  const toast = useToast();

  useEffect(() => {
    fetchProviders();
    authFetch('/api/providers/builtin').then(r => r.json()).then(setBuiltinList).catch(() => {})
    authFetch('/api/settings').then(r => r.json())
      .then(s => setDefaultModel(s.default_model || ''))
      .catch(() => {});
  }, []);

  async function saveDefaultModel(value) {
    const before = defaultModel
    setDefaultModel(value)
    try {
      await authFetchOk('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ default_model: value })
      })
      toast.success(value ? `New agents will use ${value}` : 'New agents get a model chosen by the panel')
    } catch (err) {
      setDefaultModel(before)
      toast.error('Could not save the default model: ' + err.message)
    }
  }

  async function fetchProviders() {
    try {
      const res = await authFetch('/api/providers');
      const data = await res.json();
      setProviders(data);
    } catch (err) {
      console.error('Failed to fetch providers:', err);
    } finally {
      setLoading(false);
    }
  }

  function handleEdit(provider) {
    setEditingProvider(provider);
    setLiveModels(null);
    setFormData({
      kind: provider.builtin ? 'builtin' : 'own',
      slug: provider.builtin ? providerSlug(provider.name) : '',
      name: provider.name,
      baseUrl: provider.baseUrl || '',
      apiKey: provider.apiKey || '',
      models: Array.isArray(provider.models) ? provider.models.join(', ') : ''
    });
    setShowForm(true);
  }

  function handleAdd() {
    setEditingProvider(null);
    setLiveModels(null);
    const free = builtinList.find(b => !b.configured)
    setFormData({
      kind: 'builtin',
      slug: free ? free.slug : '',
      name: '',
      baseUrl: '',
      apiKey: '',
      models: ''
    });
    setShowForm(true);
  }

  // Which built-in this provider is, and the key. Everything else about a
  // built-in — its address, what it serves — the panel knows or asks for.
  // An endpoint of your own is the opposite: the address is the point.
  async function handleSubmit(e) {
    e.preventDefault();
    try {
      const payload = formData.kind === 'builtin'
        ? { name: (builtinList.find(b => b.slug === formData.slug) || {}).name || formData.name, apiKey: formData.apiKey }
        : { name: formData.name, baseUrl: formData.baseUrl, apiKey: formData.apiKey,
            models: formData.models.split(',').map(m => m.trim()).filter(m => m) };

      const url = editingProvider 
        ? `/api/providers/${editingProvider.id}`
        : '/api/providers';
      const method = editingProvider ? 'PUT' : 'POST';

      const res = await authFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        const saved = await res.json().catch(() => ({}))
        setShowForm(false);
        fetchProviders();
        authFetch('/api/providers/builtin').then(r => r.json()).then(setBuiltinList).catch(() => {})
        if (saved.warning) toast.warning(saved.warning)
        else toast.success(saved.builtin && Array.isArray(saved.models)
          ? `${saved.name} saved — ${saved.models.length} models fetched`
          : (editingProvider ? 'Provider updated' : 'Provider created'));
      } else {
        const err = await res.json();
        toast.error('Error: ' + (err.error || 'Unknown error'));
      }
    } catch (err) {
      console.error('Failed to save provider:', err);
      toast.error('Failed to save provider');
    }
  }

  async function handleDelete(id) {
    if (!confirm('Are you sure you want to delete this provider?')) return;
    try {
      const res = await authFetch(`/api/providers/${id}`, { method: 'DELETE' });
      if (res.ok) {
        fetchProviders();
        toast.success('Provider deleted');
      } else {
        toast.error('Failed to delete provider');
      }
    } catch (err) {
      console.error('Failed to delete provider:', err);
      toast.error('Failed to delete provider');
    }
  }

  async function handleTest(provider) {
    const model = testModels[provider.id];
    if (!model) {
      toast.warning('Please select a model to test');
      return;
    }

    setTestingProviders(prev => ({ ...prev, [provider.id]: true }));
    setTestResults(prev => ({ ...prev, [provider.id]: null }));
    try {
      const res = await authFetch(`/api/providers/${provider.id}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model })
      });
      const data = await res.json();
      setTestResults(prev => ({ ...prev, [provider.id]: data }));
    } catch (err) {
      console.error('Test failed:', err);
      setTestResults(prev => ({ ...prev, [provider.id]: { success: false, error: err.message } }));
    } finally {
      setTestingProviders(prev => ({ ...prev, [provider.id]: false }));
    }
  }

  // Raw view: the whole provider set as text, so moving it to another instance
  // is a copy and a paste instead of retyping every row. Keys are included —
  // they have to be, or the pasted set is useless on the other side — which is
  // also why this is not open by default.
  function openRaw() {
    const clean = providers.map(p => ({
      name: p.name,
      type: p.type || 'openai',
      baseUrl: p.baseUrl || '',
      apiKey: p.apiKey || '',
      models: Array.isArray(p.models) ? p.models : []
    }))
    setRawText(JSON.stringify(clean, null, 2))
    setRawOpen(true)
  }

  function copyRaw() {
    navigator.clipboard.writeText(rawText)
      .then(() => toast.success('Providers copied — paste into the other instance'))
      .catch(() => toast.error('Could not copy — the browser blocked clipboard access'))
  }

  async function applyRaw() {
    let parsed
    try {
      parsed = JSON.parse(rawText)
    } catch (err) {
      toast.error('Not valid JSON: ' + err.message)
      return
    }
    if (!Array.isArray(parsed)) {
      toast.error('Expected a JSON array of providers')
      return
    }
    if (!confirm(
      `Apply ${parsed.length} provider(s)?\n\n` +
      'Providers are matched by name: an existing name is overwritten, a new one ' +
      'is added. Nothing is deleted. Agents pick up changes on their next redeploy.'
    )) return
    try {
      const res = await authFetchOk('/api/providers/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: rawText
      })
      const data = await res.json()
      toast.success(`${data.created} added, ${data.updated} updated`)
      setRawOpen(false)
      fetchProviders()
    } catch (err) {
      toast.error('Import failed: ' + err.message)
    }
  }

  // Ask a provider what it serves now, and keep the answer. New models appear
  // here and in the default-model list without anyone typing them.
  async function handleRefreshModels(provider) {
    setRefreshing(prev => ({ ...prev, [provider.id]: true }))
    try {
      const res = await authFetch(`/api/providers/${provider.id}/refresh-models`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not refresh')
      toast.success(`${provider.name}: ${data.models.length} models`)
      fetchProviders()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setRefreshing(prev => ({ ...prev, [provider.id]: false }))
    }
  }

  async function handleFetchModels(provider) {
    try {
      // ?live=1 asks the provider directly and returns the context window it
      // reports per model. A name alone cannot tell you a model is too small
      // for the runtime you are about to deploy.
      const res = await authFetch(`/api/providers/${provider.id}/models?live=1`);
      const data = await res.json();
      if (Array.isArray(data)) {
        const modelNames = data.map(m => m.id || m.name || m).join(', ');
        setFormData({ ...formData, models: modelNames });
        setLiveModels(data);
        // The floor belongs to the runtimes, so read it rather than hardcode it.
        try {
          const rt = await (await authFetch('/api/runtimes')).json()
          setRuntimeFloor(Math.max(0, ...(Array.isArray(rt) ? rt : []).map(r => r.minContextTokens || 0)))
        } catch (_) { /* flagging is a nicety; the list is the point */ }
        toast.success(`Fetched ${data.length} models`);
      }
    } catch (err) {
      console.error('Failed to fetch models:', err);
      toast.error('Failed to fetch models from provider');
    }
  }

  if (loading) {
    return (
      <div className="loading">
        <div>
          <div className="loading-spinner" />
          <div>Loading providers...</div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Providers</h1>
        <button onClick={() => { setShowOwn(true); setShowForm(false); }} className="btn btn-primary">
          <Cpu size={18} />
          Add your own model
        </button>
        <button onClick={handleAdd} className="btn btn-secondary">
          <Plus size={18} />
          Add Provider
        </button>
        <button onClick={rawOpen ? () => setRawOpen(false) : openRaw} className="btn btn-secondary">
          <Code size={18} />
          {rawOpen ? "Close raw" : "Raw"}
        </button>
      </div>

      {providers.some(p => Array.isArray(p.models) && p.models.length) && (() => {
        const groups = providers
          .filter(p => Array.isArray(p.models) && p.models.length)
          // Lists stored before chat-only filtering still carry tts and image
          // models; an agent cannot run on those, so they are not offered.
          .map(p => ({ name: p.name, ids: p.models.filter(isChatModel).map(m => `${providerSlug(p.name)}/${m}`).sort() }))
        const ids = groups.flatMap(g => g.ids)
        const missing = defaultModel && !ids.includes(defaultModel)
        return (
          <div className="settings-section">
            <h2>Default model for new agents</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginTop: 0 }}>
              Used when an agent is deployed with its model field left empty. An agent's own setting always wins,
              and changing this does not touch agents that already exist.
            </p>
            <ModelSearch
              label="Default model for new agents"
              placeholder="Search, e.g. luna, sol 6.1, glm…"
              value={defaultModel}
              onChange={id => { if (id !== defaultModel) saveDefaultModel(id) }}
              options={groups.flatMap(g => g.ids.map(id => ({ id, group: g.name })))}
              extra={[{ id: '', label: 'Automatic — the panel picks one that works' }]}
            />
            {missing && (
              <div style={{ fontSize: '0.8rem', color: 'var(--accent-yellow, #f59e0b)', marginTop: '0.4rem' }}>
                {defaultModel} is no longer offered by any provider here, so new agents get an automatic choice.
              </div>
            )}
          </div>
        )
      })()}

      {showOwn && (
        <OwnModelWizard existing={providers}
          onDone={() => { setShowOwn(false); fetchProviders(); }}
          onCancel={() => setShowOwn(false)} />
      )}

      {rawOpen && (
        <div className="settings-section">
          <h2>All providers as text</h2>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem" }}>
            Copy this into another instance to move every provider at once. Pasting
            matches on name: an existing name is overwritten, a new one is added,
            nothing is deleted. <strong>API keys are included</strong> — that is what
            makes it work on the other side, so treat it like the keys themselves.
          </p>
          <textarea data-secret="" value={rawText} onChange={e => setRawText(e.target.value)}
            spellCheck={false} rows={18}
            style={{ width: "100%", fontFamily: "monospace", fontSize: "0.8rem" }} />
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
            <button onClick={copyRaw} className="btn btn-secondary">Copy</button>
            <button onClick={applyRaw} className="btn btn-primary">Apply to this instance</button>
          </div>
        </div>
      )}

      {showForm && (
        <div className="settings-section">
          <h2>{editingProvider ? `Edit ${editingProvider.name}` : 'Add Provider'}</h2>
          <form onSubmit={handleSubmit}>
            {!editingProvider && (
              <div className="form-group">
                <label className="form-label">What kind</label>
                <select className="form-select" value={formData.kind}
                  onChange={(e) => setFormData({ ...formData, kind: e.target.value })}>
                  <option value="builtin">A built-in provider — just the key</option>
                  <option value="own">An endpoint of your own — vLLM, Ollama, llama.cpp, a GPU box</option>
                </select>
              </div>
            )}

            {formData.kind === 'own' && !editingProvider && (
              <div className="form-group">
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginTop: 0 }}>
                  Your own endpoint gets a name you choose, its address and a key. The panel asks it what it
                  serves and shows the exact <code>name/model</code> an agent writes.
                </p>
                <button type="button" className="btn btn-primary" onClick={() => { setShowForm(false); setShowOwn(true); }}>
                  <Cpu size={16} /> Continue
                </button>
                <button type="button" className="btn btn-secondary" style={{ marginLeft: '0.5rem' }} onClick={() => setShowForm(false)}>Cancel</button>
              </div>
            )}

            {formData.kind === 'builtin' && (
              <div className="form-group">
                <label className="form-label">Provider</label>
                {editingProvider ? (
                  <div style={{ fontSize: '0.9rem' }}>{editingProvider.name}
                    <span style={{ color: 'var(--text-secondary)', marginLeft: '0.5rem', fontSize: '0.8rem' }}>{editingProvider.baseUrl}</span>
                  </div>
                ) : (
                  <select className="form-select" value={formData.slug} required
                    onChange={(e) => setFormData({ ...formData, slug: e.target.value })}>
                    {builtinList.map(b => (
                      <option key={b.slug} value={b.slug} disabled={b.configured}>{b.name}{b.configured ? ' — already added' : ''}</option>
                    ))}
                  </select>
                )}
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.3rem' }}>
                  The address is fixed and the model list is fetched when you save. Agents write models as{' '}
                  <code>{formData.slug || 'provider'}/model</code>.
                </div>
              </div>
            )}

            {formData.kind === 'own' && editingProvider && (
              <>
                <div className="form-group">
                  <label className="form-label">Name</label>
                  <input type="text" className="form-input" value={formData.name} required
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })} />
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.3rem' }}>
                    Agents write models as <code>{providerSlug(formData.name) || 'name'}/model</code>. Renaming changes that for every agent on its next redeploy.
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Base URL</label>
                  <input type="url" className="form-input" value={formData.baseUrl} required
                    onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
                    placeholder="https://gpu.example.com/v1" />
                </div>
              </>
            )}

            {(formData.kind === 'builtin' || editingProvider) && (
            <div className="form-group">
              <label className="form-label">API Key</label>
              <input
                data-secret=""
                type="password"
                className="form-input"
                value={formData.apiKey}
                onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                placeholder="sk-..."
                autoComplete="off"
              />
            </div>
            )}

            {formData.kind === 'own' && editingProvider && (
            <div className="form-group">
              <label className="form-label">Models (comma-separated)</label>
              <input
                type="text"
                className="form-input"
                value={formData.models}
                onChange={(e) => setFormData({ ...formData, models: e.target.value })}
                placeholder="gpt-4, gpt-3.5-turbo"
              />
              {/* What the provider actually reports. A model that fits every
                  runtime looks the same as one that cannot run any of them
                  until you see the window — which is the whole point. */}
              {liveModels && liveModels.length > 0 && (
                <div style={{
                  marginTop: '0.6rem', padding: '0.6rem 0.75rem', borderRadius: '0.5rem',
                  background: 'var(--bg-tertiary)', fontSize: '0.8rem'
                }}>
                  {liveModels.map(m => {
                    const tooSmall = runtimeFloor > 0 && Number.isFinite(m.contextLength) && m.contextLength !== null && m.contextLength < runtimeFloor
                    return (
                      <div key={m.id} style={{
                        display: 'flex', justifyContent: 'space-between', gap: '1rem',
                        padding: '0.15rem 0', color: tooSmall ? '#ef4444' : 'var(--text-secondary)'
                      }}>
                        <span style={{ fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.id}</span>
                        <span style={{ whiteSpace: 'nowrap' }}>
                          {m.contextLength === null
                            ? 'context not reported'
                            : `${m.contextLength.toLocaleString()} ctx${tooSmall ? ` — under ${runtimeFloor.toLocaleString()}` : ''}`}
                        </span>
                      </div>
                    )
                  })}
                  {runtimeFloor > 0 && (
                    <div style={{ marginTop: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
                      A runtime here needs at least {runtimeFloor.toLocaleString()} tokens of context.
                      Models reporting less are skipped when a model is picked automatically;
                      ones that report nothing are still tried.
                    </div>
                  )}
                </div>
              )}
              <button
                type="button"
                onClick={() => handleFetchModels(editingProvider)}
                className="btn btn-secondary"
                style={{ marginTop: '0.5rem' }}
              >
                Fetch Models from API
              </button>
            </div>
            )}

            {(formData.kind === 'builtin' || editingProvider) && (
            <div className="form-actions">
              <button type="submit" className="btn btn-primary">
                {editingProvider ? 'Update' : 'Add'} Provider
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="btn btn-secondary"
              >
                Cancel
              </button>
            </div>
            )}
          </form>
        </div>
      )}

      <div className="grid" style={{ gap: '0.75rem' }}>
        {providers.map((provider) => (
          <div key={provider.id} className="provider-card">
            <div className="provider-card-header">
              <div style={{ flex: 1 }}>
                <h3 className="provider-card-title">{provider.name}</h3>
                <div className="provider-card-meta">
                  <span style={{ marginRight: '1rem' }}>{provider.builtin ? 'Built-in' : 'Your endpoint'}</span>
                  <span style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{provider.baseUrl}</span>
                  {!provider.apiKey && <span style={{ marginLeft: '1rem', color: 'var(--accent-yellow, #f59e0b)' }}>no key</span>}
                </div>
              </div>

              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  onClick={() => handleRefreshModels(provider)}
                  disabled={refreshing[provider.id]}
                  title="Ask the provider what it serves now"
                  className="btn btn-secondary"
                  style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem' }}
                >
                  {refreshing[provider.id] ? 'Refreshing…' : 'Refresh models'}
                </button>
                <button
                  onClick={() => handleEdit(provider)}
                  className="btn btn-secondary"
                  style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem' }}
                >
                  <Edit size={14} color="currentColor" />
                </button>
                <button
                  onClick={() => handleDelete(provider.id)}
                  className="btn btn-danger"
                  style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem' }}
                >
                  <Trash2 size={14} color="currentColor" />
                </button>
              </div>
            </div>

            <div className="provider-card-info">
              {provider.apiKey && (
                <div style={{ marginBottom: '0.25rem' }}>
                  <strong>API Key:</strong> <span data-secret="">•••••{provider.apiKey.slice(-4)}</span>
                </div>
              )}
              {provider.builtin && Array.isArray(provider.models) && (
                // Hundreds of ids are not something to read on a card. They are
                // searched where a model is picked — the default above, Test
                // below — and Hermes and OpenClaw list them in their own pickers.
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  {provider.models.filter(isChatModel).length} chat models — search them under Default model or Test.
                  Agents write them as <code>{providerSlug(provider.name)}/model</code>.
                </div>
              )}
              {!provider.builtin && Array.isArray(provider.models) && provider.models.length > 0 && (
                // Shown as an agent must write them: provider/model. A bare name
                // is a guess — hermes reads glm-5.3-flash as Z.ai's, whatever
                // endpoint actually serves it — and the prefix is what settles
                // it. Click one to copy it into an agent's model field.
                <div>
                  <div style={{ marginBottom: '0.35rem' }}>
                    <strong>Models</strong>
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', marginLeft: '0.5rem' }}>
                      use in an agent as — click to copy
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                    {provider.models.map((model) => {
                      const qualified = `${providerSlug(provider.name)}/${model}`
                      return (
                        <button
                          key={model}
                          type="button"
                          title={`Copy ${qualified}`}
                          onClick={() => navigator.clipboard.writeText(qualified)
                            .then(() => toast.success(`${qualified} copied`))
                            .catch(() => toast.error('Could not copy — the browser blocked clipboard access'))}
                          style={{ fontFamily: 'monospace', fontSize: '0.75rem', padding: '0.2rem 0.5rem', borderRadius: '0.35rem',
                            border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', cursor: 'pointer' }}
                        >
                          {qualified}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className="provider-card-test">
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <ModelSearch
                  compact
                  label={`Model to test on ${provider.name}`}
                  placeholder="Search a model to test…"
                  value={testModels[provider.id] || ''}
                  onChange={(id) => setTestModels(prev => ({ ...prev, [provider.id]: id }))}
                  options={(Array.isArray(provider.models) ? provider.models : []).filter(isChatModel).map(id => ({ id }))}
                />
                <button
                  onClick={() => handleTest(provider)}
                  disabled={testingProviders[provider.id] || !testModels[provider.id]}
                  className="btn btn-primary"
                  style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem' }}
                >
                  {testingProviders[provider.id] ? 'Testing...' : 'Test'}
                </button>
              </div>

              {testResults[provider.id] && (
                <div
                  className={`alert ${testResults[provider.id].success ? 'alert-success' : 'alert-error'}`}
                  style={{ marginTop: '0.75rem', padding: '0.75rem', fontSize: '0.8rem' }}
                >
                  {testResults[provider.id].success ? <CheckCircle size={16} /> : <XCircle size={16} />}
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: '600', marginBottom: '0.25rem' }}>
                      {testResults[provider.id].success ? '✓ Test successful' : '✗ Test failed'}
                    </div>
                    <div style={{ fontSize: '0.75rem' }}>
                      {testResults[provider.id].success ? testResults[provider.id].response : testResults[provider.id].error}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}

        {providers.length === 0 && !showForm && (
          <div className="empty-state">
            <h2>No providers configured</h2>
            <p>Click "Add Provider" to get started.</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default Providers;

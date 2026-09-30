import { useState } from 'react'
import { authFetch } from '../lib/auth'
import { useToast } from './Toast'
import { Search, Check, AlertTriangle, X } from 'lucide-react'

// Adding a model you run yourself — a vLLM on a DGX Spark, llama.cpp on a box
// under the desk — as a provider the agents can use.
//
// Each step answers a question the operator would otherwise find out the hard
// way: does the server answer at that address, what does it serve, is each
// model big enough for the runtime, and — the one that cost an afternoon —
// what exactly does an agent have to write to reach it.

const slugOf = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '')

// A readable default name from the host: the first label, or "local" for an IP.
function nameFromUrl(url) {
  try {
    const host = new URL(url).hostname
    if (/^[\d.]+$/.test(host) || host.includes(':')) return 'local'
    return slugOf(host.split('.')[0]) || 'local'
  } catch (e) { return '' }
}

const fmtContext = (n) => !Number.isFinite(n) ? 'context not reported'
  : n >= 1000 ? `${Math.round(n / 1000)}k context` : `${n} context`

export default function OwnModelWizard({ existing = [], onDone, onCancel }) {
  const toast = useToast()
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [probing, setProbing] = useState(false)
  const [found, setFound] = useState(null)       // { baseUrl, adjusted, models, hermesMinContext }
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState({})
  const [saving, setSaving] = useState(false)

  const slug = slugOf(name)
  const clash = slug && existing.some(p => slugOf(p.name) === slug)

  async function probe() {
    setProbing(true); setError(null); setFound(null)
    try {
      const res = await authFetch('/api/providers/probe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, apiKey })
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'The endpoint could not be read'); return }
      setFound(data)
      // Everything big enough is ticked; what is too small for Hermes is not.
      setSelected(Object.fromEntries(data.models.map(m => [m.id, !m.tooSmallForHermes])))
      if (!nameTouched) setName(nameFromUrl(data.baseUrl))
    } catch (e) {
      setError(e.message)
    } finally {
      setProbing(false)
    }
  }

  async function save() {
    const models = Object.keys(selected).filter(k => selected[k])
    if (!slug || !models.length || clash) return
    setSaving(true)
    try {
      const res = await authFetch('/api/providers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: slug, type: 'openai', baseUrl: found.baseUrl, apiKey, models })
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not save the provider')
      toast.success(`Added — agents use it as ${slug}/${models[0]}`)
      onDone && onDone()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  const label = { display: 'block', fontSize: '0.85rem', fontWeight: 500, marginBottom: '0.35rem' }
  const hint = { fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.3rem' }
  const picked = found ? found.models.filter(m => selected[m.id]) : []

  return (
    <div className="settings-section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Add your own model</h2>
        <button type="button" className="btn btn-secondary" onClick={onCancel}><X size={16} /></button>
      </div>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
        Any OpenAI-compatible server — vLLM, llama.cpp, Ollama, LM Studio, a GPU in the next room.
        The panel asks it what it serves, checks each model is big enough for Hermes, and tells you exactly what an agent should write.
      </p>

      <div className="form-group">
        <label style={label}>Base URL</label>
        <input className="form-input" value={baseUrl} onChange={e => { setBaseUrl(e.target.value); setFound(null); setError(null) }}
          placeholder="https://gpu.example.com/v1" style={{ fontFamily: 'monospace' }} />
        <div style={hint}>Reached from the AgentHotel server, not from your browser — so <code>localhost</code> means the server itself. /v1 is added if the server needs it.</div>
      </div>
      <div className="form-group">
        <label style={label}>API key <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>(optional)</span></label>
        <input className="form-input" type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
          placeholder="Leave empty if the server needs none" style={{ fontFamily: 'monospace' }} />
      </div>
      <button type="button" className="btn btn-primary" onClick={probe} disabled={probing || !baseUrl.trim()}
        style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <Search size={16} /> {probing ? 'Asking the server…' : 'Find models'}
      </button>

      {error && (
        <div className="alert alert-error" style={{ marginTop: '1rem', padding: '0.75rem', fontSize: '0.85rem' }}>
          <AlertTriangle size={16} /> <div>{error}</div>
        </div>
      )}

      {found && (
        <div style={{ marginTop: '1.25rem' }}>
          <div style={{ fontSize: '0.85rem', marginBottom: '0.5rem' }}>
            <strong>{found.models.length} model{found.models.length === 1 ? '' : 's'}</strong> at <code>{found.baseUrl}</code>
            {found.adjusted && <span style={{ color: 'var(--text-secondary)' }}> — /v1 added, that is where the server answers</span>}
          </div>
          {found.models.length === 0 && <div style={hint}>The server answered but lists no models. A local server can do this while a model is still loading.</div>}
          <div style={{ display: 'grid', gap: '0.35rem' }}>
            {found.models.map(m => (
              <label key={m.id} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.5rem 0.65rem', borderRadius: '0.4rem',
                border: '1px solid var(--border)', background: selected[m.id] ? 'var(--bg-primary)' : 'transparent', cursor: 'pointer' }}>
                <input type="checkbox" checked={!!selected[m.id]} onChange={e => setSelected(s => ({ ...s, [m.id]: e.target.checked }))} style={{ width: 'auto' }} />
                <span style={{ fontFamily: 'monospace', fontSize: '0.85rem', flex: 1 }}>{m.id}</span>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{fmtContext(m.contextLength)}</span>
                {m.tooSmallForHermes && (
                  <span title={`Hermes needs at least ${found.hermesMinContext.toLocaleString()} tokens of context`}
                    style={{ fontSize: '0.7rem', padding: '0.1rem 0.4rem', borderRadius: '0.3rem', background: 'rgba(245,158,11,0.15)', color: '#f59e0b' }}>
                    too small for Hermes
                  </span>
                )}
              </label>
            ))}
          </div>

          <div className="form-group" style={{ marginTop: '1rem' }}>
            <label style={label}>Name</label>
            <input className="form-input" value={name} onChange={e => { setName(e.target.value); setNameTouched(true) }}
              placeholder="dgxspark" style={{ fontFamily: 'monospace' }} />
            <div style={hint}>
              This name is the prefix agents write, so keep it short.
              {slug && picked[0] && <> An agent will use <code>{slug}/{picked[0].id}</code>.</>}
            </div>
            {clash && <div style={{ ...hint, color: '#f59e0b' }}>A provider named {slug} already exists. Its keys would collide — pick another name.</div>}
          </div>

          <button type="button" className="btn btn-primary" onClick={save} disabled={saving || !slug || !picked.length || clash}
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Check size={16} /> {saving ? 'Adding…' : `Add ${picked.length} model${picked.length === 1 ? '' : 's'} as ${slug || '…'}`}
          </button>
        </div>
      )}
    </div>
  )
}

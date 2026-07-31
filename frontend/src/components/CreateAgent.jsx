import { useState, useEffect } from 'react'
import { useNavigate, Link, useSearchParams } from 'react-router-dom'
import { authFetch } from '../lib/auth'
import { AlertTriangle, Bot, PawPrint, Layers, Container, Zap, ArrowRight } from 'lucide-react'

const RUNTIME_ICON = {
  hermes: Zap,
  openclaw: PawPrint,
  odysseus: Bot,
  'docker-app': Container,
  compose: Layers
}

function CreateAgent() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [runtimes, setRuntimes] = useState([])
  const [providers, setProviders] = useState([])
  const [formData, setFormData] = useState({ name: '', runtime: '', domain: '', image: '', port: '', config: {} })
  const [quickStart, setQuickStart] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { fetchRuntimes(); fetchProviders() }, [])

  async function fetchRuntimes() {
    try {
      const res = await authFetch('/api/runtimes')
      const data = await res.json()
      setRuntimes(data)
      if (data.length > 0) {
        const preset = searchParams.get('runtime')
        const preselected = preset && data.some(r => r.id === preset) ? preset : data[0].id
        setFormData(prev => ({ ...prev, runtime: preselected }))
      }
    } catch (err) { console.error('Failed to fetch runtimes:', err) }
  }

  async function fetchProviders() {
    try { setProviders(await (await authFetch('/api/providers')).json()) }
    catch (err) { console.error('Failed to fetch providers:', err) }
  }

  const selectedRuntime = runtimes.find(r => r.id === formData.runtime)
  const isCompose = formData.runtime === 'compose'

  function handleChange(e) {
    const { name, value } = e.target
    setFormData(prev => ({ ...prev, [name]: value }))
  }

  function handleConfigChange(key, value) {
    setFormData(prev => ({ ...prev, config: { ...prev.config, [key]: value } }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (isCompose) { navigate('/compose'); return }
    setLoading(true); setError('')
    try {
      const payload = { name: formData.name, runtime: formData.runtime, domain: formData.domain || undefined, quickStart }
      if (!quickStart) {
        payload.image = formData.image || undefined
        payload.port = formData.port ? parseInt(formData.port) : undefined
        payload.config = formData.config
      }
      const res = await authFetch('/api/agents', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      })
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Failed to create agent') }
      navigate('/')
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }

  return (
    <div>
      <h1 style={{ marginBottom: '0.3rem' }}>Create Agent</h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem', fontSize: '0.9rem' }}>
        Pick a runtime, name it, and deploy. For multi-container apps, use <Link to="/compose" style={{ color: '#60a5fa' }}>Deploy Compose</Link>.
      </p>

      {error && <div className="error" style={{ marginBottom: '1rem' }}>{error}</div>}

      {providers.length === 0 && (
        <div className="alert alert-warning" style={{ marginBottom: '1.5rem', display: 'flex', gap: '0.6rem', alignItems: 'flex-start' }}>
          <AlertTriangle size={20} color="#f59e0b" />
          <div>
            <strong>No providers configured</strong>
            <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.875rem' }}>Agents won't be able to chat without a provider.
              <Link to="/providers" style={{ color: '#f59e0b', marginLeft: '0.25rem' }}>Add a provider first</Link>
            </p>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="create-form">
        {/* Runtime picker */}
        <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.6rem', display: 'block' }}>Runtime *</label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '0.75rem', marginBottom: '1.5rem' }}>
          {runtimes.map(rt => {
            const Icon = RUNTIME_ICON[rt.id] || Container
            const selected = formData.runtime === rt.id
            return (
              <button key={rt.id} type="button" onClick={() => setFormData(prev => ({ ...prev, runtime: rt.id }))} style={{
                textAlign: 'left', background: selected ? 'rgba(59,130,246,0.12)' : 'var(--bg-secondary, #1e293b)',
                border: selected ? '1px solid #3b82f6' : '1px solid var(--border, #334155)', borderRadius: '0.6rem',
                padding: '1rem', cursor: 'pointer', color: 'inherit', transition: 'all 0.15s'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <span style={{ width: '34px', height: '34px', borderRadius: '0.4rem', background: selected ? '#3b82f6' : '#334155', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon size={18} color="white" />
                  </span>
                  {selected && <ArrowRight size={16} color="#3b82f6" />}
                </div>
                <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>{rt.name}</div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: '0.2rem', lineHeight: 1.3 }}>{rt.description}</div>
              </button>
            )
          })}
        </div>

        {isCompose && (
          <div style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid #3b82f6', borderRadius: '0.5rem', padding: '0.85rem 1rem', marginBottom: '1.5rem', fontSize: '0.85rem', color: '#93c5fd' }}>
            Compose runtime deploys from a <code>docker-compose.yml</code>. You'll be taken to the Compose editor after creating. For a quick single-container app, choose a different runtime.
          </div>
        )}

        <div className="form-group">
          <label>Name *</label>
          <input type="text" name="name" value={formData.name} onChange={handleChange} placeholder="my-agent" required />
        </div>

        <div className="form-group">
          <label>Domain (optional)</label>
          <input type="text" name="domain" value={formData.domain} onChange={handleChange} placeholder="myagent.froste.eu" />
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.3rem' }}>FQDN gets automatic HTTPS via Caddy/Let's Encrypt.</div>
        </div>

        {!isCompose && (
          <div className="form-group" style={{ marginTop: '1.25rem', marginBottom: '1.5rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
              <input type="checkbox" checked={quickStart} onChange={(e) => setQuickStart(e.target.checked)} style={{ width: '18px', height: '18px', cursor: 'pointer' }} />
              <span style={{ fontWeight: 600 }}>Quick Start</span>
              <span style={{ fontSize: '0.875rem', color: 'var(--text-secondary, #94a3b8)' }}>— auto-inject API keys from providers</span>
            </label>
          </div>
        )}

        {!quickStart && !isCompose && selectedRuntime && (
          <>
            <div className="form-group">
              <label>Image <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>(default: {selectedRuntime.defaultImage})</span></label>
              <input type="text" name="image" value={formData.image} onChange={handleChange} placeholder={selectedRuntime.defaultImage} />
            </div>
            <div className="form-group">
              <label>Port <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>(default: {selectedRuntime.defaultPort})</span></label>
              <input type="number" name="port" value={formData.port} onChange={handleChange} placeholder={selectedRuntime.defaultPort} />
            </div>
            {selectedRuntime.configFields.map(field => (
              <div key={field.key} className="form-group">
                <label>{field.label} {field.required && '*'}</label>
                {field.type === 'textarea' ? (
                  <textarea value={formData.config[field.key] || ''} onChange={(e) => handleConfigChange(field.key, e.target.value)} placeholder={field.default || ''} required={field.required} />
                ) : field.type === 'select' ? (
                  <select value={formData.config[field.key] || field.default || ''} onChange={(e) => handleConfigChange(field.key, e.target.value)} required={field.required}>
                    <option value="">Select…</option>
                    {field.options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                  </select>
                ) : (
                  <input type={field.type} value={formData.config[field.key] || ''} onChange={(e) => handleConfigChange(field.key, e.target.value)} placeholder={field.default || field.placeholder || ''} required={field.required} />
                )}
              </div>
            ))}
          </>
        )}

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? 'Creating…' : 'Create Agent'}</button>
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/')}>Cancel</button>
        </div>
      </form>
    </div>
  )
}

export default CreateAgent

import { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { authFetch } from '../lib/auth'
import { AlertTriangle } from 'lucide-react'

function CreateAgent() {
  const navigate = useNavigate()
  const [runtimes, setRuntimes] = useState([])
  const [providers, setProviders] = useState([])
  const [formData, setFormData] = useState({
    name: '',
    runtime: '',
    domain: '',
    image: '',
    port: '',
    config: {}
  })
  const [quickStart, setQuickStart] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchRuntimes()
    fetchProviders()
  }, [])

  async function fetchRuntimes() {
    try {
      const res = await authFetch('/api/runtimes')
      const data = await res.json()
      setRuntimes(data)
      if (data.length > 0) {
        setFormData(prev => ({ ...prev, runtime: data[0].id }))
      }
    } catch (err) {
      console.error('Failed to fetch runtimes:', err)
    }
  }

  async function fetchProviders() {
    try {
      const res = await authFetch('/api/providers')
      const data = await res.json()
      setProviders(data)
    } catch (err) {
      console.error('Failed to fetch providers:', err)
    }
  }

  const selectedRuntime = runtimes.find(r => r.id === formData.runtime)

  function handleChange(e) {
    const { name, value } = e.target
    setFormData(prev => ({ ...prev, [name]: value }))
  }

  function handleConfigChange(key, value) {
    setFormData(prev => ({
      ...prev,
      config: { ...prev.config, [key]: value }
    }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      const payload = {
        name: formData.name,
        runtime: formData.runtime,
        domain: formData.domain || undefined,
        quickStart: quickStart
      }

      if (!quickStart) {
        payload.image = formData.image || undefined
        payload.port = formData.port ? parseInt(formData.port) : undefined
        payload.config = formData.config
      }

      const res = await authFetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Failed to create agent')
      }

      navigate('/')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <h1 style={{ marginBottom: '2rem' }}>Create Agent</h1>

      {error && <div className="error">{error}</div>}

      {providers.length === 0 && (
        <div className="alert alert-warning" style={{ marginBottom: '1.5rem' }}>
          <AlertTriangle size={20} />
          <div>
            <strong>Inga providers konfigurerade!</strong>
            <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.875rem' }}>
              Agenten kommer inte att kunna chatta utan en provider. 
              <Link to="/providers" style={{ color: '#f59e0b', marginLeft: '0.25rem' }}>
                Lägg till en provider först
              </Link>
            </p>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="create-form">
        <div className="form-group">
          <label>Agent Name *</label>
          <input
            type="text"
            name="name"
            value={formData.name}
            onChange={handleChange}
            placeholder="my-agent"
            required
          />
        </div>

        <div className="form-group">
          <label>Runtime *</label>
          <select
            name="runtime"
            value={formData.runtime}
            onChange={handleChange}
            required
          >
            {runtimes.map(rt => (
              <option key={rt.id} value={rt.id}>
                {rt.name} - {rt.description}
              </option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label>Domain (optional)</label>
          <input
            type="text"
            name="domain"
            value={formData.domain}
            onChange={handleChange}
            placeholder="agent.example.com"
          />
        </div>

        <div className="form-group" style={{ marginTop: '1.5rem', marginBottom: '1.5rem' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={quickStart}
              onChange={(e) => setQuickStart(e.target.checked)}
              style={{ width: '18px', height: '18px', cursor: 'pointer' }}
            />
            <span style={{ fontWeight: '600' }}>Quick Start</span>
            <span style={{ fontSize: '0.875rem', color: 'var(--text-secondary, #94a3b8)' }}>
              — Auto-config with API keys from providers
            </span>
          </label>
        </div>

        {!quickStart && selectedRuntime && (
          <>
            <div className="form-group">
              <label>Image (default: {selectedRuntime.defaultImage})</label>
              <input
                type="text"
                name="image"
                value={formData.image}
                onChange={handleChange}
                placeholder={selectedRuntime.defaultImage}
              />
            </div>

            <div className="form-group">
              <label>Port (default: {selectedRuntime.defaultPort})</label>
              <input
                type="number"
                name="port"
                value={formData.port}
                onChange={handleChange}
                placeholder={selectedRuntime.defaultPort}
              />
            </div>

            {selectedRuntime.configFields.map(field => (
              <div key={field.key} className="form-group">
                <label>
                  {field.label} {field.required && '*'}
                </label>
                {field.type === 'textarea' ? (
                  <textarea
                    value={formData.config[field.key] || ''}
                    onChange={(e) => handleConfigChange(field.key, e.target.value)}
                    placeholder={field.default || ''}
                    required={field.required}
                  />
                ) : field.type === 'select' ? (
                  <select
                    value={formData.config[field.key] || field.default || ''}
                    onChange={(e) => handleConfigChange(field.key, e.target.value)}
                    required={field.required}
                  >
                    <option value="">Select...</option>
                    {field.options.map(opt => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={field.type}
                    value={formData.config[field.key] || ''}
                    onChange={(e) => handleConfigChange(field.key, e.target.value)}
                    placeholder={field.default || ''}
                    required={field.required}
                  />
                )}
              </div>
            ))}
          </>
        )}

        {quickStart && (
          <div style={{
            background: 'var(--bg-secondary, #1e293b)',
            borderRadius: '0.5rem',
            padding: '1rem',
            marginBottom: '1.5rem',
            fontSize: '0.875rem',
            color: 'var(--text-secondary, #94a3b8)'
          }}>
            <strong style={{ color: 'var(--text-primary, #e2e8f0)' }}>Quick Start aktiverad</strong>
            <p style={{ margin: '0.5rem 0 0 0' }}>
              Agenten skapas med automatisk konfiguration:
            </p>
            <ul style={{ margin: '0.5rem 0 0 1.5rem', padding: 0 }}>
              <li>API-nycklar injiceras från providers</li>
              <li>Standardmodell väljs automatiskt</li>
              <li>Gateway-token genereras automatiskt</li>
              <li>Full shell-behörighet och förinstallerade verktyg</li>
            </ul>
          </div>
        )}

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Creating...' : 'Create Agent'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/')}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}

export default CreateAgent

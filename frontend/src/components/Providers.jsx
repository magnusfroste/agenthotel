import { useState, useEffect } from 'react'
import { authFetch } from '../lib/auth'

function Providers() {
  const [providers, setProviders] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [editingProvider, setEditingProvider] = useState(null)
  const [formData, setFormData] = useState({
    name: '',
    type: 'openai',
    baseUrl: '',
    apiKey: '',
    models: ''
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchProviders()
  }, [])

  async function fetchProviders() {
    try {
      const res = await authFetch('/api/providers')
      const data = await res.json()
      setProviders(data)
    } catch (err) {
      console.error('Failed to fetch providers:', err)
    }
  }

  function handleChange(e) {
    const { name, value } = e.target
    setFormData(prev => ({ ...prev, [name]: value }))
  }

  function handleEdit(provider) {
    setEditingProvider(provider)
    setFormData({
      name: provider.name,
      type: provider.type,
      baseUrl: provider.baseUrl || '',
      apiKey: provider.apiKey || '',
      models: (provider.models || []).join(', ')
    })
    setShowForm(true)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      const payload = {
        name: formData.name,
        type: formData.type,
        baseUrl: formData.baseUrl || undefined,
        apiKey: formData.apiKey || undefined,
        models: formData.models ? formData.models.split(',').map(m => m.trim()).filter(m => m) : []
      }

      const url = editingProvider ? `/api/providers/${editingProvider.id}` : '/api/providers'
      const method = editingProvider ? 'PUT' : 'POST'

      const res = await authFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Failed to save provider')
      }

      setShowForm(false)
      setEditingProvider(null)
      setFormData({ name: '', type: 'openai', baseUrl: '', apiKey: '', models: '' })
      fetchProviders()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete(id) {
    if (!confirm('Are you sure you want to delete this provider?')) return

    try {
      await authFetch(`/api/providers/${id}`, { method: 'DELETE' })
      fetchProviders()
    } catch (err) {
      console.error('Failed to delete provider:', err)
    }
  }

  return (
    <div>
      <div className="dashboard-header">
        <h1>Providers</h1>
        <button onClick={() => { setShowForm(true); setEditingProvider(null); }} className="btn btn-primary">
          + Add Provider
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {showForm && (
        <div className="create-form" style={{ marginBottom: '2rem' }}>
          <h3>{editingProvider ? 'Edit' : 'Add'} Provider</h3>
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label>Name</label>
              <input
                type="text"
                name="name"
                value={formData.name}
                onChange={handleChange}
                placeholder="OpenRouter"
                required
              />
            </div>

            <div className="form-group">
              <label>Type</label>
              <select name="type" value={formData.type} onChange={handleChange} required>
                <option value="openai">OpenAI Compatible</option>
                <option value="anthropic">Anthropic</option>
                <option value="custom">Custom</option>
              </select>
            </div>

            <div className="form-group">
              <label>Base URL</label>
              <input
                type="text"
                name="baseUrl"
                value={formData.baseUrl}
                onChange={handleChange}
                placeholder="https://openrouter.ai/api/v1"
              />
            </div>

            <div className="form-group">
              <label>API Key</label>
              <input
                type="password"
                name="apiKey"
                value={formData.apiKey}
                onChange={handleChange}
                placeholder="sk-..."
              />
            </div>

            <div className="form-group">
              <label>Models (comma-separated)</label>
              <input
                type="text"
                name="models"
                value={formData.models}
                onChange={handleChange}
                placeholder="gpt-4, gpt-3.5-turbo"
              />
            </div>

            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={loading}>
                {loading ? 'Saving...' : (editingProvider ? 'Update' : 'Add')}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => { setShowForm(false); setEditingProvider(null); }}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {providers.length === 0 ? (
        <div className="empty-state">
          <h2>No providers yet</h2>
          <p>Add a provider to get started</p>
        </div>
      ) : (
        <div className="agents-grid">
          {providers.map(provider => (
            <div key={provider.id} className="agent-card">
              <div className="agent-card-header">
                <div className="agent-name">{provider.name}</div>
                <div className="agent-status status-running">{provider.type}</div>
              </div>
              <div className="agent-info">
                {provider.baseUrl && (
                  <div className="agent-info-item">
                    <span>🌐</span>
                    <span>{provider.baseUrl}</span>
                  </div>
                )}
                {provider.apiKey && (
                  <div className="agent-info-item">
                    <span>🔑</span>
                    <span>{provider.apiKey.substring(0, 10)}...</span>
                  </div>
                )}
                {provider.models && provider.models.length > 0 && (
                  <div className="agent-info-item">
                    <span>🤖</span>
                    <span>{provider.models.join(', ')}</span>
                  </div>
                )}
              </div>
              <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
                <button className="btn btn-secondary" onClick={() => handleEdit(provider)} style={{ flex: 1 }}>
                  Edit
                </button>
                <button className="btn btn-danger" onClick={() => handleDelete(provider.id)} style={{ flex: 1 }}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default Providers

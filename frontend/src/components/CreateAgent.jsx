import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

function CreateAgent() {
  const navigate = useNavigate()
  const [runtimes, setRuntimes] = useState([])
  const [formData, setFormData] = useState({
    name: '',
    runtime: '',
    domain: '',
    image: '',
    port: '',
    config: {}
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchRuntimes()
  }, [])

  async function fetchRuntimes() {
    try {
      const res = await fetch('/api/runtimes')
      const data = await res.json()
      setRuntimes(data)
      if (data.length > 0) {
        setFormData(prev => ({ ...prev, runtime: data[0].id }))
      }
    } catch (err) {
      console.error('Failed to fetch runtimes:', err)
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
        image: formData.image || undefined,
        port: formData.port ? parseInt(formData.port) : undefined,
        config: formData.config
      }

      const res = await fetch('/api/agents', {
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

        {selectedRuntime && (
          <>
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

import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { authFetch } from '../lib/auth'

function EditAgent() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [agent, setAgent] = useState(null)
  const [formData, setFormData] = useState({ domain: '', config: {} })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchAgent()
  }, [id])

  async function fetchAgent() {
    try {
      const res = await authFetch(`/api/agents/${id}`)
      const data = await res.json()
      setAgent(data)
      setFormData({
        domain: data.domain || '',
        config: data.config || {}
      })
    } catch (err) {
      console.error('Failed to fetch agent:', err)
      setError('Failed to load agent')
    }
  }

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
        domain: formData.domain || undefined,
        config: formData.config
      }

      const res = await authFetch(`/api/agents/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Failed to update agent')
      }

      navigate(`/agent/${id}`)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  if (!agent) {
    return <div className="loading">Loading agent...</div>
  }

  return (
    <div>
      <h1 style={{ marginBottom: '2rem' }}>Edit Agent: {agent.name}</h1>

      {error && <div className="error">{error}</div>}

      <form onSubmit={handleSubmit} className="create-form">
        <div className="form-group">
          <label>Domain</label>
          <input
            type="text"
            name="domain"
            value={formData.domain}
            onChange={handleChange}
            placeholder="agent.example.com"
          />
        </div>

        <h3 style={{ marginTop: '2rem', marginBottom: '1rem', color: '#cbd5e1' }}>Configuration</h3>
        
        {Object.entries(formData.config).map(([key, value]) => (
          <div key={key} className="form-group">
            <label>{key}</label>
            <input
              type={key.toLowerCase().includes('key') || key.toLowerCase().includes('token') || key.toLowerCase().includes('password') ? 'password' : 'text'}
              value={value}
              onChange={(e) => handleConfigChange(key, e.target.value)}
            />
          </div>
        ))}

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Updating...' : 'Update & Redeploy'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => navigate(`/agent/${id}`)}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}

export default EditAgent

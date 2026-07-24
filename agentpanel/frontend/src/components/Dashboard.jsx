import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'

function Dashboard() {
  const [agents, setAgents] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchAgents()
  }, [])

  async function fetchAgents() {
    try {
      const res = await fetch('/api/agents')
      const data = await res.json()
      setAgents(data)
    } catch (err) {
      console.error('Failed to fetch agents:', err)
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete(id, name) {
    if (!confirm(`Are you sure you want to delete ${name}?`)) return
    
    try {
      await fetch(`/api/agents/${id}`, { method: 'DELETE' })
      fetchAgents()
    } catch (err) {
      console.error('Failed to delete agent:', err)
    }
  }

  if (loading) {
    return <div className="loading">Loading agents...</div>
  }

  return (
    <div>
      <div className="dashboard-header">
        <h1>Agent Fleet</h1>
        <Link to="/create" className="btn btn-primary">+ Create Agent</Link>
      </div>

      {agents.length === 0 ? (
        <div className="empty-state">
          <h2>No agents yet</h2>
          <p>Create your first agent to get started</p>
        </div>
      ) : (
        <div className="agents-grid">
          {agents.map(agent => (
            <div key={agent.id} className="agent-card">
              <Link to={`/agent/${agent.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                <div className="agent-card-header">
                  <div className="agent-name">{agent.name}</div>
                  <div className={`agent-status status-${agent.status}`}>
                    {agent.status}
                  </div>
                </div>
                <div className="agent-info">
                  <div className="agent-info-item">
                    <span>🔧</span>
                    <span>{agent.runtime}</span>
                  </div>
                  <div className="agent-info-item">
                    <span>🌐</span>
                    <span>{agent.domain || 'No domain'}</span>
                  </div>
                  <div className="agent-info-item">
                    <span>📦</span>
                    <span>{agent.image}</span>
                  </div>
                  <div className="agent-info-item">
                    <span>🔌</span>
                    <span>Port {agent.port}</span>
                  </div>
                </div>
              </Link>
              <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
                <button 
                  className="btn btn-danger" 
                  onClick={(e) => {
                    e.preventDefault()
                    handleDelete(agent.id, agent.name)
                  }}
                  style={{ flex: 1 }}
                >
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

export default Dashboard

import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { authFetch } from '../lib/auth'

function Dashboard() {
  const [agents, setAgents] = useState([])
  const [loading, setLoading] = useState(true)
  const [systemStats, setSystemStats] = useState(null)
  const [pruning, setPruning] = useState(false)

  useEffect(() => {
    fetchAgents()
    fetchSystemStats()
    const interval = setInterval(fetchSystemStats, 10000)
    return () => clearInterval(interval)
  }, [])

  async function fetchAgents() {
    try {
      const res = await authFetch('/api/agents')
      const data = await res.json()
      setAgents(data)
    } catch (err) {
      console.error('Failed to fetch agents:', err)
    } finally {
      setLoading(false)
    }
  }

  async function fetchSystemStats() {
    try {
      const res = await authFetch('/api/system/stats')
      const data = await res.json()
      setSystemStats(data)
    } catch (err) {
      console.error('Failed to fetch system stats:', err)
    }
  }

  async function handlePrune() {
    if (!confirm('This will remove unused Docker resources (containers, images, networks, volumes). Continue?')) return
    
    setPruning(true)
    try {
      const res = await authFetch('/api/docker/prune', { method: 'POST' })
      const data = await res.json()
      alert(`Pruned! Freed ${data.totalSpaceReclaimedMB} MB`)
      fetchSystemStats()
    } catch (err) {
      console.error('Failed to prune:', err)
      alert('Failed to prune Docker resources')
    } finally {
      setPruning(false)
    }
  }

  async function handleDelete(id, name) {
    if (!confirm(`Are you sure you want to delete ${name}?`)) return
    
    try {
      await authFetch(`/api/agents/${id}`, { method: 'DELETE' })
      fetchAgents()
    } catch (err) {
      console.error('Failed to delete agent:', err)
    }
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i]
  }

  if (loading) {
    return <div className="loading">Loading agents...</div>
  }

  return (
    <div>
      <div className="dashboard-header">
        <h1>Agent Fleet</h1>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button 
            className="btn" 
            onClick={handlePrune}
            disabled={pruning}
            style={{ background: '#f59e0b', color: 'white' }}
          >
            {pruning ? 'Pruning...' : '🧹 Prune Docker'}
          </button>
          <Link to="/create" className="btn btn-primary">+ Create Agent</Link>
        </div>
      </div>

      {systemStats && systemStats.cpu && systemStats.mem && systemStats.disk && (
        <div className="system-stats" style={{ 
          display: 'grid', 
          gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', 
          gap: '1rem', 
          marginBottom: '2rem',
          padding: '1rem',
          background: 'var(--bg-secondary, #1e293b)',
          borderRadius: '0.5rem'
        }}>
          <div>
            <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary, #94a3b8)', marginBottom: '0.5rem' }}>CPU Usage</div>
            <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{systemStats.cpu.pct}%</div>
            <div style={{ 
              height: '8px', 
              background: 'var(--bg-primary, #0f172a)', 
              borderRadius: '4px', 
              marginTop: '0.5rem',
              overflow: 'hidden'
            }}>
              <div style={{ 
                width: `${systemStats.cpu.pct}%`, 
                height: '100%', 
                background: systemStats.cpu.pct > 80 ? '#ef4444' : systemStats.cpu.pct > 60 ? '#f59e0b' : '#10b981',
                transition: 'width 0.3s'
              }} />
            </div>
          </div>
          <div>
            <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary, #94a3b8)', marginBottom: '0.5rem' }}>Memory Usage</div>
            <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>
              {formatBytes(systemStats.mem.used)} / {formatBytes(systemStats.mem.total)}
            </div>
            <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary, #94a3b8)' }}>
              {systemStats.mem.pct}% used
            </div>
            <div style={{ 
              height: '8px', 
              background: 'var(--bg-primary, #0f172a)', 
              borderRadius: '4px', 
              marginTop: '0.5rem',
              overflow: 'hidden'
            }}>
              <div style={{ 
                width: `${systemStats.mem.pct}%`, 
                height: '100%', 
                background: systemStats.mem.pct > 80 ? '#ef4444' : systemStats.mem.pct > 60 ? '#f59e0b' : '#10b981',
                transition: 'width 0.3s'
              }} />
            </div>
          </div>
          <div>
            <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary, #94a3b8)', marginBottom: '0.5rem' }}>Disk Usage</div>
            <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>
              {formatBytes(systemStats.disk.used)} / {formatBytes(systemStats.disk.total)}
            </div>
            <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary, #94a3b8)' }}>
              {systemStats.disk.pct}% used
            </div>
            <div style={{ 
              height: '8px', 
              background: 'var(--bg-primary, #0f172a)', 
              borderRadius: '4px', 
              marginTop: '0.5rem',
              overflow: 'hidden'
            }}>
              <div style={{ 
                width: `${systemStats.disk.pct}%`, 
                height: '100%', 
                background: systemStats.disk.pct > 80 ? '#ef4444' : systemStats.disk.pct > 60 ? '#f59e0b' : '#10b981',
                transition: 'width 0.3s'
              }} />
            </div>
          </div>
        </div>
      )}

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

import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { authFetch } from '../lib/auth'
import { Trash2, Settings, Globe, Package, Plug } from 'lucide-react'

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

  function getProgressClass(pct) {
    if (pct > 80) return 'high'
    if (pct > 60) return 'medium'
    return 'low'
  }

  if (loading) {
    return (
      <div className="loading">
        <div>
          <div className="loading-spinner" />
          <div>Loading agents...</div>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Agent Fleet</h1>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button 
            className="btn" 
            onClick={handlePrune}
            disabled={pruning}
            style={{ background: '#f59e0b', color: 'white' }}
          >
            <Trash2 size={18} color="white" />
            {pruning ? 'Pruning...' : 'Prune Docker'}
          </button>
          <Link to="/create" className="btn btn-primary">+ Create Agent</Link>
        </div>
      </div>

      {systemStats && systemStats.cpu && systemStats.mem && systemStats.disk && (
        <div className="stats-grid">
          <div className="stat-item">
            <div className="stat-label">CPU Usage</div>
            <div className="stat-value">{systemStats.cpu.pct}%</div>
            <div className="progress-bar">
              <div 
                className={`progress-fill ${getProgressClass(systemStats.cpu.pct)}`}
                style={{ width: `${systemStats.cpu.pct}%` }}
              />
            </div>
          </div>
          <div className="stat-item">
            <div className="stat-label">Memory Usage</div>
            <div className="stat-value">
              {formatBytes(systemStats.mem.used)} / {formatBytes(systemStats.mem.total)}
            </div>
            <div className="stat-subtext">{systemStats.mem.pct}% used</div>
            <div className="progress-bar">
              <div 
                className={`progress-fill ${getProgressClass(systemStats.mem.pct)}`}
                style={{ width: `${systemStats.mem.pct}%` }}
              />
            </div>
          </div>
          <div className="stat-item">
            <div className="stat-label">Disk Usage</div>
            <div className="stat-value">
              {formatBytes(systemStats.disk.used)} / {formatBytes(systemStats.disk.total)}
            </div>
            <div className="stat-subtext">{systemStats.disk.pct}% used</div>
            <div className="progress-bar">
              <div 
                className={`progress-fill ${getProgressClass(systemStats.disk.pct)}`}
                style={{ width: `${systemStats.disk.pct}%` }}
              />
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
        <div className="grid grid-cols-2">
          {agents.map(agent => (
            <div key={agent.id} className="card">
              <Link to={`/agent/${agent.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                <div className="card-header">
                  <div className="card-title">{agent.name}</div>
                  <div className={`status-badge status-${agent.status}`}>
                    {agent.status}
                  </div>
                </div>
                <div className="info-list">
                  <div className="info-item">
                    <Settings size={16} color="white" />
                    <span>{agent.runtime}</span>
                  </div>
                  <div className="info-item">
                    <Globe size={16} color="white" />
                    <span>{agent.domain || 'No domain'}</span>
                  </div>
                  <div className="info-item">
                    <Package size={16} color="white" />
                    <span>{agent.image}</span>
                  </div>
                  <div className="info-item">
                    <Plug size={16} color="white" />
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

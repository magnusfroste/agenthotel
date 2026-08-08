import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { authFetch } from '../lib/auth'
import { useToast } from './Toast'
import { Trash2, Globe, Package, ExternalLink, Play, Square, MoreHorizontal, Bot, Plus, Layers, Upload } from 'lucide-react'

function Dashboard() {
  const [agents, setAgents] = useState([])
  const [loading, setLoading] = useState(true)
  const [systemStats, setSystemStats] = useState(null)
  const [pruning, setPruning] = useState(false)
  const toast = useToast()

  useEffect(() => {
    fetchAgents()
    fetchSystemStats()
    const interval = setInterval(() => { fetchAgents(); fetchSystemStats() }, 10000)
    return () => clearInterval(interval)
  }, [])

  async function fetchAgents() {
    try {
      const res = await authFetch('/api/agents')
      setAgents(await res.json())
    } catch (err) { console.error('Failed to fetch agents:', err) }
    finally { setLoading(false) }
  }

  async function fetchSystemStats() {
    try {
      const res = await authFetch('/api/system/stats')
      setSystemStats(await res.json())
    } catch (err) { console.error('Failed to fetch system stats:', err) }
  }

  async function handlePrune() {
    if (!confirm('Remove unused Docker resources (containers, images, networks, volumes)?')) return
    setPruning(true)
    try {
      const res = await authFetch('/api/docker/prune', { method: 'POST' })
      const data = await res.json()
      toast.success(`Pruned! Freed ${data.totalSpaceReclaimedMB} MB`)
      fetchSystemStats()
    } catch (err) { toast.error('Failed to prune Docker resources') }
    finally { setPruning(false) }
  }

  async function toggleAgent(id, status) {
    const action = status === 'running' ? 'stop' : 'start'
    try { 
      await authFetch(`/api/agents/${id}/${action}`, { method: 'POST' })
      fetchAgents()
      toast.success(`Agent ${action === 'start' ? 'started' : 'stopped'}`)
    }
    catch (err) { toast.error('Action failed') }
  }

  async function handleDelete(id, name) {
    if (!confirm(`Delete ${name}? This cannot be undone.`)) return
    try { await authFetch(`/api/agents/${id}`, { method: 'DELETE' }); fetchAgents() }
    catch (err) { console.error('Failed to delete agent:', err) }
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

  const statusColor = (s) => s === 'running' ? '#10b981' : s === 'stopped' ? '#ef4444' : '#f59e0b'

  async function handleImportService(e) {
    const file = e.target.files && e.target.files[0]
    if (!file) return
    try {
      const res = await authFetch('/api/agents/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: file
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Import failed')
      toast.success(`Agent "${data.name}" imported as stopped${data.volumesRestored ? ` with ${data.volumesRestored} volume(s) restored` : ''} — redeploy it to start`)
      fetchAgents()
    } catch (err) {
      toast.error('Import failed: ' + err.message)
    } finally {
      e.target.value = ''
    }
  }

  if (loading) {
    return (
      <div>
        <div className="page-header">
          <h1 className="page-title">Agent Fleet</h1>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <div style={{ width: '140px', height: '36px', background: 'var(--bg-secondary)', borderRadius: '0.5rem', animation: 'pulse 1.5s ease-in-out infinite' }} />
            <div style={{ width: '140px', height: '36px', background: 'var(--bg-secondary)', borderRadius: '0.5rem', animation: 'pulse 1.5s ease-in-out infinite' }} />
          </div>
        </div>
        <div className="stats-grid">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="stat-item" style={{ animation: 'pulse 1.5s ease-in-out infinite' }}>
              <div style={{ width: '60%', height: '20px', background: 'var(--bg-secondary)', borderRadius: '0.25rem', marginBottom: '0.5rem' }} />
              <div style={{ width: '40%', height: '16px', background: 'var(--bg-secondary)', borderRadius: '0.25rem', marginBottom: '0.75rem' }} />
              <div style={{ width: '100%', height: '8px', background: 'var(--bg-secondary)', borderRadius: '0.25rem' }} />
            </div>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '1rem', marginTop: '2rem' }}>
          {[...Array(3)].map((_, i) => (
            <div key={i} style={{ background: 'var(--bg-secondary)', borderRadius: '0.6rem', padding: '1.1rem', animation: 'pulse 1.5s ease-in-out infinite' }}>
              <div style={{ width: '60%', height: '20px', background: 'var(--bg-tertiary)', borderRadius: '0.25rem', marginBottom: '0.5rem' }} />
              <div style={{ width: '40%', height: '14px', background: 'var(--bg-tertiary)', borderRadius: '0.25rem', marginBottom: '1rem' }} />
              <div style={{ width: '80%', height: '14px', background: 'var(--bg-tertiary)', borderRadius: '0.25rem', marginBottom: '0.5rem' }} />
              <div style={{ width: '70%', height: '14px', background: 'var(--bg-tertiary)', borderRadius: '0.25rem' }} />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Agent Fleet</h1>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn" onClick={handlePrune} disabled={pruning} style={{ background: '#f59e0b', color: 'white', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <Trash2 size={16} color="white" /> {pruning ? 'Pruning…' : 'Prune Docker'}
          </button>
          <label className="btn btn-secondary" title="Import a service zip exported from any AgentPanel" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', margin: 0 }}>
            <Upload size={16} color="currentColor" /> Import Agent
            <input type="file" accept=".zip,application/zip" onChange={handleImportService} style={{ display: 'none' }} />
          </label>
          <Link to="/create" className="btn btn-primary">+ Create Agent</Link>
        </div>
      </div>

      {systemStats && systemStats.cpu && systemStats.mem && systemStats.disk && (
        <div className="stats-grid">
          <div className="stat-item">
            <div className="stat-label">CPU</div>
            <div className="stat-value">{systemStats.cpu.pct}%</div>
            <div className="progress-bar"><div className={`progress-fill ${getProgressClass(systemStats.cpu.pct)}`} style={{ width: `${systemStats.cpu.pct}%` }} /></div>
          </div>
          <div className="stat-item">
            <div className="stat-label">Memory</div>
            <div className="stat-value">{formatBytes(systemStats.mem.used)} / {formatBytes(systemStats.mem.total)}</div>
            <div className="stat-subtext">{systemStats.mem.pct}% used</div>
            <div className="progress-bar"><div className={`progress-fill ${getProgressClass(systemStats.mem.pct)}`} style={{ width: `${systemStats.mem.pct}%` }} /></div>
          </div>
          <div className="stat-item">
            <div className="stat-label">Disk</div>
            <div className="stat-value">{formatBytes(systemStats.disk.used)} / {formatBytes(systemStats.disk.total)}</div>
            <div className="stat-subtext">{systemStats.disk.pct}% used</div>
            <div className="progress-bar"><div className={`progress-fill ${getProgressClass(systemStats.disk.pct)}`} style={{ width: `${systemStats.disk.pct}%` }} /></div>
          </div>
        </div>
      )}

      {agents.length === 0 ? (
        <div className="empty-state">
          <div style={{ 
            width: '80px', 
            height: '80px', 
            borderRadius: '50%', 
            background: 'var(--bg-tertiary)', 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center',
            margin: '0 auto 1.5rem'
          }}>
            <Bot size={40} color="var(--text-secondary)" />
          </div>
          <h2 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>No agents yet</h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem', maxWidth: '400px', margin: '0 auto 1.5rem' }}>
            Deploy your first AI agent or Docker Compose app to get started with AgentPanel.
          </p>
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', marginTop: '1rem' }}>
            <Link to="/create" className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Plus size={16} color="white" /> Create Agent
            </Link>
            <Link to="/compose" className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Layers size={16} color="white" /> Deploy Compose
            </Link>
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '1rem' }}>
          {agents.map(agent => {
            const url = agent.domain && agent.domain.includes('.') ? `https://${agent.domain}` : null
            return (
              <div key={agent.id} className="agent-card">
                <Link to={`/agent/${agent.id}`} className="agent-card-content" style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div className="agent-card-header">
                    <div style={{ minWidth: 0 }}>
                      <div className="agent-card-title">{agent.name}</div>
                      <div className="agent-card-subtitle">{agent.runtime}</div>
                    </div>
                    <span className="status-badge" style={{ background: statusColor(agent.status) }}>
                      {agent.status}
                    </span>
                  </div>
                  <div className="agent-card-meta">
                    <div className={`agent-card-meta-item ${url ? 'clickable' : ''}`}>
                      <Globe size={14} color="currentColor" />
                      <span style={{ fontFamily: 'monospace' }}>{agent.domain || 'no domain'}</span>
                    </div>
                    <div className="agent-card-meta-item">
                      <Package size={14} color="currentColor" />
                      <span>{agent.image?.split('/').pop()}</span>
                    </div>
                  </div>
                </Link>
                <div className="agent-card-actions">
                  {url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer" className="btn btn-secondary">
                      <ExternalLink size={14} color="currentColor" /> Open
                    </a>
                  ) : (
                    <Link to={`/agent/${agent.id}`} className="btn btn-secondary">
                      <MoreHorizontal size={14} color="currentColor" /> Manage
                    </Link>
                  )}
                  <button 
                    className="btn" 
                    title={agent.status === 'running' ? 'Stop' : 'Start'} 
                    onClick={(e) => { e.preventDefault(); toggleAgent(agent.id, agent.status) }}
                    style={{ background: agent.status === 'running' ? 'var(--accent-yellow)' : 'var(--accent-green)', color: 'white' }}
                  >
                    {agent.status === 'running' ? <Square size={14} color="white" /> : <Play size={14} color="white" />}
                  </button>
                  <button 
                    className="btn btn-danger" 
                    title="Delete" 
                    onClick={(e) => { e.preventDefault(); handleDelete(agent.id, agent.name) }}
                  >
                    <Trash2 size={14} color="white" />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default Dashboard

import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { authFetch } from '../lib/auth'
import { useToast } from './Toast'
import { Trash2, Globe, Package, Plug, ExternalLink, Play, Square, MoreHorizontal } from 'lucide-react'

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

  if (loading) {
    return (
      <div className="loading">
        <div>
          <div className="loading-spinner" />
          <div>Loading…</div>
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
          <h2>No agents yet</h2>
          <p>Deploy your first agent or Docker Compose app to get started.</p>
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', marginTop: '1rem' }}>
            <Link to="/create" className="btn btn-primary">+ Create Agent</Link>
            <Link to="/compose" className="btn btn-secondary">Deploy Compose</Link>
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '1rem' }}>
          {agents.map(agent => {
            const url = agent.domain && agent.domain.includes('.') ? `https://${agent.domain}` : null
            return (
              <div key={agent.id} style={{ background: 'var(--bg-secondary, #1e293b)', borderRadius: '0.6rem', border: '1px solid var(--border, #334155)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                <Link to={`/agent/${agent.id}`} style={{ textDecoration: 'none', color: 'inherit', padding: '1.1rem 1.1rem 0.85rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--text-primary, #e2e8f0)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{agent.name}</div>
                      <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>{agent.runtime}</div>
                    </div>
                    <span style={{ flexShrink: 0, padding: '0.15rem 0.6rem', borderRadius: '1rem', fontSize: '0.7rem', fontWeight: 600, background: statusColor(agent.status), color: 'white', textTransform: 'uppercase' }}>{agent.status}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.75rem', fontSize: '0.82rem', color: url ? '#60a5fa' : 'var(--text-secondary)' }}>
                    <Globe size={14} color="currentColor" />
                    <span style={{ fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agent.domain || 'no domain'}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.3rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                    <Package size={14} color="currentColor" />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agent.image?.split('/').pop()}</span>
                  </div>
                </Link>
                <div style={{ marginTop: 'auto', padding: '0.6rem 1.1rem 1.1rem', display: 'flex', gap: '0.4rem', borderTop: '1px solid var(--border, #334155)' }}>
                  {url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer" className="btn btn-secondary" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem', textDecoration: 'none', fontSize: '0.82rem', padding: '0.4rem' }}><ExternalLink size={14} color="white" /> Open</a>
                  ) : (
                    <Link to={`/agent/${agent.id}`} className="btn btn-secondary" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem', textDecoration: 'none', fontSize: '0.82rem', padding: '0.4rem' }}><MoreHorizontal size={14} color="white" /> Manage</Link>
                  )}
                  <button className="btn" title={agent.status === 'running' ? 'Stop' : 'Start'} onClick={(e) => { e.preventDefault(); toggleAgent(agent.id, agent.status) }} style={{ background: agent.status === 'running' ? '#f59e0b' : '#10b981', color: 'white', padding: '0.4rem 0.6rem', display: 'flex', alignItems: 'center' }}>
                    {agent.status === 'running' ? <Square size={14} color="white" /> : <Play size={14} color="white" />}
                  </button>
                  <button className="btn btn-danger" title="Delete" onClick={(e) => { e.preventDefault(); handleDelete(agent.id, agent.name) }} style={{ padding: '0.4rem 0.6rem', display: 'flex', alignItems: 'center' }}><Trash2 size={14} color="white" /></button>
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

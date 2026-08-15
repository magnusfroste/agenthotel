import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { authFetch } from '../lib/auth'
import { useToast } from './Toast'
import { Monitor, BarChart3, Globe, Plug, Trash2, Terminal, RefreshCw, Download, AlertTriangle, Activity, ChevronRight, Server, Cpu, Clock, Container, GitBranch, Power, HardDrive } from 'lucide-react'

function System() {
  const [systemInfo, setSystemInfo] = useState(null)
  const [systemStats, setSystemStats] = useState(null)
  const [mcpStatus, setMcpStatus] = useState(null)
  const [cleanupHistory, setCleanupHistory] = useState([])
  const [orphanedVolumes, setOrphanedVolumes] = useState(null)
  const [pruningVolumes, setPruningVolumes] = useState(false)
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [cleaning, setCleaning] = useState(false)
  const [confirmAction, setConfirmAction] = useState(null)
  const toast = useToast()

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

  useEffect(() => {
    fetchSystemInfo()
    fetchSystemStats()
    fetchMcpStatus()
    fetchCleanupHistory()
    fetchOrphanedVolumes()
    fetchEvents()
    const interval = setInterval(() => { if (!document.hidden) fetchSystemStats() }, 5000)
    const eventsInterval = setInterval(() => { if (!document.hidden) fetchEvents() }, 15000)
    return () => { clearInterval(interval); clearInterval(eventsInterval) }
  }, [])

  async function fetchSystemInfo() {
    try {
      const res = await authFetch('/api/system/status')
      setSystemInfo(await res.json())
    } catch (err) {
      console.error('Failed to fetch system info:', err)
    } finally {
      setLoading(false)
    }
  }

  async function fetchSystemStats() {
    try {
      const res = await authFetch('/api/system/stats')
      setSystemStats(await res.json())
    } catch (err) {
      console.error('Failed to fetch system stats:', err)
    }
  }

  async function fetchMcpStatus() {
    try {
      const res = await authFetch('/api/system/mcp-status')
      setMcpStatus(await res.json())
    } catch (err) {
      console.error('Failed to fetch MCP status:', err)
    }
  }

  async function fetchCleanupHistory() {
    try {
      const res = await authFetch('/api/docker/cleanup-history?limit=10')
      setCleanupHistory(await res.json())
    } catch (err) {
      console.error('Failed to fetch cleanup history:', err)
    }
  }

  async function fetchOrphanedVolumes() {
    try {
      const res = await authFetch('/api/docker/orphaned-volumes')
      setOrphanedVolumes(await res.json())
    } catch (err) {
      console.error('Failed to fetch orphaned volumes:', err)
      setOrphanedVolumes([])
    }
  }

  async function deleteVolume(name) {
    if (!confirm(`Delete volume ${name}? This cannot be undone.`)) return
    try {
      const res = await authFetch(`/api/docker/volumes/${encodeURIComponent(name)}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Delete failed')
      toast.success(`Volume ${name} deleted`)
      fetchOrphanedVolumes()
    } catch (err) {
      toast.error('Delete failed: ' + err.message)
    }
  }

  async function pruneVolumes() {
    if (!orphanedVolumes || orphanedVolumes.length === 0) return
    if (!confirm(`Delete all ${orphanedVolumes.length} orphaned volumes? This cannot be undone.`)) return
    setPruningVolumes(true)
    try {
      const res = await authFetch('/api/docker/prune-volumes', { method: 'POST' })
      const data = await res.json()
      if (data.success) {
        toast.success(`Deleted ${data.deleted} orphaned volume(s)`)
      } else {
        toast.warning(`Deleted ${data.deleted}, ${data.failed.length} failed`)
      }
      fetchOrphanedVolumes()
    } catch (err) {
      toast.error('Prune failed: ' + err.message)
    } finally {
      setPruningVolumes(false)
    }
  }

  async function fetchEvents() {
    try {
      const res = await authFetch('/api/events?limit=20')
      setEvents(await res.json())
    } catch (err) {
      console.error('Failed to fetch events:', err)
    }
  }

  async function runCleanup() {
    setCleaning(true)
    try {
      const res = await authFetch('/api/docker/prune', { method: 'POST' })
      const data = await res.json()
      if (data.success) {
        const r = data.results || {}
        // Build cache is usually the bulk of what a panel host reclaims, so
        // break it out — a bare total hides where the space actually went.
        const parts = [
          r.containers?.length ? `${r.containers.length} container(s)` : null,
          r.images?.length ? `${r.images.length} image(s)` : null,
          r.buildCacheSpaceReclaimed ? `${(r.buildCacheSpaceReclaimed / 1024 / 1024).toFixed(0)} MB build cache` : null
        ].filter(Boolean)
        toast.success(`Cleanup completed! Reclaimed ${data.totalSpaceReclaimedMB} MB${parts.length ? ' — ' + parts.join(', ') : ''}`)
        if (r.buildCacheError) toast.error('Build cache could not be pruned: ' + r.buildCacheError)
        fetchCleanupHistory()
      } else {
        toast.error('Cleanup failed: ' + (data.error || 'Unknown error'))
      }
    } catch (err) {
      toast.error('Cleanup failed: ' + err.message)
    } finally {
      setCleaning(false)
    }
  }

  async function enableMcp() {
    try {
      const res = await authFetch('/api/system/mcp-enable', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to enable MCP')
      } else {
        toast.success(data.message || 'MCP enabled')
      }
      fetchMcpStatus()
    } catch (err) {
      toast.error('Failed to enable MCP: ' + err.message)
    }
  }

  async function executeSystemAction(action) {
    try {
      const res = await authFetch(`/api/system/${action}`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        // e.g. 501 when the action must be performed on the host via ssh
        toast.error(data.error || 'Action failed')
      } else {
        toast.success(data.message || 'Action executed')
      }
    } catch (err) {
      toast.error('Action failed: ' + err.message)
    } finally {
      setConfirmAction(null)
    }
  }

  if (loading) {
    return (
      <div>
        <div className="page-header">
          <div>
            <div className="skeleton skeleton-title" />
            <div className="skeleton" style={{ width: '320px', height: '18px', marginTop: '0.5rem' }} />
          </div>
        </div>
        <div className="skeleton skeleton-block" />
        <div className="skeleton skeleton-block" />
        <div className="skeleton skeleton-block" />
      </div>
    )
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">System</h1>
          <p className="page-subtitle">Server health, Docker maintenance and host controls</p>
        </div>
      </div>

      {systemInfo && (
        <section className="settings-section">
          <div className="section-header">
            <h2><Monitor size={20} /> System Information</h2>
          </div>
          <div className="sysinfo-grid">
            <div className="sysinfo-item">
              <Server size={18} className="sysinfo-icon" />
              <div>
                <div className="sysinfo-label">Hostname</div>
                <div className="sysinfo-value">{systemInfo.hostname}</div>
              </div>
            </div>
            <div className="sysinfo-item">
              <Monitor size={18} className="sysinfo-icon" />
              <div>
                <div className="sysinfo-label">OS</div>
                <div className="sysinfo-value">{systemInfo.os}</div>
              </div>
            </div>
            <div className="sysinfo-item">
              <Cpu size={18} className="sysinfo-icon" />
              <div>
                <div className="sysinfo-label">Kernel</div>
                <div className="sysinfo-value">{systemInfo.kernel}</div>
              </div>
            </div>
            <div className="sysinfo-item">
              <Clock size={18} className="sysinfo-icon" />
              <div>
                <div className="sysinfo-label">Uptime</div>
                <div className="sysinfo-value">{systemInfo.uptime}</div>
              </div>
            </div>
            <div className="sysinfo-item">
              <Container size={18} className="sysinfo-icon" />
              <div>
                <div className="sysinfo-label">Docker</div>
                <div className="sysinfo-value">{systemInfo.dockerVersion}</div>
              </div>
            </div>
            <div className="sysinfo-item">
              <GitBranch size={18} className="sysinfo-icon" />
              <div>
                <div className="sysinfo-label">AgentPanel</div>
                <div className="sysinfo-value">{systemInfo.agentpanel.branch} ({systemInfo.agentpanel.commit})</div>
              </div>
            </div>
          </div>
        </section>
      )}

      {systemStats && systemStats.cpu && systemStats.mem && systemStats.disk && (
        <section className="settings-section">
          <div className="section-header">
            <h2><BarChart3 size={20} /> Resource Usage</h2>
          </div>
          <div className="stats-grid">
            <div className="stat-item">
              <div className="stat-label">CPU</div>
              <div className="stat-value">{systemStats.cpu.pct}%</div>
              <div className="stat-subtext">
                {systemStats.cpu.cores} cores @ {systemStats.cpu.frequency} MHz · load {systemStats.cpu.load.join(', ')}
              </div>
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
        </section>
      )}

      {systemStats && systemStats.network && (
        <section className="settings-section">
          <div className="section-header">
            <h2><Globe size={20} /> Network</h2>
          </div>
          <div className="network-grid">
            {Object.entries(systemStats.network).map(([iface, info]) => (
              <div key={iface} className="network-card">
                <div className="network-card-name">{iface}</div>
                {info.ip && <div className="network-card-detail">IP: <span className="text-mono">{info.ip}</span></div>}
                {info.rx && <div className="network-card-detail">↓ {info.rx}</div>}
                {info.tx && <div className="network-card-detail">↑ {info.tx}</div>}
              </div>
            ))}
          </div>
        </section>
      )}

      {mcpStatus && (
        <section className="settings-section">
          <div className="section-header">
            <h2><Plug size={20} /> MCP Server</h2>
          </div>
          <div className="sysinfo-grid">
            <div className="sysinfo-item">
              <div>
                <div className="sysinfo-label">Status</div>
                <div className="sysinfo-value" style={{
                  color: mcpStatus.running ? 'var(--accent-green)' : mcpStatus.configured ? 'var(--accent-yellow)' : 'var(--accent-red)'
                }}>
                  {mcpStatus.running ? '● Running' : mcpStatus.configured ? '● Configured' : '● Not configured'}
                </div>
              </div>
            </div>
            <div className="sysinfo-item">
              <div>
                <div className="sysinfo-label">Installed</div>
                <div className="sysinfo-value">{mcpStatus.installed ? 'Yes' : 'No'}</div>
              </div>
            </div>
            {mcpStatus.endpoint && (
              <div className="sysinfo-item">
                <div>
                  <div className="sysinfo-label">Endpoint</div>
                  <div className="sysinfo-value text-mono">{mcpStatus.endpoint}</div>
                </div>
              </div>
            )}
            {mcpStatus.token && (
              <div className="sysinfo-item">
                <div>
                  <div className="sysinfo-label">Token</div>
                  <div className="sysinfo-value text-mono">{mcpStatus.token}</div>
                </div>
              </div>
            )}
          </div>
          {!mcpStatus.configured && (
            <button onClick={enableMcp} className="btn btn-primary">
              Enable MCP
            </button>
          )}
          {mcpStatus.configured && (
            <div className="info-box">
              <div className="info-box-title">MCP Endpoint</div>
              <code>https://{window.location.hostname}/mcp</code>
              <div className="info-box-title" style={{ marginTop: '1rem' }}>Available Tools</div>
              <ul>
                <li>list_agents — List all managed agents</li>
                <li>create_agent — Create new agent</li>
                <li>delete_agent — Remove agent</li>
                <li>redeploy_agent — Redeploy with latest image</li>
                <li>get_agent_logs — View agent logs</li>
                <li>system_status — System information</li>
                <li>list_runtimes — Available runtimes</li>
              </ul>
            </div>
          )}
        </section>
      )}

      <section className="settings-section">
        <div className="section-header">
          <h2><Trash2 size={20} /> Docker Cleanup</h2>
          <button onClick={runCleanup} className="btn btn-secondary" disabled={cleaning}>
            {cleaning ? 'Running…' : 'Run Cleanup Now'}
          </button>
        </div>
        <p className="section-description">
          Automatic daily cleanup runs at midnight. Removes unused containers, images, networks, and volumes.
        </p>
        {cleanupHistory.length > 0 ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Status</th>
                  <th className="num">Containers</th>
                  <th className="num">Images</th>
                  <th className="num">Networks</th>
                  <th className="num">Volumes</th>
                  <th className="num">Space Reclaimed</th>
                </tr>
              </thead>
              <tbody>
                {cleanupHistory.map((log) => (
                  <tr key={log.id}>
                    <td>{new Date(log.executed_at).toLocaleString()}</td>
                    <td>
                      <span className={log.success ? 'text-success' : 'text-danger'}>
                        {log.success ? '✓ Success' : '✗ Failed'}
                      </span>
                    </td>
                    <td className="num">{log.containers_deleted}</td>
                    <td className="num">{log.images_deleted}</td>
                    <td className="num">{log.networks_deleted}</td>
                    <td className="num">{log.volumes_deleted}</td>
                    <td className="num">{log.space_reclaimed_mb} MB</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="table-empty">No cleanup history yet</div>
        )}
      </section>

      <section className="settings-section">
        <div className="section-header">
          <h2><HardDrive size={20} /> Orphaned Volumes</h2>
          <button
            onClick={pruneVolumes}
            className="btn btn-secondary"
            disabled={pruningVolumes || !orphanedVolumes || orphanedVolumes.length === 0}
          >
            {pruningVolumes ? 'Removing…' : 'Remove All'}
          </button>
        </div>
        <p className="section-description">
          Named volumes left behind by deleted agents. Volumes belonging to existing agents — running or stopped — are never listed here.
        </p>
        {orphanedVolumes === null ? (
          <div className="skeleton skeleton-block" style={{ height: '80px' }} />
        ) : orphanedVolumes.length > 0 ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Volume</th>
                  <th>Created</th>
                  <th className="num">Action</th>
                </tr>
              </thead>
              <tbody>
                {orphanedVolumes.map((v) => (
                  <tr key={v.name}>
                    <td className="text-mono">{v.name}</td>
                    <td>{v.createdAt ? new Date(v.createdAt).toLocaleString() : '—'}</td>
                    <td className="num">
                      <button className="btn btn-danger" style={{ padding: '0.25rem 0.6rem', fontSize: '0.8rem' }} onClick={() => deleteVolume(v.name)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="table-empty">No orphaned volumes</div>
        )}
      </section>

      <section className="settings-section">
        <div className="section-header">
          <h2><Activity size={20} /> Recent Activity</h2>
        </div>
        {events.length > 0 ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Type</th>
                  <th>Agent</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{new Date(event.ts + 'Z').toLocaleString()}</td>
                    <td>
                      <span className={event.type.includes('down') || event.type.includes('delete') ? 'badge-danger' : 'badge-success'} style={{
                        padding: '0.15rem 0.5rem', borderRadius: '1rem', fontSize: '0.72rem', fontWeight: 600
                      }}>
                        {event.type}
                      </span>
                    </td>
                    <td>{event.agent_name || '—'}</td>
                    <td style={{ color: 'var(--text-secondary)' }}>{event.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="table-empty">No activity yet</div>
        )}
      </section>

      <Link to="/console" className="console-link-card">
        <div className="console-link-icon">
          <Terminal size={22} />
        </div>
        <div>
          <div className="console-link-title">Host Console</div>
          <div className="console-link-description">
            Interactive terminal on the VPS host — run commands without SSH
          </div>
        </div>
        <ChevronRight size={20} className="console-link-arrow" />
      </Link>

      <section className="settings-section">
        <div className="section-header">
          <h2><Power size={20} /> System Controls</h2>
        </div>
        <div className="control-grid">
          <div className="control-card">
            <div className="control-card-icon blue"><RefreshCw size={20} /></div>
            <div className="control-card-title">Restart AgentPanel</div>
            <div className="control-card-description">
              Restarts the panel backend. The UI will be unavailable for a few seconds.
            </div>
            <button className="btn btn-secondary" onClick={() => setConfirmAction('restart-panel')}>
              Restart
            </button>
          </div>
          <div className="control-card">
            <div className="control-card-icon green"><Download size={20} /></div>
            <div className="control-card-title">Update AgentPanel</div>
            <div className="control-card-description">
              Pull the latest version and rebuild. Runs on the host via SSH.
            </div>
            <button className="btn btn-secondary" onClick={() => setConfirmAction('update')}>
              Update
            </button>
          </div>
          <div className="control-card">
            <div className="control-card-icon yellow"><Container size={20} /></div>
            <div className="control-card-title">Restart Docker</div>
            <div className="control-card-description">
              Restarts the Docker daemon. All containers — including your agents — will be affected.
            </div>
            <button className="btn btn-secondary" onClick={() => setConfirmAction('restart-docker')}>
              Restart Docker
            </button>
          </div>
        </div>

        <div className="danger-zone">
          <div className="danger-zone-title">
            <AlertTriangle size={18} /> Danger Zone
          </div>
          <div className="control-grid">
            <div className="control-card">
              <div className="control-card-icon red"><Power size={20} /></div>
              <div className="control-card-title">Reboot Server</div>
              <div className="control-card-description">
                Reboots the entire VPS. All services will be interrupted until the server is back.
              </div>
              <button className="btn btn-danger" onClick={() => setConfirmAction('reboot')}>
                Reboot Server
              </button>
            </div>
          </div>
        </div>
      </section>

      {confirmAction && (
        <div className="modal-overlay">
          <div className="modal">
            <h3 className="modal-title">Confirm Action</h3>
            <p className="modal-text">
              {confirmAction === 'restart-panel' && 'Are you sure you want to restart AgentPanel? This will briefly interrupt service.'}
              {confirmAction === 'restart-docker' && 'Are you sure you want to restart Docker? All containers will be affected.'}
              {confirmAction === 'update' && 'Are you sure you want to update AgentPanel to the latest version?'}
              {confirmAction === 'reboot' && 'WARNING: This will reboot the entire server. All services will be interrupted.'}
            </p>
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={() => executeSystemAction(confirmAction)}>
                Confirm
              </button>
              <button className="btn btn-secondary" onClick={() => setConfirmAction(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default System

import { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { authFetch, authFetchOk } from '../lib/auth'
import { useToast } from './Toast'
import {
  Key, Copy, ExternalLink, Play, Square, RefreshCw, Trash2, Plus, X,
  Settings as SettingsIcon, FileText, Terminal as TerminalIcon, Save, Box, Globe, Download, Hammer
} from 'lucide-react'

// Lazy-load xterm only when the Console tab is opened (it's ~200KB).
const TerminalPanel = lazy(() => import('./TerminalPanel'))

const SENSITIVE = /key|token|password|secret/i

const TABS = [
  { id: 'overview', label: 'Overview', icon: Box },
  { id: 'logs', label: 'Logs', icon: FileText },
  { id: 'console', label: 'Console', icon: TerminalIcon },
  { id: 'environment', label: 'Environment', icon: SettingsIcon },
  { id: 'credentials', label: 'Credentials', icon: Key },
  { id: 'settings', label: 'Settings', icon: Globe }
]

function AgentDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [agent, setAgent] = useState(null)
  const [tab, setTab] = useState('overview')
  const [logs, setLogs] = useState('')
  const [envPairs, setEnvPairs] = useState([])
  const [envSaving, setEnvSaving] = useState(false)
  const [settings, setSettings] = useState({ domain: '', image: '', port: '' })
  const [settingsSaving, setSettingsSaving] = useState(false)
  const toast = useToast()
  const logBoxRef = useRef(null)

  useEffect(() => { fetchAgent() }, [id])
  useEffect(() => { if (tab === 'logs') fetchLogs() }, [tab, id])

  async function fetchAgent() {
    try {
      const res = await authFetch(`/api/agents/${id}`)
      const data = await res.json()
      setAgent(data)
      setEnvPairs(Object.entries(data.config || {}).map(([k, v]) => ({ key: k, value: String(v) })))
      setSettings({ domain: data.domain || '', image: data.image || '', port: data.port || '' })
    } catch (err) { console.error('Failed to fetch agent:', err) }
  }

  async function fetchLogs() {
    try {
      const res = await authFetch(`/api/agents/${id}/logs?tail=300`)
      setLogs(await res.text())
    } catch (err) { console.error('Failed to fetch logs:', err) }
  }

  useEffect(() => { if (tab === 'logs' && logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight }, [logs, tab])

  function notify(type, text) { toast[type](text) }

  async function handleAction(path, method = 'POST', body = null) {
    try {
      await authFetchOk(`/api/agents/${id}/${path}`, {
        method,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
      })
      notify('success', `${path} sent`)
      await fetchAgent()
      if (path === 'redeploy') fetchLogs()
    } catch (err) { notify('error', path + ': ' + err.message) }
  }

  // Template images are built once and reused, so a plain redeploy keeps
  // running whatever was built first. This is the escape hatch after editing
  // templates/<runtime>/Dockerfile.
  async function handleRebuild() {
    if (!confirm('Rebuild the template image for this runtime?\n\nPicks up edits to the runtime\'s Dockerfile and pulls a fresh base image.\n\nThis agent stops now and stays down for the several minutes the build takes. Other agents on the same runtime keep running their current image until they are redeployed.')) return
    notify('success', 'Rebuilding image — this takes a few minutes')
    await handleAction('redeploy', 'POST', { rebuild: true })
  }

  async function handleDelete() {
    if (!confirm('Delete this agent? This cannot be undone.')) return
    try { await authFetchOk(`/api/agents/${id}`, { method: 'DELETE' }); navigate('/') }
    catch (err) { notify('error', 'Delete failed: ' + err.message) }
  }

  const [showExportModal, setShowExportModal] = useState(false)

  async function handleExport(includeData) {
    setShowExportModal(false)
    try {
      const res = await authFetch(`/api/agents/${id}/export${includeData ? '?data=1' : ''}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Export failed')
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${agent.name}.zip`
      a.click()
      URL.revokeObjectURL(url)
      notify('success', includeData ? 'Service export (with volume data) downloaded' : 'Service export downloaded')
    } catch (err) { notify('error', 'Export failed: ' + err.message) }
  }

  async function saveEnv() {
    setEnvSaving(true)
    try {
      const config = {}
      for (const p of envPairs) { const k = p.key.trim(); if (k) config[k] = p.value }
      const res = await authFetch(`/api/agents/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config })
      })
      if (!res.ok) { const e = await res.json(); throw new Error(e.error) }
      notify('success', 'Environment saved & redeployed')
      await fetchAgent()
    } catch (err) { notify('error', 'Save failed: ' + err.message) }
    finally { setEnvSaving(false) }
  }

  async function saveSettings() {
    setSettingsSaving(true)
    try {
      const res = await authFetch(`/api/agents/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain: settings.domain })
      })
      if (!res.ok) { const e = await res.json(); throw new Error(e.error) }
      notify('success', 'Settings saved & redeployed')
      await fetchAgent()
    } catch (err) { notify('error', 'Save failed: ' + err.message) }
    finally { setSettingsSaving(false) }
  }

  function copy(text) { navigator.clipboard.writeText(text); notify('success', 'Copied to clipboard') }

  if (!agent) return <div className="loading">Loading…</div>

  const appUrl = agent.domain && agent.domain.includes('.') ? `https://${agent.domain}` : null
  const credentials = getCredentials(agent)
  const running = agent.status === 'running'

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem', marginBottom: '1.5rem' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <h1 style={{ margin: 0 }}>{agent.name}</h1>
            <span style={{
              padding: '0.2rem 0.6rem', borderRadius: '1rem', fontSize: '0.72rem', fontWeight: 600,
              background: running ? '#10b981' : agent.status === 'stopped' ? '#ef4444' : '#f59e0b',
              color: 'white', textTransform: 'uppercase', letterSpacing: '0.03em'
            }}>{agent.status}</span>
          </div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '0.3rem' }}>
            {agent.runtime} · {agent.image?.split('/').pop()}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {appUrl && (
            <a href={appUrl} target="_blank" rel="noopener noreferrer" className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', textDecoration: 'none' }}>
              <ExternalLink size={15} color="currentColor" /> Open
            </a>
          )}
          {running ? (
            <button className="btn" style={{ background: '#f59e0b', color: 'white', display: 'flex', alignItems: 'center', gap: '0.4rem' }} onClick={() => handleAction('stop')}><Square size={15} color="white" /> Stop</button>
          ) : (
            <button className="btn" style={{ background: '#10b981', color: 'white', display: 'flex', alignItems: 'center', gap: '0.4rem' }} onClick={() => handleAction('start')}><Play size={15} color="white" /> Start</button>
          )}
          <button className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }} onClick={() => handleAction('redeploy')}><RefreshCw size={15} color="white" /> Redeploy</button>
          {/* docker-app runs a prebuilt image, and compose redeploys through the
              compose plugin — neither has a template image to rebuild. */}
          {agent.runtime !== 'docker-app' && agent.runtime !== 'compose' && (
            <button className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }} onClick={handleRebuild} title="Rebuild the runtime's template image, then redeploy (picks up Dockerfile edits)"><Hammer size={15} color="currentColor" /> Rebuild image</button>
          )}
          <button className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }} onClick={() => setShowExportModal(true)} title="Download service as zip (migrate to another AgentHotel)"><Download size={15} color="currentColor" /> Export</button>
          <button className="btn btn-danger" onClick={handleDelete} title="Delete"><Trash2 size={15} color="white" /></button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '0.25rem', borderBottom: '1px solid var(--border)', marginBottom: '1.5rem', overflowX: 'auto' }}>
        {TABS.map(t => {
          const Icon = t.icon
          return (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.6rem 1rem',
              background: 'none', border: 'none', borderBottom: tab === t.id ? '2px solid #3b82f6' : '2px solid transparent',
              color: tab === t.id ? 'var(--text-primary)' : 'var(--text-secondary)',
              cursor: 'pointer', fontSize: '0.875rem', fontWeight: tab === t.id ? 600 : 400, whiteSpace: 'nowrap'
            }}>
              <Icon size={15} color="currentColor" /> {t.label}
            </button>
          )
        })}
      </div>

      {/* Overview */}
      {tab === 'overview' && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
            {[
              ['Runtime', agent.runtime], ['Domain', agent.domain || '—'],
              ['Image', agent.image], ['Port', String(agent.port || '—')],
              ['Created', new Date(agent.created_at).toLocaleString()], ['Updated', new Date(agent.updated_at).toLocaleString()]
            ].map(([label, value]) => (
              <div key={label} style={{ background: 'var(--bg-secondary)', borderRadius: '0.5rem', padding: '1rem', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.35rem' }}>{label}</div>
                <div style={{ fontSize: '0.9rem', wordBreak: 'break-all', fontFamily: label === 'Image' ? 'monospace' : 'inherit' }}>{value}</div>
              </div>
            ))}
          </div>
          {appUrl && (
            <div style={{ background: 'var(--bg-secondary)', borderRadius: '0.5rem', padding: '1rem 1.25rem', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1.5rem' }}>
              <div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Public URL</div>
                <a href={appUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#60a5fa', fontFamily: 'monospace', textDecoration: 'none' }}>{appUrl}</a>
              </div>
              <a href={appUrl} target="_blank" rel="noopener noreferrer" className="btn btn-secondary" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '0.4rem' }}><ExternalLink size={15} color="currentColor" /> Open app</a>
            </div>
          )}
          <AgentStats agentId={id} />
          <AgentResources agentId={id} config={agent.config} runtime={agent.runtime} onSaved={fetchAgent} />
          <AgentUptime agentId={id} />
        </div>
      )}

      {/* Logs */}
      {tab === 'logs' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <h3 style={{ margin: 0, fontSize: '1rem' }}>Container logs</h3>
            <button className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }} onClick={fetchLogs}><RefreshCw size={15} color="currentColor" /> Refresh</button>
          </div>
          <pre ref={logBoxRef} style={{ background: '#0f172a', color: '#cbd5e1', padding: '1rem', borderRadius: '0.5rem', maxHeight: '60vh', overflow: 'auto', fontSize: '0.8rem', fontFamily: 'Menlo, monospace', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{logs || 'No logs available'}</pre>
        </div>
      )}

      {/* Console */}
      {tab === 'console' && (
        <Suspense fallback={<div className="loading">Loading terminal…</div>}>
          <TerminalPanel agentId={id} />
        </Suspense>
      )}

      {/* Environment */}
      {tab === 'environment' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
            <div>
              <h3 style={{ margin: 0, fontSize: '1rem' }}>Environment variables</h3>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>Saving redeploys the agent with the new configuration.</div>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }} onClick={() => setEnvPairs([...envPairs, { key: '', value: '' }])}><Plus size={15} color="currentColor" /> Add</button>
              <button className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }} disabled={envSaving} onClick={saveEnv}><Save size={15} color="white" /> {envSaving ? 'Saving…' : 'Save & Deploy'}</button>
            </div>
          </div>
          <div style={{ display: 'grid', gap: '0.5rem' }}>
            {envPairs.length === 0 && <div style={{ color: 'var(--text-secondary)', fontStyle: 'italic', padding: '1rem' }}>No environment variables.</div>}
            {envPairs.map((p, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 1fr) 2fr auto', gap: '0.5rem', alignItems: 'center' }}>
                <input style={{ fontFamily: 'monospace', fontSize: '0.85rem' }} value={p.key} placeholder="KEY" onChange={(e) => setEnvPairs(envPairs.map((x, j) => j === i ? { ...x, key: e.target.value } : x))} />
                <input style={{ fontFamily: 'monospace', fontSize: '0.85rem' }} type={SENSITIVE.test(p.key) ? 'password' : 'text'} value={p.value} placeholder="value" onChange={(e) => setEnvPairs(envPairs.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} />
                <button className="btn btn-danger" title="Remove" onClick={() => setEnvPairs(envPairs.filter((_, j) => j !== i))}><X size={15} color="white" /></button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Credentials */}
      {tab === 'credentials' && (
        <div>
          {credentials.length === 0 ? (
            <div style={{ color: 'var(--text-secondary)', fontStyle: 'italic', padding: '1rem' }}>No credentials for this agent.</div>
          ) : (
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              {credentials.map((cred, i) => {
                const masked = SENSITIVE.test(cred.label) && cred.value.length > 8 ? '••••••' + cred.value.slice(-8) : cred.value
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg-secondary)', borderRadius: '0.5rem', padding: '0.85rem 1rem', border: '1px solid var(--border)', gap: '0.75rem' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{cred.label}</div>
                      <div style={{ fontFamily: 'monospace', fontSize: '0.85rem', wordBreak: 'break-all' }}>{masked}</div>
                    </div>
                    <button className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.35rem 0.75rem', flexShrink: 0 }} onClick={() => copy(cred.value)}><Copy size={14} color="currentColor" /> Copy</button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Settings */}
      {tab === 'settings' && (
        <div style={{ maxWidth: '560px' }}>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Domain (subdomain or FQDN)</label>
            <input type="text" value={settings.domain} placeholder="myapp.froste.eu" onChange={(e) => setSettings({ ...settings, domain: e.target.value })} style={{ width: '100%', marginTop: '0.3rem' }} />
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.3rem' }}>Changing the domain provisions a new HTTPS route via Caddy.</div>
          </div>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Image</label>
            <input type="text" value={settings.image} disabled style={{ width: '100%', marginTop: '0.3rem', opacity: 0.6 }} />
          </div>
          <div style={{ marginBottom: '1.5rem' }}>
            <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Port</label>
            <input type="text" value={settings.port} disabled style={{ width: '100%', marginTop: '0.3rem', opacity: 0.6 }} />
          </div>
          <button className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }} disabled={settingsSaving} onClick={saveSettings}><Save size={15} color="white" /> {settingsSaving ? 'Saving…' : 'Save & Redeploy'}</button>
          <div style={{ marginTop: '2rem', paddingTop: '1.5rem', borderTop: '1px solid var(--border)' }}>
            <h4 style={{ margin: '0 0 0.5rem 0', color: '#f87171', fontSize: '0.9rem' }}>Danger zone</h4>
            <button className="btn btn-danger" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }} onClick={handleDelete}><Trash2 size={15} color="white" /> Delete agent</button>
          </div>
        </div>
      )}

      {showExportModal && (
        <div className="modal-overlay" onClick={() => setShowExportModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Export service</h3>
            <p className="modal-text">
              Download <strong>{agent.name}</strong> as a zip you can import on any AgentHotel instance.
              Environment variables and API keys are included in plain text.
            </p>
            <div className="modal-actions" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <button className="btn btn-secondary" onClick={() => handleExport(false)}>
                Config only
              </button>
              {agent.status === 'stopped' ? (
                <button className="btn btn-primary" onClick={() => handleExport(true)}>
                  Config + volume data
                </button>
              ) : (
                <button className="btn btn-primary" disabled title="Stop the agent first" style={{ opacity: 0.5 }}>
                  Config + volume data (stop the agent first)
                </button>
              )}
            </div>
            {agent.status !== 'stopped' && (
              <p className="modal-text" style={{ marginTop: '0.75rem', marginBottom: 0, fontSize: '0.8rem' }}>
                Volume data requires a stopped agent for a consistent copy — same as Easypanel.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// Live container resources, refreshed every 5s while the Overview tab is
// mounted (unmounting on tab switch clears the interval).
function AgentStats({ agentId }) {
  const [stats, setStats] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function fetchStats() {
      try {
        const res = await authFetch(`/api/agents/${agentId}/stats`)
        const data = await res.json()
        if (!cancelled) setStats(data)
      } catch (err) { console.error('Failed to fetch agent stats:', err) }
    }
    fetchStats()
    const interval = setInterval(() => { if (!document.hidden) fetchStats() }, 5000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [agentId])

  if (!stats) return null

  return (
    <div className="stats-section">
      <h3 className="stats-section-title">Resources</h3>
      {!stats.running ? (
        <div className="stats-not-running">Agent is not running.</div>
      ) : (
        <div className="stats-grid" style={{ marginBottom: 0 }}>
          <div className="stat-item">
            <div className="stat-label">CPU</div>
            <div className="stat-value">{stats.cpu.pct}%</div>
            <div className="progress-bar">
              <div className={`progress-fill ${stats.cpu.pct > 80 ? 'high' : stats.cpu.pct > 50 ? 'medium' : 'low'}`} style={{ width: `${Math.min(stats.cpu.pct, 100)}%` }} />
            </div>
          </div>
          <div className="stat-item">
            <div className="stat-label">Memory</div>
            <div className="stat-value">{formatBytes(stats.mem.used)}</div>
            <div className="stat-subtext">of {formatBytes(stats.mem.limit)} ({stats.mem.pct}%)</div>
            <div className="progress-bar">
              <div className={`progress-fill ${stats.mem.pct > 80 ? 'high' : stats.mem.pct > 50 ? 'medium' : 'low'}`} style={{ width: `${Math.min(stats.mem.pct, 100)}%` }} />
            </div>
          </div>
          <div className="stat-item">
            <div className="stat-label">Network</div>
            <div className="stat-value">↓ {formatBytes(stats.network.rx)}</div>
            <div className="stat-subtext">↑ {formatBytes(stats.network.tx)}</div>
          </div>
        </div>
      )}
    </div>
  )
}

// Resize an agent's CPU/RAM ceilings. Applied live via `docker update` when the
// agent is running, so a resize never costs a restart or a conversation.
function AgentResources({ agentId, config, runtime, onSaved }) {
  const toast = useToast()
  const [memoryMB, setMemoryMB] = useState(parseInt(config?.MEMORY_LIMIT_MB) || 1024)
  const [cpus, setCpus] = useState(parseFloat(config?.CPU_LIMIT) || 1)
  const [capacity, setCapacity] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    authFetch('/api/system/capacity')
      .then(r => r.json())
      .then(setCapacity)
      .catch(() => {})
  }, [])

  if (runtime === 'compose') return null

  const savedMem = parseInt(config?.MEMORY_LIMIT_MB) || 1024
  const savedCpu = parseFloat(config?.CPU_LIMIT) || 1
  const dirty = memoryMB !== savedMem || cpus !== savedCpu

  // Headroom excludes this agent's own current allocation, since we are
  // replacing it rather than adding to it.
  const maxMemMB = capacity ? capacity.memory.totalMB : 4096
  const othersMB = capacity ? Math.max(capacity.memory.allocatedToAgentsMB - savedMem, 0) : 0
  const wouldOversubscribe = capacity && (othersMB + memoryMB) > capacity.memory.totalMB

  async function save() {
    setSaving(true)
    try {
      const res = await authFetch(`/api/agents/${agentId}/resources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memoryMB, cpus })
      })
      const data = await res.json()
      if (data.updated) {
        toast.success(data.applied === 'live'
          ? `Limits applied live — ${memoryMB} MB / ${cpus} CPU, no restart needed`
          : `Saved — ${memoryMB} MB / ${cpus} CPU, applied on next deploy`)
        onSaved?.()
      } else {
        toast.error(data.error || 'Could not update limits')
      }
    } catch (err) {
      toast.error('Could not update limits: ' + err.message)
    } finally { setSaving(false) }
  }

  return (
    <div className="stats-section">
      <h3 className="stats-section-title">Resource limits</h3>

      <div style={{ display: 'grid', gap: '1.1rem' }}>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '0.35rem' }}>
            <span>Memory</span>
            <strong>{memoryMB >= 1024 ? (memoryMB / 1024).toFixed(memoryMB % 1024 ? 1 : 0) + ' GB' : memoryMB + ' MB'}</strong>
          </div>
          <input type="range" min="256" max={maxMemMB} step="256" value={Math.min(memoryMB, maxMemMB)}
            onChange={e => setMemoryMB(parseInt(e.target.value))} style={{ width: '100%' }} />
        </div>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '0.35rem' }}>
            <span>CPU</span>
            <strong>{cpus} {cpus === 1 ? 'core' : 'cores'}</strong>
          </div>
          <input type="range" min="0.25" max={capacity?.cpu.cores || 4} step="0.25" value={cpus}
            onChange={e => setCpus(parseFloat(e.target.value))} style={{ width: '100%' }} />
        </div>
      </div>

      {capacity && (
        <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: '0.8rem' }}>
          Host has {(capacity.memory.totalMB / 1024).toFixed(1)} GB RAM and {capacity.cpu.cores} core(s).
          Other agents are allocated {othersMB} MB.
        </div>
      )}

      {wouldOversubscribe && (
        <div style={{ fontSize: '0.78rem', color: '#f59e0b', marginTop: '0.5rem' }}>
          Warning: this would allocate more memory than the host physically has. Limits are ceilings, not
          reservations, so it still runs — but if the agents all claim their limit, the kernel starts OOM-killing.
        </div>
      )}

      <button className="btn btn-primary" disabled={!dirty || saving} onClick={save} style={{ marginTop: '0.9rem' }}>
        {saving ? 'Applying…' : 'Apply limits'}
      </button>
    </div>
  )
}

// Uptime summary: 24h/7d percentages, current check, and a pure-CSS bar strip
// of the last 50 checks (oldest left, newest right).
function AgentUptime({ agentId }) {
  const [uptime, setUptime] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function fetchUptime() {
      try {
        const res = await authFetch(`/api/agents/${agentId}/uptime`)
        const data = await res.json()
        if (!cancelled) setUptime(data)
      } catch (err) { console.error('Failed to fetch uptime:', err) }
    }
    fetchUptime()
    const interval = setInterval(() => { if (!document.hidden) fetchUptime() }, 60000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [agentId])

  if (!uptime) return null

  const pctLabel = (v) => v === null ? '—' : `${v}%`

  return (
    <div className="stats-section">
      <h3 className="stats-section-title">Uptime</h3>
      {uptime.recent.length === 0 ? (
        <div className="stats-not-running">No uptime data yet — checks run every minute for running agents with a domain.</div>
      ) : (
        <div>
          <div className="uptime-summary">
            <span>Last 24h: <span className="uptime-summary-value">{pctLabel(uptime.last24h)}</span></span>
            <span>Last 7d: <span className="uptime-summary-value">{pctLabel(uptime.last7d)}</span></span>
            {uptime.current && (
              <span>
                Current: <span className="uptime-summary-value" style={{ color: uptime.current.ok ? 'var(--accent-green)' : 'var(--accent-red)' }}>
                  {uptime.current.ok ? 'Up' : 'Down'}
                </span>
                {uptime.current.status_code != null && ` (HTTP ${uptime.current.status_code})`}
                {uptime.current.latency_ms != null && ` · ${uptime.current.latency_ms} ms`}
              </span>
            )}
          </div>
          <div className="uptime-strip" title="Last 50 checks, oldest → newest">
            {uptime.recent.map((c, i) => (
              <div
                key={i}
                className={`uptime-bar${c.ok ? '' : ' down'}`}
                title={`${new Date(c.checked_at + 'Z').toLocaleString()} — ${c.ok ? 'ok' : 'down'}${c.status_code != null ? ` (HTTP ${c.status_code})` : ''}`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i]
}

function getCredentials(agent) {
  const c = agent.config || {}
  const creds = []
  if (agent.runtime === 'openclaw' && c.OPENCLAW_GATEWAY_TOKEN) creds.push({ label: 'Gateway Token', value: c.OPENCLAW_GATEWAY_TOKEN })
  if (agent.runtime === 'hermes') {
    // Mirror the precedence in plugins/hermes.js buildEnv — reading only
    // HERMES_DASHBOARD_PASSWORD showed the default to anyone who had set
    // HERMES_DASHBOARD_BASIC_AUTH_PASSWORD, i.e. the wrong password.
    creds.push({ label: 'Dashboard Username', value: c.HERMES_DASHBOARD_BASIC_AUTH_USERNAME || 'admin' })
    creds.push({
      label: 'Dashboard Password',
      value: c.HERMES_DASHBOARD_BASIC_AUTH_PASSWORD || c.HERMES_DASHBOARD_PASSWORD || 'agenthotel'
    })
  }
  if (agent.runtime === 'odysseus') {
    creds.push({ label: 'Admin Username', value: c.ODYSSEUS_ADMIN_USER || 'admin' })
    if (c.ODYSSEUS_ADMIN_PASSWORD) {
      creds.push({ label: 'Admin Password', value: c.ODYSSEUS_ADMIN_PASSWORD })
    } else {
      // setup.py generates one on first boot and prints it to the container
      // log; there is nothing in the config to show.
      creds.push({ label: 'Admin Password', value: 'Generated on first boot — see the Logs tab' })
    }
  }
  if (c.OPENAI_API_KEY) creds.push({ label: 'OpenAI API Key', value: c.OPENAI_API_KEY })
  if (c.OPENROUTER_API_KEY) creds.push({ label: 'OpenRouter API Key', value: c.OPENROUTER_API_KEY })
  if (c.ANTHROPIC_API_KEY) creds.push({ label: 'Anthropic API Key', value: c.ANTHROPIC_API_KEY })
  return creds
}

export default AgentDetail

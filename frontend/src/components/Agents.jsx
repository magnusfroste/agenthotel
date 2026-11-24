import { useState, useEffect, useRef } from 'react'
import UpdateDot from './UpdateDot'
import { useAgentUpdates, refreshAgentUpdates, updateText } from '../lib/agentUpdates'
import { Link, useSearchParams } from 'react-router-dom'
import { authFetch, authFetchOk } from '../lib/auth'
import { useToast } from './Toast'
import { Trash2, Globe, Package, ExternalLink, Play, Square, MoreHorizontal, Bot, Plus, Layers, Upload, Activity, Loader, RefreshCw, LayoutGrid, List, AlertTriangle } from 'lucide-react'
import RuntimeMark from './RuntimeMark'
import { MoveIn } from './HotelTransfer'
import { ModelErrorsLine } from './ModelErrors'
import { compareAttention, KIND_LABELS, KIND_ORDER } from '../lib/attention'

// What a card says while its image is being built. The backend records every
// build step and pulled layer; without this the card read "creating" for
// twenty minutes with nothing to distinguish a build from a hang.
function BuildProgress({ agentId }) {
  const [p, setP] = useState(null)
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const res = await authFetch(`/api/agents/${agentId}/build-log`)
        if (alive && res.ok) setP(await res.json())
      } catch (e) { /* next tick */ }
    }
    tick()
    const t = setInterval(tick, 3000)
    return () => { alive = false; clearInterval(t) }
  }, [agentId])

  if (!p || !p.active) {
    return (
      <div className="agent-card-meta-item" style={{ color: 'var(--text-secondary)' }}>
        <Loader size={14} color="currentColor" />
        <span>{p && p.done && !p.error ? 'Image built — starting container' : 'Starting…'}</span>
      </div>
    )
  }
  const mins = Math.floor(p.elapsedSeconds / 60), secs = p.elapsedSeconds % 60
  const stepText = p.total ? `Step ${p.step}/${p.total}` : (p.pullPercent != null ? `Pulling ${p.pullPercent}%` : 'Building')
  return (
    <div className="agent-card-meta-item" style={{ color: 'var(--accent-blue, #60a5fa)', alignItems: 'flex-start' }} title={p.line}>
      <Loader size={14} color="currentColor" />
      <span style={{ minWidth: 0 }}>
        <span style={{ fontWeight: 600 }}>{stepText}</span>
        <span style={{ color: 'var(--text-secondary)' }}> · {mins}:{String(secs).padStart(2,'0')}</span>
        <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '260px' }}>
          {p.line}
        </div>
      </span>
    </div>
  )
}

const VIEW_KEY = 'agenthotel.dashboard.view'
const SORT_KEY = 'agenthotel.agents.sort'
const GROUP_KEY = 'agenthotel.agents.grouped'

// Why a guest is in the sidebar's "Needs attention", on its card and row too,
// where the health line does not already say it: a guest that stopped by
// itself reads "stopped" like one stopped on purpose, and one that is healthy
// inside but does not answer at its domain reads "healthy". Model errors have
// their own line, a deploy its build progress, a failed probe its health.
function AttentionLine({ agent }) {
  const attention = agent.attention
  if (!attention || attention.level === 'busy') return null
  const unsaid = agent.status === 'stopped' || /^Not answering|^Deploy was cut short/.test(attention.text)
  if (!unsaid) return null
  return (
    <div className={`attention-line attention-${attention.level}`}>
      <AlertTriangle size={14} color="currentColor" /> <span>{attention.text}</span>
    </div>
  )
}

// Every guest, findable (2026-11-24). The dashboard's home page has the
// numbers and the sidebar only the guests that need something; this is the
// register. Guests that need attention come first, the rest by name, so a
// known guest is always in the same place; grouped by what they are.
function Agents() {
  const updates = useAgentUpdates()
  const [agents, setAgents] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  // ?filter=attention or ?filter=updates: the sidebar's grouped rows link here.
  const [params, setParams] = useSearchParams()
  const statusFilter = params.get('filter') || 'all'
  const setStatusFilter = (v) => setParams(v === 'all' ? {} : { filter: v }, { replace: true })
  const [sortBy, setSortBy] = useState(() => {
    try { return localStorage.getItem(SORT_KEY) || 'attention' } catch { return 'attention' }
  })
  const chooseSort = (v) => {
    setSortBy(v)
    try { localStorage.setItem(SORT_KEY, v) } catch { /* not remembered */ }
  }
  const [grouped, setGrouped] = useState(() => {
    try { return localStorage.getItem(GROUP_KEY) !== 'off' } catch { return true }
  })
  const chooseGrouped = (v) => {
    setGrouped(v)
    try { localStorage.setItem(GROUP_KEY, v ? 'on' : 'off') } catch { /* not remembered */ }
  }
  // CPU per guest right now, for "Busiest now"; asked only when that sort is on.
  const [busy, setBusy] = useState({})
  // Cards or a list, remembered per browser: with forty guests the cards no
  // longer fit a screen, and a list reads like a register.
  const [view, setView] = useState(() => {
    try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'cards' } catch { return 'cards' }
  })
  const chooseView = (v) => {
    setView(v)
    try { localStorage.setItem(VIEW_KEY, v) } catch { /* private window: it just is not remembered */ }
  }
  // Runtime icon and colour come from the template library (meta.yaml), so a
  // card shows the same mark as its template and a new runtime needs no change
  // here. Fetched once — this is presentation metadata, not live state.
  const [runtimeMeta, setRuntimeMeta] = useState({})
  const toast = useToast()

  useEffect(() => {
    fetchAgents()
    fetchRuntimeMeta()
    const interval = setInterval(() => { if (!document.hidden) fetchAgents() }, 10000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (sortBy !== 'busiest') return
    const load = () => authFetch('/api/system/activity?range=hour').then(r => r.json())
      .then(d => setBusy(Object.fromEntries((d.items || []).filter(i => i.agentId).map(i => [i.agentId, i.cores || 0]))))
      .catch(() => {})
    load()
    const t = setInterval(() => { if (!document.hidden) load() }, 30000)
    return () => clearInterval(t)
  }, [sortBy])

  // Agents mid-deploy on the last look. When one settles, its update marker
  // may be stale; ask again instead of waiting for the five-minute refresh.
  const deploying = useRef(new Set())

  async function fetchAgents() {
    try {
      const res = await authFetch('/api/agents')
      const list = await res.json()
      const now = new Set((Array.isArray(list) ? list : []).filter(a => a.status === 'creating' || a.status === 'redeploying').map(a => a.id))
      if ([...deploying.current].some(id => !now.has(id))) refreshAgentUpdates()
      deploying.current = now
      setAgents(list)
    } catch (err) { console.error('Failed to fetch agents:', err) }
    finally { setLoading(false) }
  }

  async function fetchRuntimeMeta() {
    try {
      const res = await authFetch('/api/templates')
      const list = await res.json()
      setRuntimeMeta(Object.fromEntries(
        (Array.isArray(list) ? list : []).map(t => [t.id, { icon: t.icon, color: t.color, logo: t.logo, name: t.name }])
      ))
    } catch (err) { console.error('Failed to fetch runtime metadata:', err) }
  }

  async function toggleAgent(id, status) {
    const action = status === 'running' ? 'stop' : 'start'
    try {
      await authFetchOk(`/api/agents/${id}/${action}`, { method: 'POST' })
      fetchAgents()
      toast.success(`Agent ${action === 'start' ? 'started' : 'stopped'}`)
    }
    catch (err) { toast.error(`Failed to ${action} agent: ` + err.message) }
  }

  // A redeploy from the card, so updating a guest the Fleet marks takes one
  // click instead of a visit to its page. It restarts the container (an open
  // console or chat ends), hence the confirm.
  async function handleRedeploy(agent) {
    const status = updates[agent.id]
    const rebuild = Boolean(status && status.updateAvailable && status.action === 'rebuild')
    const why = status && status.updateAvailable ? `\n\n${updateText(status)}` : ''
    if (!confirm(`${rebuild ? 'Rebuild the image of' : 'Redeploy'} ${agent.name}? The agent restarts.${why}`)) return
    // The request lasts as long as the deploy, so the card shows the build
    // while it runs and the toast comes when it is done.
    const done = authFetchOk(`/api/agents/${agent.id}/redeploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rebuild ? { rebuild: true } : {})
    })
    setTimeout(fetchAgents, 1500)
    try {
      await done
      toast.success(`${agent.name} ${rebuild ? 'rebuilt' : 'redeployed'}`)
    } catch (err) { toast.error(`${agent.name}: redeploy failed — ${err.message}`) }
    fetchAgents()
    refreshAgentUpdates()
  }

  async function handleDelete(id, name) {
    if (!confirm(`Delete ${name}? This cannot be undone.`)) return
    try { await authFetchOk(`/api/agents/${id}`, { method: 'DELETE' }); fetchAgents(); toast.success(`${name} deleted`) }
    catch (err) { toast.error('Delete failed: ' + err.message) }
  }

  // 'unhealthy' and 'failed' are the states that need attention, so they get
  // the alarming colour. A stopped agent is a deliberate act, not a fault —
  // it used to share red with genuine failures, which buried them.
  const statusColor = (s) =>
    s === 'running' ? '#10b981'
      : s === 'unhealthy' || s === 'failed' ? '#ef4444'
      : s === 'stopped' ? '#6b7280'
      : '#f59e0b'

  // The backend writes health as "<state>: <reason>", e.g. "healthy: HTTP 200"
  // or "restarting: restarted 3 times".
  const healthState = (h) => (h || '').split(':')[0].trim()
  const healthColor = (h) => {
    const state = healthState(h)
    if (state === 'healthy') return 'var(--text-secondary)'
    if (state === 'stopped') return 'var(--text-secondary)'
    // An image build in progress ("building: step 10/18") or a deploy waiting
    // its turn ("queued: …") is not a fault.
    if (state === 'building' || state === 'queued') return 'var(--text-secondary)'
    return '#ef4444'
  }
  const healthText = (h) => {
    const [state, ...rest] = (h || '').split(':')
    const reason = rest.join(':').trim()
    // For a healthy agent the reason alone is the informative half; for a
    // broken one the state is what the operator needs to read first.
    return state.trim() === 'healthy' ? reason || 'healthy' : (h || '').trim()
  }

  const visibleAgents = agents
    .filter(a => {
      const q = search.trim().toLowerCase()
      if (q && !a.name.toLowerCase().includes(q) && !(a.domain || '').toLowerCase().includes(q)) return false
      if (statusFilter === 'attention') return Boolean(a.attention) && a.attention.level !== 'busy'
      if (statusFilter === 'updates') return Boolean(updates[a.id]?.updateAvailable)
      if (statusFilter !== 'all' && a.status !== statusFilter) return false
      return true
    })
    .sort((a, b) => {
      if (sortBy === 'created') return (b.created_at || '').localeCompare(a.created_at || '')
      if (sortBy === 'runtime') return a.runtime.localeCompare(b.runtime) || a.name.localeCompare(b.name)
      if (sortBy === 'busiest') return (busy[b.id] || 0) - (busy[a.id] || 0) || a.name.localeCompare(b.name)
      if (sortBy === 'attention') return compareAttention(a, b)
      return a.name.localeCompare(b.name)
    })

  // Agents, the tools they use, and apps, each under its own heading, in the
  // order chosen above. Off, it is one list as before.
  const groups = grouped
    ? KIND_ORDER.map(kind => ({ kind, list: visibleAgents.filter(a => (a.kind || 'app') === kind) })).filter(g => g.list.length)
    : [{ kind: null, list: visibleAgents }]
  const attentionCount = agents.filter(a => a.attention && a.attention.level !== 'busy').length

  // Open or Manage, start/stop, redeploy, delete: the same buttons in a card
  // and in a list row.
  const actionButtons = (agent, url) => (
    <>
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer" className="btn btn-secondary">
          <ExternalLink size={14} color="currentColor" /> <span className="btn-label">Open</span>
        </a>
      ) : (
        <Link to={`/agent/${agent.id}`} className="btn btn-secondary">
          <MoreHorizontal size={14} color="currentColor" /> <span className="btn-label">Manage</span>
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
      {(() => {
        const update = updates[agent.id]
        const busy = agent.status === 'creating' || agent.status === 'redeploying'
        const wanted = Boolean(update && update.updateAvailable)
        return (
          <button
            className={wanted ? 'btn btn-primary' : 'btn btn-secondary'}
            title={busy ? 'A deploy is running' : wanted ? updateText(update) : 'Redeploy'}
            disabled={busy}
            onClick={(e) => { e.preventDefault(); handleRedeploy(agent) }}
          >
            <RefreshCw size={14} color="currentColor" />
          </button>
        )
      })()}
      <button 
        className="btn btn-danger" 
        title="Delete" 
        onClick={(e) => { e.preventDefault(); handleDelete(agent.id, agent.name) }}
      >
        <Trash2 size={14} color="white" />
      </button>
    </>
  )

  const [showImport, setShowImport] = useState(false)

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
          <h1 className="page-title">Agents &amp; apps</h1>
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
        <h1 className="page-title">Agents &amp; apps</h1>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn-secondary" title="Bring in an agent from a zip or from another hotel" onClick={() => setShowImport(true)} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <Upload size={16} color="currentColor" /> Import Agent
          </button>
        </div>
      </div>

      {showImport && (
        <div className="modal-overlay" onClick={() => setShowImport(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Import an agent</h3>
            <label className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem', cursor: 'pointer', margin: '0 0 0.25rem' }}>
              <Upload size={16} color="currentColor" /> From a zip file
              <input type="file" accept=".zip,application/zip" onChange={(e) => { setShowImport(false); handleImportService(e) }} style={{ display: 'none' }} />
            </label>
            <MoveIn onDone={(agent) => { fetchAgents(); toast.success(`${agent.name} moved in — point its DNS here and redeploy`) }} />
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
            Deploy your first AI agent or Docker Compose app to get started with AgentHotel.
          </p>
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', marginTop: '1rem' }}>
            <Link to="/create" className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Plus size={16} color="white" /> Create Agent
            </Link>
            <Link to="/compose" className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Layers size={16} color="currentColor" /> Deploy Compose
            </Link>
          </div>
        </div>
      ) : (
        <>
        {agents.length > 0 && (
          <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name or domain…"
              style={{
                flex: '1 1 220px', padding: '0.5rem 0.75rem', background: 'var(--bg-secondary)',
                border: '1px solid var(--border)', borderRadius: '0.5rem', color: 'var(--text-primary)', fontSize: '0.875rem'
              }}
            />
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{
              padding: '0.5rem 0.75rem', background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              borderRadius: '0.5rem', color: 'var(--text-primary)', fontSize: '0.875rem'
            }}>
              <option value="all">All statuses</option>
              <option value="attention">Needs attention{attentionCount ? ` (${attentionCount})` : ''}</option>
              <option value="updates">Update available</option>
              <option value="running">Running</option>
              <option value="unhealthy">Unhealthy</option>
              <option value="stopped">Stopped</option>
              <option value="failed">Failed</option>
              <option value="creating">Creating</option>
              <option value="redeploying">Redeploying</option>
            </select>
            <select value={sortBy} onChange={(e) => chooseSort(e.target.value)} style={{
              padding: '0.5rem 0.75rem', background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              borderRadius: '0.5rem', color: 'var(--text-primary)', fontSize: '0.875rem'
            }}>
              <option value="attention">Sort: Needs attention first</option>
              <option value="name">Sort: Name</option>
              <option value="busiest">Sort: Busiest now</option>
              <option value="created">Sort: Newest</option>
              <option value="runtime">Sort: Runtime</option>
            </select>
            <label className="group-toggle" title="Agents, tools and apps under their own headings">
              <input type="checkbox" checked={grouped} onChange={(e) => chooseGrouped(e.target.checked)} /> Group by kind
            </label>
            <div className="view-toggle" role="group" aria-label="Show guests as">
              <button type="button" className={view === 'cards' ? 'active' : ''} aria-pressed={view === 'cards'}
                title="Cards" onClick={() => chooseView('cards')}><LayoutGrid size={16} color="currentColor" /></button>
              <button type="button" className={view === 'list' ? 'active' : ''} aria-pressed={view === 'list'}
                title="List" onClick={() => chooseView('list')}><List size={16} color="currentColor" /></button>
            </div>
          </div>
        )}
        {visibleAgents.length === 0 ? (
          <div className="table-empty" style={{ padding: '3rem' }}>No agents match your search</div>
        ) : groups.map(g => (
        <section key={g.kind || 'all'} className="guest-group">
        {g.kind && <h2 className="guest-group-title">{KIND_LABELS[g.kind]} <span>{g.list.length}</span></h2>}
        {view === 'list' ? (
        <div className="card data-table-wrap guest-list">
          <table className="data-table">
            <thead>
              <tr><th>Guest</th><th>Status</th><th className="wide-only">Domain</th><th className="wide-only">Health</th><th className="num">Actions</th></tr>
            </thead>
            <tbody>
              {g.list.map(agent => {
                const url = agent.domain && agent.domain.includes('.') ? `https://${agent.domain}` : null
                const meta = runtimeMeta[agent.template] || runtimeMeta[agent.runtime]
                return (
                  <tr key={agent.id}>
                    <td>
                      <Link to={`/agent/${agent.id}`} className="guest-list-name">
                        <RuntimeMark meta={meta} size={26} iconSize={15} />
                        <span style={{ minWidth: 0 }}>
                          <span className="guest-list-title">{agent.name}<UpdateDot status={updates[agent.id]} /></span>
                          <span className="guest-list-sub">{runtimeMeta[agent.template || agent.runtime]?.name || agent.runtime}</span>
                        </span>
                      </Link>
                    </td>
                    <td><span className="status-badge" style={{ background: statusColor(agent.status) }}>{agent.status}</span></td>
                    <td className="guest-list-domain wide-only">
                      {url ? <a href={url} target="_blank" rel="noopener noreferrer">{agent.domain}</a> : (agent.domain || 'no domain')}
                    </td>
                    <td className="guest-list-health wide-only" style={{ color: healthColor(agent.health) }}>
                      {(agent.status === 'creating' || agent.status === 'redeploying')
                        ? <BuildProgress agentId={agent.id} />
                        : <span title={agent.health || ''}>{agent.health ? healthText(agent.health) : '—'}</span>}
                      <AttentionLine agent={agent} />
                      <ModelErrorsLine summary={agent.modelErrors} />
                    </td>
                    <td className="num"><div className="guest-list-actions">{actionButtons(agent, url)}</div></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '1rem' }}>
          {g.list.map(agent => {
            const url = agent.domain && agent.domain.includes('.') ? `https://${agent.domain}` : null
            return (
              <div key={agent.id} className="agent-card">
                <Link to={`/agent/${agent.id}`} className="agent-card-content" style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div className="agent-card-header">
                    <div style={{ minWidth: 0 }}>
                      <div className="agent-card-title">{agent.name}<UpdateDot status={updates[agent.id]} /></div>
                      <div className="agent-card-subtitle">{runtimeMeta[agent.template || agent.runtime]?.name || agent.runtime}</div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.5rem', flexShrink: 0 }}>
                      <span className="status-badge" style={{ background: statusColor(agent.status) }}>
                        {agent.status}
                      </span>
                      <RuntimeMark meta={runtimeMeta[agent.template] || runtimeMeta[agent.runtime]} />
                    </div>
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
                    {(agent.status === 'creating' || agent.status === 'redeploying') && (
                      <BuildProgress agentId={agent.id} />
                    )}
                    {agent.health && (
                      <div className="agent-card-meta-item" style={{ color: healthColor(agent.health) }}>
                        <Activity size={14} color="currentColor" />
                        <span title={agent.health}>{healthText(agent.health)}</span>
                      </div>
                    )}
                    <AttentionLine agent={agent} />
                    <ModelErrorsLine summary={agent.modelErrors} />
                  </div>
                </Link>
                <div className="agent-card-actions">
                  {actionButtons(agent, url)}
                </div>
              </div>
            )
          })}
        </div>
        )}
        </section>
        ))}
        </>
      )}
    </div>
  )
}

export default Agents

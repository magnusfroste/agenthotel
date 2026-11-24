import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, CircleCheck, Plus, Layers, Bot, ArrowRight, Loader, RefreshCw } from 'lucide-react'
import { authFetch } from '../lib/auth'
import { formatDateTime, formatDate } from '../lib/time'
import { useAgentUpdates } from '../lib/agentUpdates'
import { attentionRows, problemCount, KIND_LABELS, KIND_ORDER } from '../lib/attention'
import ActivityView from './Activity'

// The dashboard's home page (2026-11-24): how the hotel is doing, in numbers.
// It used to be the Fleet, every guest as a card under three usage bars; the
// guests moved to Agents & apps, and this page answers the questions an
// operator opens the panel with, top to bottom:
//   1. Is anything wrong?            the tiles and Needs attention
//   2. What is using the server?     Activity (CPU and memory, the last hour)
//   3. How has the week gone?        deploys, incidents and model errors a day
//   4. Who has been unreachable?     uptime over the last day, worst first
//   5. What happened lately?         the event log
// Every number links to where it can be acted on.

const LEVEL_LABEL = { critical: 'Fault', warning: 'Warning', busy: 'In progress', update: 'Update' }

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Math.round(bytes / Math.pow(k, i) * 10) / 10 + ' ' + sizes[i]
}

const meterClass = (pct) => (pct > 80 ? 'high' : pct > 60 ? 'medium' : 'low')

function Tile({ label, value, sub, pct, to, tone }) {
  const body = (
    <>
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone ? `tone-${tone}` : ''}`}>{value}</div>
      {sub && <div className="stat-subtext">{sub}</div>}
      {pct !== undefined && (
        <div className="progress-bar"><div className={`progress-fill ${meterClass(pct)}`} style={{ width: `${Math.min(100, pct)}%` }} /></div>
      )}
    </>
  )
  return to
    ? <Link to={to} className="home-tile home-tile-link">{body}</Link>
    : <div className="home-tile">{body}</div>
}

// One small bar chart per measure, the same seven days under each: three
// measures of different size would need two axes on one chart.
function WeekChart({ days, field, label, tone }) {
  const max = Math.max(1, ...days.map(d => d[field]))
  const total = days.reduce((n, d) => n + d[field], 0)
  return (
    <div className="week-chart">
      <div className="week-chart-head"><span>{label}</span><strong>{total}</strong></div>
      <div className="week-bars" role="img" aria-label={`${label} per day: ${days.map(d => `${d.day} ${d[field]}`).join(', ')}`}>
        {days.map(d => (
          <div key={d.day} className="week-bar-slot" title={`${formatDate(`${d.day} 12:00:00`, { weekday: 'short', day: 'numeric', month: 'short' })}: ${d[field]}`}>
            <div className={`week-bar tone-${tone}`} style={{ height: d[field] ? `${Math.max(6, (d[field] / max) * 100)}%` : '2px', opacity: d[field] ? 1 : 0.35 }} />
          </div>
        ))}
      </div>
      <div className="week-days">
        {days.map(d => <span key={d.day}>{formatDate(`${d.day} 12:00:00`, { weekday: 'narrow' })}</span>)}
      </div>
    </div>
  )
}

function Home() {
  const updates = useAgentUpdates()
  const [agents, setAgents] = useState(null)
  const [stats, setStats] = useState(null)
  const [capacity, setCapacity] = useState(null)
  const [overview, setOverview] = useState(null)
  const [events, setEvents] = useState([])

  useEffect(() => {
    const load = () => {
      authFetch('/api/agents').then(r => r.json()).then(d => setAgents(Array.isArray(d) ? d : [])).catch(() => setAgents(a => a || []))
      authFetch('/api/system/stats').then(r => r.json()).then(setStats).catch(() => {})
    }
    const slow = () => {
      authFetch('/api/system/capacity').then(r => r.json()).then(setCapacity).catch(() => {})
      authFetch('/api/system/overview').then(r => r.json()).then(d => d && d.days && setOverview(d)).catch(() => {})
      authFetch('/api/events?limit=12').then(r => r.json()).then(d => setEvents(Array.isArray(d) ? d : [])).catch(() => {})
    }
    load(); slow()
    const fast = setInterval(() => { if (!document.hidden) load() }, 10000)
    const minute = setInterval(() => { if (!document.hidden) slow() }, 60000)
    return () => { clearInterval(fast); clearInterval(minute) }
  }, [])

  if (agents === null) return <div className="loading">Loading…</div>

  if (agents.length === 0) {
    return (
      <div>
        <div className="page-header"><h1 className="page-title">Dashboard</h1></div>
        <div className="empty-state">
          <Bot size={40} color="var(--text-secondary)" />
          <h2 style={{ fontSize: '1.5rem', margin: '1rem 0 0.5rem' }}>No agents yet</h2>
          <p style={{ color: 'var(--text-secondary)', maxWidth: '400px', margin: '0 auto 1.5rem' }}>
            Deploy your first AI agent or Docker Compose app to get started with AgentHotel.
          </p>
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
            <Link to="/create" className="btn btn-primary"><Plus size={16} color="white" /> Create Agent</Link>
            <Link to="/compose" className="btn btn-secondary"><Layers size={16} color="currentColor" /> Deploy Compose</Link>
          </div>
        </div>
      </div>
    )
  }

  const rows = attentionRows(agents, updates)
  const problems = problemCount(agents)
  const running = agents.filter(a => a.status === 'running').length
  const byKind = KIND_ORDER.map(k => [k, agents.filter(a => (a.kind || 'app') === k).length]).filter(([, n]) => n)
  const names = Object.fromEntries(agents.map(a => [a.id, a.name]))
  const uptime = Object.entries(overview?.uptime24h || {})
    .filter(([id]) => names[id])
    .map(([id, pct]) => ({ id, name: names[id], pct }))
    .sort((a, b) => a.pct - b.pct || a.name.localeCompare(b.name))
  const notFull = uptime.filter(u => u.pct < 100)
  const mem = capacity?.memory
  // The worst row in words, and how many guests the other rows hold.
  const worst = rows.find(r => r.level === 'critical' || r.level === 'warning')
  const inWorst = worst ? (worst.agentId ? 1 : parseInt(worst.title) || 1) : 0
  const worstLine = worst ? `${worst.title}: ${worst.text}${problems > inWorst ? ` · ${problems - inWorst} more` : ''}` : ''

  return (
    <div className="home">
      <div className="page-header">
        <h1 className="page-title">Dashboard</h1>
        <Link to="/agents" className="btn btn-secondary">All agents &amp; apps <ArrowRight size={14} color="currentColor" /></Link>
      </div>

      <div className="home-tiles">
        <Tile label="Guests running" value={`${running} / ${agents.length}`} to="/agents"
          sub={byKind.map(([k, n]) => `${n} ${KIND_LABELS[k].toLowerCase()}`).join(' · ')} />
        <Tile label="Needs attention" value={problems || 'None'} tone={problems ? 'bad' : 'good'}
          to={problems ? '/agents?filter=attention' : undefined}
          sub={problems ? worstLine : 'Every guest is answering'} />
        {stats?.cpu && <Tile label="CPU" value={`${stats.cpu.pct}%`} pct={stats.cpu.pct}
          sub={capacity?.cpu ? `${capacity.cpu.cores} cores` : undefined} />}
        {stats?.mem && <Tile label="Memory" value={`${stats.mem.pct}%`} pct={stats.mem.pct}
          sub={`${formatBytes(stats.mem.used)} of ${formatBytes(stats.mem.total)}${mem ? ` · limits add up to ${Math.round(mem.allocatedToAgentsMB / 102.4) / 10} GB` : ''}`} />}
        {stats?.disk && <Tile label="Disk" value={`${stats.disk.pct}%`} pct={stats.disk.pct}
          sub={`${formatBytes(stats.disk.used)} of ${formatBytes(stats.disk.total)}`} to="/system" />}
      </div>

      <section className="card home-card">
        <div className="home-card-head">
          <h2>Needs attention</h2>
          {rows.length > 0 && <span className="home-card-sub">Worst first, newest problem first</span>}
        </div>
        {rows.length === 0 ? (
          <div className="home-allgood"><CircleCheck size={18} color="currentColor" /> All {agents.length} guests are fine. Faults, warnings and waiting updates show up here and in the sidebar.</div>
        ) : (
          <ul className="attention-list">
            {rows.map(row => (
              <li key={row.key}>
                <Link to={row.to} className={`attention-row level-${row.level}`}>
                  <span className="attention-badge">
                    {row.level === 'busy' ? <Loader size={12} color="currentColor" className="spin" />
                      : row.level === 'update' ? <RefreshCw size={12} color="currentColor" />
                      : row.level === 'critical' || row.level === 'warning' ? <AlertTriangle size={12} color="currentColor" /> : null}
                    {LEVEL_LABEL[row.level]}
                  </span>
                  <span className="attention-title">{row.title}</span>
                  <span className="attention-text">{row.text}</span>
                  <ArrowRight size={14} color="currentColor" className="attention-go" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ActivityView />

      <div className="home-grid">
        <section className="card home-card">
          <div className="home-card-head">
            <h2>Last 7 days</h2>
            <span className="home-card-sub">From the event log</span>
          </div>
          {overview ? (
            <div className="week-charts">
              <WeekChart days={overview.days} field="deploys" label="Deploys" tone="neutral" />
              <WeekChart days={overview.days} field="incidents" label="Incidents" tone="bad" />
              <WeekChart days={overview.days} field="modelErrors" label="Model errors" tone="warn" />
            </div>
          ) : <div className="table-empty">Loading…</div>}
        </section>

        <section className="card home-card">
          <div className="home-card-head">
            <h2>Uptime, last 24 hours</h2>
            <span className="home-card-sub">Probed at its domain once a minute</span>
          </div>
          {!overview ? <div className="table-empty">Loading…</div>
            : uptime.length === 0 ? <div className="table-empty">No guest with a domain has been probed yet</div>
            : (
              <>
                {notFull.length === 0 && (
                  <div className="home-allgood"><CircleCheck size={18} color="currentColor" /> All {uptime.length} guests with a domain answered every probe.</div>
                )}
                <ul className="uptime-list">
                  {notFull.slice(0, 8).map(u => (
                    <li key={u.id}>
                      <Link to={`/agent/${u.id}`}>{u.name}</Link>
                      <div className="uptime-meter" aria-hidden="true"><div className={`uptime-fill ${u.pct < 95 ? 'bad' : u.pct < 99.5 ? 'warn' : 'ok'}`} style={{ width: `${u.pct}%` }} /></div>
                      <span className="uptime-pct">{u.pct}%</span>
                    </li>
                  ))}
                </ul>
                {notFull.length > 0 && uptime.length > notFull.length && (
                  <div className="home-card-foot">The other {uptime.length - notFull.length} answered every probe.</div>
                )}
              </>
            )}
        </section>
      </div>

      <section className="card home-card">
        <div className="home-card-head">
          <h2>Recent events</h2>
          <Link to="/system" className="home-card-link">Full log on System <ArrowRight size={13} color="currentColor" /></Link>
        </div>
        {events.length === 0 ? <div className="table-empty">Nothing logged yet</div> : (
          <ul className="event-list">
            {events.map(e => (
              <li key={e.id}>
                <time>{formatDateTime(e.ts, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
                <span className={`event-type ${/down|unhealthy|error|delete|failed/.test(e.type) ? 'bad' : /warning|model_error|stop/.test(e.type) ? 'warn' : ''}`}>{e.type.replace(/^agent\./, '')}</span>
                <span className="event-msg">{e.agent_id && e.agent_name ? <Link to={`/agent/${e.agent_id}`}>{e.message}</Link> : e.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

export default Home

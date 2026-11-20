import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Cpu, MemoryStick, ChevronDown, ChevronUp } from 'lucide-react'
import { authFetch } from '../lib/auth'
import { formatTime } from '../lib/time.js'

// Who is using the server right now (GET /api/system/activity,
// lib/activity.js), drawn the way Activity Monitor and Stats on a Mac do:
// the whole server over the last few minutes as a stacked area, split by
// what kind of guest is using it, and the heaviest guests under it with a
// curve each.
//
// CPU per guest is given as Activity Monitor does, in percent of one core
// (200 % = two cores); the server's total is given in cores out of all.
//
// Two ranges (2026-11-20): the last hour, one point a minute that the panel
// keeps all the time, so opening the view shows what already happened; and
// live, every 3 s for the last 3 minutes, sampled only while it is open.

const KIND = {
  agent: { label: 'Agents', color: '#3b82f6' },
  tool: { label: 'Tools', color: '#14b8a6' },
  app: { label: 'Apps', color: '#a855f7' },
  build: { label: 'Builds', color: '#f59e0b' },
  hotel: { label: 'AgentHotel', color: '#64748b' },
  other: { label: 'Other containers', color: '#94a3b8' },
  system: { label: 'System', color: 'var(--text-muted)' }
}
const STACK = ['agent', 'tool', 'app', 'build', 'hotel', 'other', 'system']
const RANGES = {
  hour: { label: 'Last hour', poll: 15000, ago: '60 min ago' },
  live: { label: 'Live', poll: 3000, ago: '3 min ago' }
}
const COLLAPSED_KEY = 'agenthotel.activity.collapsed'
const RANGE_KEY = 'agenthotel.activity.range'

const gb = (bytes) => {
  if (!bytes) return '0 MB'
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}
const pctOfCore = (cores) => `${Math.round((cores || 0) * 100)} %`

function readCollapsed() {
  try { return localStorage.getItem(COLLAPSED_KEY) === '1' } catch (_) { return false }
}
function writeCollapsed(v) {
  try { localStorage.setItem(COLLAPSED_KEY, v ? '1' : '0') } catch (_) { /* private window */ }
}
function readRange() {
  try { return localStorage.getItem(RANGE_KEY) === 'live' ? 'live' : 'hour' } catch (_) { return 'hour' }
}
function writeRange(v) {
  try { localStorage.setItem(RANGE_KEY, v) } catch (_) { /* private window */ }
}

// A guest's average over the whole window, a minute it was not running
// counting as nothing: what the hour ranks by, since "now" is one minute of
// sixty, and a build that ran ten minutes is not as heavy as one that ran
// the hour.
function averageOf(values, points) {
  const sum = values.reduce((a, v) => a + (v || 0), 0)
  return points ? sum / points : 0
}

// The series of one metric per kind, aligned at the newest sample. A guest
// that started a minute ago has a shorter history; it counts from where it
// begins. 'system' is what the host used beyond every container.
function stackedSeries(snap, metric) {
  const host = snap.host.history[metric]
  const n = host.length
  const series = Object.fromEntries(STACK.map(k => [k, new Array(n).fill(0)]))
  for (const item of snap.items) {
    const h = item.history[metric]
    const offset = n - h.length
    h.forEach((v, i) => { if (offset + i >= 0 && v != null) series[item.kind][offset + i] += v })
  }
  for (let i = 0; i < n; i++) {
    const inContainers = STACK.slice(0, -1).reduce((a, k) => a + series[k][i], 0)
    series.system[i] = host[i] == null ? 0 : Math.max(host[i] - inContainers, 0)
  }
  return { series, n }
}

function StackedArea({ snap, metric, max, slots, ago }) {
  const { series, n } = useMemo(() => stackedSeries(snap, metric), [snap, metric])
  const W = 300, H = 84
  // Fixed width in time: the curve fills from the right as samples come in,
  // so a fresh view does not stretch two samples across the whole chart.
  const step = W / Math.max(slots - 1, 1)
  const x = (i) => W - (n - 1 - i) * step
  const y = (v) => H - Math.min(v / max, 1) * H
  const base = new Array(n).fill(0)
  const paths = []
  for (const kind of STACK) {
    const top = base.map((b, i) => b + series[kind][i])
    if (n >= 2 && top.some((v, i) => v > base[i])) {
      const up = top.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' L')
      const down = base.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).reverse().join(' L')
      paths.push(<path key={kind} d={`M${up} L${down} Z`} fill={KIND[kind].color}
        fillOpacity={kind === 'system' ? 0.35 : 0.8} stroke="none" />)
    }
    top.forEach((v, i) => { base[i] = v })
  }
  return (
    <>
      <svg className="activity-area" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
        aria-label={`${metric === 'cpu' ? 'CPU' : 'Memory'} over the last ${Math.round(slots * snap.intervalMs / 60000)} minutes`}>
        {[0.25, 0.5, 0.75].map(f => (
          <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} className="activity-grid" vectorEffect="non-scaling-stroke" />
        ))}
        {paths}
      </svg>
      <div className="activity-axis" aria-hidden="true"><span>{ago}</span><span>now</span></div>
    </>
  )
}

function Sparkline({ values, max, color }) {
  const W = 64, H = 18
  const pts = values.map((v, i) => (v == null ? null : [i, v])).filter(Boolean)
  if (pts.length < 2) return <svg className="activity-spark" viewBox={`0 0 ${W} ${H}`} />
  const step = W / Math.max(values.length - 1, 1)
  const d = pts.map(([i, v], k) => `${k ? 'L' : 'M'}${(i * step).toFixed(1)},${(H - 1 - Math.min(v / max, 1) * (H - 2)).toFixed(1)}`).join(' ')
  return (
    <svg className="activity-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={`${d} L${(pts[pts.length - 1][0] * step).toFixed(1)},${H} L${(pts[0][0] * step).toFixed(1)},${H} Z`} fill={color} fillOpacity="0.15" />
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  )
}

function Panel({ snap, metric, showAll, range }) {
  const isCpu = metric === 'cpu'
  const hour = range === 'hour'
  const max = isCpu ? snap.host.cores : snap.host.mem.total
  const now = isCpu ? snap.host.cpu || 0 : snap.host.mem.used
  const points = snap.host.history[metric].length
  const valueOf = (item) => (hour ? averageOf(item.history[metric], points) : (isCpu ? item.cores || 0 : item.mem))
  const ranked = [...snap.items].sort((a, b) => valueOf(b) - valueOf(a))
  const top = showAll ? ranked : ranked.slice(0, 6)
  const heaviest = Math.max(valueOf(ranked[0] || {}), isCpu ? 0.05 : 1)
  // Each guest's curve on its own scale would make an idle one look busy;
  // one scale for all rows, the heaviest guest's peak, keeps them comparable.
  const sparkMax = Math.max(heaviest, ...ranked.slice(0, 6).flatMap(i => i.history[metric].filter(v => v != null)))
  const totals = STACK.map(k => [k, k === 'system'
    ? (isCpu ? snap.system.cores || 0 : snap.system.mem)
    : (isCpu ? snap.kinds[k].cores : snap.kinds[k].mem)]).filter(([, v]) => v > (isCpu ? 0.005 : 1024 ** 2))

  return (
    <div className="activity-panel">
      <div className="activity-panel-head">
        <div className="activity-label">{isCpu ? <Cpu size={15} /> : <MemoryStick size={15} />} {isCpu ? 'CPU' : 'Memory'}</div>
        <div className="activity-big">
          {isCpu
            ? <>{now.toFixed(1)} <span>of {snap.host.cores} cores</span></>
            : <>{gb(now)} <span>of {gb(max)}</span></>}
        </div>
        <div className="activity-pct">{Math.round((now / max) * 100)} %</div>
      </div>
      <StackedArea snap={snap} metric={metric} max={max} slots={60} ago={RANGES[range].ago} />
      <div className="activity-legend">
        {totals.map(([k, v]) => (
          <span key={k} title={k === 'system' ? 'The host outside every container: the kernel, Docker, caches' : undefined}>
            <i style={{ background: KIND[k].color, opacity: k === 'system' ? 0.5 : 1 }} />
            {KIND[k].label} <b>{isCpu ? pctOfCore(v) : gb(v)}</b>
          </span>
        ))}
      </div>
      <ol className="activity-list">
        {top.map(item => {
          const v = valueOf(item)
          const name = item.agentId && item.kind !== 'build'
            ? <Link to={`/agent/${item.agentId}`}>{item.name}</Link>
            : <span>{item.name}</span>
          return (
            <li key={item.key} className={item.gone ? 'activity-gone' : undefined} title={item.gone ? 'Not running now' : undefined}>
              <i className="activity-dot" style={{ background: KIND[item.kind].color }} title={KIND[item.kind].label} />
              <span className="activity-name">{name}</span>
              <Sparkline values={item.history[metric]} max={sparkMax} color={KIND[item.kind].color} />
              <span className="activity-value" title={hour ? 'Average over the hour' : isCpu ? 'Percent of one core, as in Activity Monitor' : item.limit && item.limit < snap.host.mem.total ? `Limit ${gb(item.limit)}` : undefined}>
                {isCpu ? pctOfCore(v) : gb(v)}
                {!hour && !isCpu && item.limit > 0 && item.limit < snap.host.mem.total && (
                  <small> / {gb(item.limit)}</small>
                )}
              </span>
              <span className="activity-bar"><span style={{ width: `${Math.max((v / heaviest) * 100, v > 0 ? 2 : 0)}%`, background: KIND[item.kind].color }} /></span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

export default function Activity() {
  const [snap, setSnap] = useState(null)
  const [error, setError] = useState(null)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [showAll, setShowAll] = useState(false)
  const [range, setRange] = useState(readRange)

  useEffect(() => {
    if (collapsed) return undefined
    let alive = true
    let timer
    setSnap(null)
    const tick = async () => {
      if (!document.hidden) {
        try {
          const res = await authFetch(range === 'hour' ? '/api/system/activity?range=hour' : '/api/system/activity')
          const data = await res.json()
          if (!res.ok) throw new Error(data.error || 'Could not read activity')
          if (alive) { setSnap(data); setError(null) }
        } catch (e) { if (alive) setError(e.message) }
      }
      if (alive) timer = setTimeout(tick, RANGES[range].poll)
    }
    tick()
    return () => { alive = false; clearTimeout(timer) }
  }, [collapsed, range])

  function toggle() {
    setCollapsed(c => { writeCollapsed(!c); return !c })
  }

  function choose(r) {
    writeRange(r)
    setRange(r)
  }

  const building = snap?.items?.filter(i => i.kind === 'build' && !i.gone) || []
  // The panel keeps the hour from when it started; say so while it is younger.
  const since = snap?.since && Date.now() - Date.parse(snap.since) < 60 * 60 * 1000
    ? formatTime(snap.since, { hour: '2-digit', minute: '2-digit' }) : null

  return (
    <section className="activity">
      <button className="activity-header" onClick={toggle} aria-expanded={!collapsed}>
        <span className="activity-title">
          Activity
          {!collapsed && snap && <span className="activity-live" title={range === 'hour' ? 'One point a minute' : 'Updated every 3 s'} />}
        </span>
        <span className="activity-sub">
          {collapsed ? 'Who is using the CPU and the memory, live'
            : snap?.ready ? <>{snap.items.filter(i => !i.gone).length} guests · {building.length ? building.map(b => b.name).join(', ') : 'no build running'}</>
            : 'Measuring…'}
        </span>
        {collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
      </button>

      {!collapsed && (
        <div className="activity-range" role="group" aria-label="Range">
          {Object.entries(RANGES).map(([key, r]) => (
            <button key={key} type="button" className={range === key ? 'active' : ''} aria-pressed={range === key} onClick={() => choose(key)}>
              {r.label}
            </button>
          ))}
          {range === 'hour' && snap?.ready && (
            <span className="activity-since">Per guest: the hour's average{since ? ` · since the panel started at ${since}` : ''}</span>
          )}
        </div>
      )}
      {!collapsed && error && <div className="table-empty" style={{ color: 'var(--accent-red)' }}>{error}</div>}
      {!collapsed && !snap && !error && <div className="activity-skeleton" />}
      {!collapsed && snap && !snap.ready && range === 'hour' && (
        <div className="table-empty">The hour fills in from when the panel started; the first point comes within a minute.</div>
      )}
      {!collapsed && snap && snap.ready && (
        <>
          <div className="activity-panels">
            <Panel snap={snap} metric="cpu" showAll={showAll} range={range} />
            <Panel snap={snap} metric="mem" showAll={showAll} range={range} />
          </div>
          {snap.items.length > 6 && (
            <button className="activity-more" onClick={() => setShowAll(s => !s)}>
              {showAll ? 'Show the top six' : `Show all ${snap.items.length}`}
            </button>
          )}
        </>
      )}
    </section>
  )
}


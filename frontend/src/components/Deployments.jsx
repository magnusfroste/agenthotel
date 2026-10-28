import { useState, useEffect, useRef } from 'react'
import { CheckCircle2, XCircle, Loader2, Clock, AlertTriangle, GitCommit, Undo2 } from 'lucide-react'
import { authFetch, authFetchOk } from '../lib/auth'
import { useToast } from './Toast'

// An agent's deploys, newest first, and the full log of the one selected —
// one row per deploy. A running deploy's log is followed by polling
// from the byte offset already shown, so a long build costs one small request
// every second and a half. The log can carry secrets (build output, compose
// .env interpolation); the backend masks config secrets, and data-secret keeps
// a screen recording from showing whatever it missed.

const STATUS = {
  queued: { label: 'Queued', color: 'var(--text-secondary)', Icon: Clock },
  running: { label: 'Running', color: 'var(--accent-blue)', Icon: Loader2, spin: true },
  succeeded: { label: 'Succeeded', color: 'var(--accent-green)', Icon: CheckCircle2 },
  failed: { label: 'Failed', color: 'var(--accent-red)', Icon: XCircle },
  interrupted: { label: 'Interrupted', color: 'var(--accent-yellow)', Icon: AlertTriangle }
}

const KIND = { create: 'Create', redeploy: 'Redeploy', rebuild: 'Rebuild', rollback: 'Rollback', update: 'Settings change', deploy: 'Deploy' }

// A deploy a Git App can go back to: it succeeded and recorded its full commit
// (backend/lib/rollback.js; older deploys kept only seven characters).
const FULL_SHA = /^[0-9a-f]{40}$/i
const canRollBack = d => d && d.status === 'succeeded' && FULL_SHA.test(d.commit_sha || '')

function duration(d) {
  const end = d.finished_at || Date.now()
  const start = d.started_at || d.queued_at
  const s = Math.max(0, Math.round((end - start) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(ms).toLocaleDateString()
}

function StatusBadge({ status }) {
  const st = STATUS[status] || STATUS.queued
  const { Icon } = st
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', color: st.color, fontSize: '0.8rem', fontWeight: 600 }}>
      <Icon size={14} color="currentColor" className={st.spin ? 'spin' : undefined} /> {st.label}
    </span>
  )
}

export default function Deployments({ agentId, rollbackable = false }) {
  const toast = useToast()
  const [rolling, setRolling] = useState(false)
  const [deploys, setDeploys] = useState(null)
  const [selected, setSelected] = useState(null)
  const [log, setLog] = useState('')
  const [done, setDone] = useState(true)
  const offsetRef = useRef(0)
  const boxRef = useRef(null)
  const followRef = useRef(true)

  // The list: often while something runs, rarely otherwise.
  useEffect(() => {
    let stop = false
    let timer
    async function load() {
      try {
        const res = await authFetch(`/api/agents/${agentId}/deployments`)
        if (res.ok) {
          const data = await res.json()
          if (stop) return
          setDeploys(data.deployments)
          setSelected(cur => {
            if (cur && data.deployments.some(d => d.id === cur)) return cur
            return data.deployments[0]?.id ?? null
          })
          const active = data.deployments.some(d => d.status === 'queued' || d.status === 'running')
          timer = setTimeout(load, active ? 3000 : 15000)
          return
        }
      } catch (e) { /* retried below */ }
      if (!stop) timer = setTimeout(load, 15000)
    }
    load()
    return () => { stop = true; clearTimeout(timer) }
  }, [agentId])

  // The selected deploy's log, from where it left off.
  useEffect(() => {
    if (selected == null) return
    let stop = false
    let timer
    offsetRef.current = 0
    followRef.current = true
    setLog('')
    setDone(false)
    async function poll() {
      try {
        const res = await authFetch(`/api/agents/${agentId}/deployments/${selected}/log?offset=${offsetRef.current}`)
        if (res.ok) {
          const data = await res.json()
          if (stop) return
          if (data.text) setLog(prev => prev + data.text)
          offsetRef.current = data.offset
          setDone(data.done)
          if (!data.done) timer = setTimeout(poll, 1500)
          return
        }
      } catch (e) { /* retried below */ }
      if (!stop) timer = setTimeout(poll, 4000)
    }
    poll()
    return () => { stop = true; clearTimeout(timer) }
  }, [agentId, selected])

  // Stay at the bottom while following; leave the reader where they scrolled.
  useEffect(() => {
    const box = boxRef.current
    if (box && followRef.current) box.scrollTop = box.scrollHeight
  }, [log])

  function onScroll() {
    const box = boxRef.current
    if (box) followRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40
  }

  if (deploys === null) return <div className="loading">Loading deployments…</div>
  if (!deploys.length) {
    return (
      <div style={{ color: 'var(--text-secondary)', padding: '2rem 0', textAlign: 'center' }}>
        No deploys recorded yet. The next create, redeploy or settings change shows up here with its full log.
      </div>
    )
  }

  const current = deploys.find(d => d.id === selected)
  // What runs now: the newest deploy that succeeded. Rolling back to it would
  // change nothing, so it gets no button.
  const running = deploys.find(d => d.status === 'succeeded')
  const busy = deploys.some(d => d.status === 'queued' || d.status === 'running')

  // A rollback lasts as long as its deploy; the list shows it from the start.
  async function rollBack(d) {
    const short = d.commit_sha.slice(0, 7)
    if (!confirm(`Roll back to ${short}, deployed ${new Date(d.queued_at).toLocaleString()}?\n\nThe agent is built from that commit again and restarts. Its branch setting is unchanged, so the next redeploy brings it back up to date.`)) return
    setRolling(true)
    const done = authFetchOk(`/api/agents/${agentId}/rollback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deploymentId: d.id })
    })
    setTimeout(() => setSelected(null), 1500)
    try { await done; toast.success(`Rolled back to ${short}`) }
    catch (err) { toast.error(`Rollback failed: ${err.message}`) }
    finally { setRolling(false) }
  }

  return (
    <div className="deployments">
      <div className="deployments-list">
        {deploys.map(d => (
          <button key={d.id} onClick={() => setSelected(d.id)} className={`deployment-row${d.id === selected ? ' selected' : ''}`}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
              <StatusBadge status={d.status} />
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{duration(d)}</span>
            </div>
            <div style={{ fontSize: '0.85rem', marginTop: '0.25rem', textAlign: 'left' }}>
              {KIND[d.kind] || d.kind}{d.trigger ? <span style={{ color: 'var(--text-secondary)' }}> · {d.trigger}</span> : null}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
              <span>{ago(d.queued_at)}</span>
              {d.commit_sha && <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem', fontFamily: 'monospace' }}><GitCommit size={12} color="currentColor" />{d.commit_sha.slice(0, 7)}</span>}
            </div>
          </button>
        ))}
      </div>
      <div className="deployments-log">
        {current && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.6rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
              <StatusBadge status={current.status} />
              <span style={{ fontSize: '0.85rem' }}>{KIND[current.kind] || current.kind} #{current.id}</span>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{new Date(current.queued_at).toLocaleString()} · {duration(current)}</span>
            </div>
            {!done && <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Following live…</span>}
            {done && rollbackable && canRollBack(current) && running && current.id !== running.id && current.commit_sha !== running.commit_sha && (
              <button className="btn btn-secondary" disabled={rolling || busy} onClick={() => rollBack(current)}
                title="Build this commit again and run it"
                style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8rem' }}>
                <Undo2 size={14} color="currentColor" /> Roll back to {current.commit_sha.slice(0, 7)}
              </button>
            )}
          </div>
        )}
        {current?.error && (
          <div style={{ color: 'var(--accent-red)', fontSize: '0.85rem', marginBottom: '0.6rem', whiteSpace: 'pre-wrap' }}>{current.error}</div>
        )}
        <pre data-secret="" ref={boxRef} onScroll={onScroll} className="deployments-pre">{log || 'Waiting for output…'}</pre>
      </div>
    </div>
  )
}

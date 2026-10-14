import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Copy, Check, Loader2, Truck, CheckCircle2, XCircle } from 'lucide-react'
import { authFetch } from '../lib/auth'

// Moving an agent between hotels (backend/lib/transfers.js). This hotel
// issues a one-time link; the other hotel pastes it under Import Agent and
// fetches the agent itself, server to server — so an agent's memory never
// passes through a browser or a proxy's upload limit.

// The sending half: shown in an agent's Export dialog.
export function MoveOut({ agent }) {
  const [includeData, setIncludeData] = useState(true)
  const [ticket, setTicket] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  async function issue() {
    setBusy(true); setError(null)
    try {
      const res = await authFetch(`/api/agents/${agent.id}/transfer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeData, stopOnPull: true })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not create the link')
      setTicket(data)
    } catch (err) { setError(err.message) }
    setBusy(false)
  }

  async function copy() {
    try { await navigator.clipboard.writeText(ticket.url); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch (_) {}
  }

  return (
    <div className="transfer-box">
      <div className="transfer-title"><Truck size={16} /> Move to another hotel</div>
      {!ticket ? (
        <>
          <p className="modal-text" style={{ margin: '0.25rem 0 0.75rem' }}>
            A one-time link the other hotel pulls <strong>{agent.name}</strong> from, server to server.
            Valid for an hour, good for one move.
          </p>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', fontSize: '0.85rem', marginBottom: '0.75rem' }}>
            <input type="checkbox" checked={includeData} onChange={e => setIncludeData(e.target.checked)} style={{ marginTop: '0.2rem' }} />
            <span>Bring its memory — the agent's volume data. It keeps running here until the other hotel pulls it, then stops here, so it never runs in two places at once.</span>
          </label>
          <button className="btn btn-primary" disabled={busy} onClick={issue} style={{ width: '100%' }}>
            {busy ? 'Creating…' : 'Create move link'}
          </button>
          {error && <div className="transfer-error">{error}</div>}
        </>
      ) : (
        <>
          <div className="transfer-link" data-secret="">
            <code>{ticket.url}</code>
            <button type="button" className="btn btn-secondary" onClick={copy} title="Copy link">
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
          <ol className="transfer-steps">
            <li>On the other hotel: <strong>Import Agent → From another hotel</strong>, paste this link.</li>
            <li>When it arrives there, point <strong>{agent.domain || 'its domain'}</strong>'s DNS at the new hotel and redeploy it.</li>
            <li>Delete it here once it runs there.</li>
          </ol>
          <p className="modal-text" style={{ fontSize: '0.8rem', marginBottom: 0 }}>
            Expires {new Date(ticket.expiresAt).toLocaleString()}. The link is a key: give it only to the hotel that should get the agent.
          </p>
        </>
      )}
    </div>
  )
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(bytes > 100 * 1024 * 1024 ? 0 : 1)} MB`

// The receiving half: shown in Fleet's Import Agent dialog.
export function MoveIn({ onDone }) {
  const [url, setUrl] = useState('')
  const [job, setJob] = useState(null)
  const [error, setError] = useState(null)
  const timer = useRef(null)

  useEffect(() => () => clearTimeout(timer.current), [])

  async function poll(id) {
    try {
      const res = await authFetch(`/api/agents/import-from/${id}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Lost track of the import')
      setJob(data)
      if (data.status === 'done') { onDone?.(data.agent); return }
      if (data.status === 'failed') return
    } catch (err) { setError(err.message); return }
    timer.current = setTimeout(() => poll(id), 1500)
  }

  async function start(e) {
    e?.preventDefault()
    setError(null)
    try {
      const res = await authFetch('/api/agents/import-from', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url.trim() })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not start the move')
      setJob(data)
      poll(data.id)
    } catch (err) { setError(err.message) }
  }

  if (job) {
    const pct = job.total ? Math.round((job.bytes / job.total) * 100) : null
    return (
      <div className="transfer-box">
        <div className="transfer-title"><Truck size={16} /> Moving in from another hotel</div>
        {job.status === 'downloading' && (
          <div className="transfer-progress">
            <Loader2 size={15} className="spin" /> Fetching {mb(job.bytes)}{job.total ? ` of ${mb(job.total)}` : ''}…
            {pct !== null && <div className="transfer-bar"><div style={{ width: `${pct}%` }} /></div>}
          </div>
        )}
        {job.status === 'importing' && <div className="transfer-progress"><Loader2 size={15} className="spin" /> Unpacking {mb(job.bytes)} and restoring its data…</div>}
        {job.status === 'done' && (
          <div className="transfer-done">
            <CheckCircle2 size={16} /> <strong>{job.agent.name}</strong> has checked in{job.agent.volumesRestored ? `, with ${job.agent.volumesRestored} volume(s) of memory` : ''}. It arrived stopped: point {job.agent.domain || 'its domain'}'s DNS here, then{' '}
            <Link to={`/agent/${job.agent.id}`}>open it and redeploy</Link>.
          </div>
        )}
        {job.status === 'failed' && <div className="transfer-error"><XCircle size={15} /> {job.error}</div>}
      </div>
    )
  }

  return (
    <form className="transfer-box" onSubmit={start}>
      <div className="transfer-title"><Truck size={16} /> From another hotel</div>
      <p className="modal-text" style={{ margin: '0.25rem 0 0.75rem' }}>
        Paste the move link from the other hotel (agent → Export → Move to another hotel). This hotel fetches the agent itself, memory included.
      </p>
      <input data-secret="" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://other-hotel.example.com/api/transfer/…" style={{ width: '100%', marginBottom: '0.75rem' }} />
      <button className="btn btn-primary" type="submit" disabled={!url.trim()} style={{ width: '100%' }}>Move it here</button>
      {error && <div className="transfer-error">{error}</div>}
    </form>
  )
}

import { useState, useEffect } from 'react'
import { authFetch } from '../lib/auth'
import { AlertTriangle } from 'lucide-react'

// Replies that failed at the model (backend lib/modelErrors.js). The agent is
// up and its health probe passes, but it could not think: a used-up budget, a
// refused key, a model the gateway does not have. Shown only when there are
// some, because an agent that answers needs no box saying so.

const KIND_LABEL = {
  budget: 'Budget used up',
  key: 'Key refused',
  model: 'Unknown model',
  rate_limit: 'Rate limited',
  context: 'Conversation too long',
  unavailable: 'Gateway did not answer',
  other: 'Model call failed'
}

const when = (ms) => new Date(ms).toLocaleString()

// One line for the dashboard card, from the summary in the agents list.
export function ModelErrorsLine({ summary }) {
  if (!summary || !summary.count) return null
  const { count, last } = summary
  return (
    <div className="agent-card-meta-item" style={{ color: '#f59e0b' }}
      title={`Last at ${when(last.at)}: ${last.summary}`}>
      <AlertTriangle size={14} color="currentColor" />
      <span>{count === 1 ? '1 reply' : `${count} replies`} failed at the model (24 h): {KIND_LABEL[last.kind] || last.kind}</span>
    </div>
  )
}

// The list on the agent page: the last week, newest first.
export default function ModelErrors({ agentId }) {
  const [data, setData] = useState(null)

  useEffect(() => {
    let alive = true
    const load = () => authFetch(`/api/agents/${agentId}/model-errors`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (alive) setData(d) })
      .catch(() => {})
    load()
    const t = setInterval(load, 60000)
    return () => { alive = false; clearInterval(t) }
  }, [agentId])

  if (!data || !data.errors || !data.errors.length) return null
  const latest = data.errors[0]
  return (
    <div style={{
      border: '1px solid #f59e0b', borderRadius: '0.5rem', padding: '0.9rem 1rem',
      marginBottom: '1.5rem', background: 'rgba(245, 158, 11, 0.06)'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 600, marginBottom: '0.35rem' }}>
        <AlertTriangle size={16} color="#f59e0b" />
        {data.summary.count
          ? `${data.summary.count === 1 ? '1 reply' : `${data.summary.count} replies`} failed at the model in the last 24 hours`
          : 'Replies failed at the model this week'}
      </div>
      <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.6rem' }}>
        The agent is running, but {latest.advice}{latest.host ? ` (${latest.host})` : ''}. Whoever wrote to it got an error instead of an answer.
      </div>
      <div style={{ display: 'grid', gap: '0.3rem', fontSize: '0.8rem' }}>
        {data.errors.map((e, i) => (
          <div key={i} style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--text-secondary)', minWidth: '10rem' }}>{when(e.at)}</span>
            <span style={{ fontWeight: 600, minWidth: '9rem' }}>{KIND_LABEL[e.kind] || e.kind}</span>
            <span style={{ color: 'var(--text-secondary)' }}>{e.source === 'cron' ? 'scheduled job' : 'chat'}</span>
            <span style={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>{e.summary}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

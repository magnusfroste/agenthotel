import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { authFetch } from '../lib/auth'
import { useToast } from './Toast'
import { ExternalLink, Trash2, RefreshCw } from 'lucide-react'

function Domains() {
  const [domains, setDomains] = useState([])
  const [loading, setLoading] = useState(true)
  const toast = useToast()

  useEffect(() => { fetchDomains() }, [])

  async function fetchDomains() {
    try {
      const res = await authFetch('/api/domains')
      setDomains(await res.json())
    } catch (err) { console.error('Failed to fetch domains:', err) }
    finally { setLoading(false) }
  }

  async function removeRoute(id, domain) {
    if (!confirm(`Remove the Caddy route for ${domain}? (The container is not deleted.)`)) return
    try {
      await authFetch(`/api/domains/${id}`, { method: 'DELETE' })
      await fetchDomains()
      toast.success(`Route for ${domain} removed`)
    } catch (err) { toast.error('Failed to remove: ' + err.message) }
  }

  const statusColor = (s) => s === 'running' ? '#10b981' : s === 'orphaned' ? '#ef4444' : '#f59e0b'

  if (loading) return <div className="loading">Loading domains…</div>

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h1 style={{ margin: 0 }}>Domains</h1>
        <button className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }} onClick={fetchDomains}><RefreshCw size={15} color="white" /> Refresh</button>
      </div>

      {domains.length === 0 ? (
        <div style={{ padding: '2rem', background: 'var(--bg-secondary, #1e293b)', borderRadius: '0.5rem', textAlign: 'center', color: 'var(--text-secondary, #94a3b8)' }}>
          No domains configured. Deploy an agent with a domain to get started.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          {domains.map((d, i) => {
            const clickable = d.domain && d.domain.includes('.')
            return (
              <div key={i} style={{ background: 'var(--bg-secondary, #1e293b)', borderRadius: '0.5rem', padding: '1.1rem 1.25rem', border: d.orphaned ? '1px solid #ef4444' : '1px solid var(--border, #334155)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                      {clickable ? (
                        <a href={`https://${d.domain}`} target="_blank" rel="noopener noreferrer" style={{ color: '#60a5fa', fontSize: '1.05rem', fontWeight: 600, textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                          {d.domain} <ExternalLink size={14} color="currentColor" />
                        </a>
                      ) : (
                        <span style={{ fontSize: '1.05rem', fontWeight: 600 }}>{d.domain}</span>
                      )}
                      <span style={{ padding: '0.15rem 0.6rem', borderRadius: '1rem', fontSize: '0.7rem', fontWeight: 600, background: statusColor(d.status), color: 'white', textTransform: 'uppercase' }}>{d.status}</span>
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary, #94a3b8)', marginTop: '0.3rem', fontFamily: 'monospace' }}>
                      {d.agentName} {d.runtime !== 'panel' && `· ${d.runtime}`} · {d.container}:{d.port}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    {d.id !== 'panel-route' && !d.orphaned && d.agentName && !d.agentName.startsWith('(') && (
                      <Link to={`/agent/${d.id.replace('agent-', '')}`} style={{ fontSize: '0.8rem', color: '#60a5fa', textDecoration: 'none' }}>Manage →</Link>
                    )}
                    {d.orphaned && (
                      <button className="btn btn-danger" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', padding: '0.3rem 0.7rem', fontSize: '0.8rem' }} onClick={() => removeRoute(d.id, d.domain)}><Trash2 size={14} color="white" /> Remove route</button>
                    )}
                  </div>
                </div>
                {d.orphaned && (
                  <div style={{ marginTop: '0.6rem', fontSize: '0.78rem', color: '#fca5a5' }}>
                    Backing container no longer exists. This is a leftover route — safe to remove.
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <div style={{ marginTop: '2rem', padding: '1rem', background: 'var(--bg-secondary, #1e293b)', borderRadius: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary, #94a3b8)' }}>
        <strong>How it works</strong>
        <p style={{ margin: '0.5rem 0 0 0' }}>Routes are created automatically by Caddy when agents are deployed. SSL certificates are issued via Let's Encrypt and renewed automatically. Orphaned routes (container removed but route remains) can be cleaned up here.</p>
      </div>
    </div>
  )
}

export default Domains

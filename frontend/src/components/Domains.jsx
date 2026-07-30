import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { authFetch } from '../lib/auth'
import { useToast } from './Toast'
import { ExternalLink, Trash2, RefreshCw, Globe } from 'lucide-react'

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

  if (loading) {
    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <div style={{ width: '120px', height: '32px', background: 'var(--bg-secondary)', borderRadius: '0.5rem', animation: 'pulse 1.5s ease-in-out infinite' }} />
          <div style={{ width: '100px', height: '36px', background: 'var(--bg-secondary)', borderRadius: '0.5rem', animation: 'pulse 1.5s ease-in-out infinite' }} />
        </div>
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          {[...Array(3)].map((_, i) => (
            <div key={i} style={{ background: 'var(--bg-secondary)', borderRadius: '0.5rem', padding: '1.1rem 1.25rem', animation: 'pulse 1.5s ease-in-out infinite' }}>
              <div style={{ width: '60%', height: '20px', background: 'var(--bg-tertiary)', borderRadius: '0.25rem', marginBottom: '0.5rem' }} />
              <div style={{ width: '80%', height: '14px', background: 'var(--bg-tertiary)', borderRadius: '0.25rem' }} />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h1 style={{ margin: 0 }}>Domains</h1>
        <button className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }} onClick={fetchDomains}><RefreshCw size={15} color="white" /> Refresh</button>
      </div>

      {domains.length === 0 ? (
        <div style={{ 
          padding: '3rem 2rem', 
          background: 'var(--bg-secondary, #1e293b)', 
          borderRadius: '0.5rem', 
          textAlign: 'center'
        }}>
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
            <Globe size={40} color="var(--text-secondary)" />
          </div>
          <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1.25rem' }}>No domains configured</h3>
          <p style={{ color: 'var(--text-secondary, #94a3b8)', margin: '0 auto 1.5rem', maxWidth: '400px' }}>
            Deploy an agent with a domain to get started. Routes are automatically configured by Caddy with SSL certificates.
          </p>
          <Link to="/create" className="btn btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
            Create Agent
          </Link>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          {domains.map((d, i) => {
            const clickable = d.domain && d.domain.includes('.')
            return (
              <div key={i} className={`domain-card ${d.orphaned ? 'orphaned' : ''}`}>
                <div className="domain-card-header">
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                      {clickable ? (
                        <a href={`https://${d.domain}`} target="_blank" rel="noopener noreferrer" className="domain-card-title">
                          {d.domain} <ExternalLink size={14} color="currentColor" />
                        </a>
                      ) : (
                        <span style={{ fontSize: '1.05rem', fontWeight: 600 }}>{d.domain}</span>
                      )}
                      <span className="status-badge" style={{ background: statusColor(d.status) }}>
                        {d.status}
                      </span>
                    </div>
                    <div className="domain-card-meta">
                      {d.agentName} {d.runtime !== 'panel' && `· ${d.runtime}`} · {d.container}:{d.port}
                    </div>
                  </div>
                  <div className="domain-card-actions">
                    {d.id !== 'panel-route' && !d.orphaned && d.agentName && !d.agentName.startsWith('(') && (
                      <Link to={`/agent/${d.id.replace('agent-', '')}`} className="btn btn-secondary" style={{ fontSize: '0.8rem', padding: '0.4rem 0.8rem' }}>
                        Manage →
                      </Link>
                    )}
                    {d.orphaned && (
                      <button 
                        className="btn btn-danger" 
                        style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', padding: '0.4rem 0.8rem', fontSize: '0.8rem' }} 
                        onClick={() => removeRoute(d.id, d.domain)}
                      >
                        <Trash2 size={14} color="white" /> Remove route
                      </button>
                    )}
                  </div>
                </div>
                {d.orphaned && (
                  <div className="domain-card-warning">
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

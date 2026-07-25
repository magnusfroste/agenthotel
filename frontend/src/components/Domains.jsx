import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { authFetch } from '../lib/auth'

function Domains() {
  const [domains, setDomains] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchDomains()
  }, [])

  async function fetchDomains() {
    try {
      const res = await authFetch('/api/domains')
      const data = await res.json()
      setDomains(data)
    } catch (err) {
      console.error('Failed to fetch domains:', err)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return <div className="loading">Loading domains...</div>
  }

  return (
    <div>
      <h1 style={{ marginBottom: '2rem' }}>Domains</h1>

      {domains.length === 0 ? (
        <div style={{
          padding: '2rem',
          background: 'var(--bg-secondary, #1e293b)',
          borderRadius: '0.5rem',
          textAlign: 'center',
          color: 'var(--text-secondary, #94a3b8)'
        }}>
          No domains configured. Create an agent with a domain to get started.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '1rem' }}>
          {domains.map((domain, i) => (
            <div key={i} style={{
              background: 'var(--bg-secondary, #1e293b)',
              borderRadius: '0.5rem',
              padding: '1.5rem',
              border: '1px solid var(--border, #334155)'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '1rem' }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: '1.25rem', color: 'var(--text-primary, #e2e8f0)' }}>
                    {domain.domain}
                  </h3>
                  <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary, #94a3b8)', marginTop: '0.25rem' }}>
                    {domain.agentName} • {domain.runtime}
                  </div>
                </div>
                <div style={{
                  padding: '0.25rem 0.75rem',
                  borderRadius: '0.25rem',
                  fontSize: '0.75rem',
                  fontWeight: '600',
                  background: domain.status === 'running' ? '#10b981' : domain.status === 'stopped' ? '#ef4444' : '#f59e0b',
                  color: 'white'
                }}>
                  {domain.status?.toUpperCase()}
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', fontSize: '0.875rem' }}>
                <div>
                  <div style={{ color: 'var(--text-secondary, #94a3b8)', marginBottom: '0.25rem' }}>External Domain</div>
                  <div style={{ color: 'var(--text-primary, #e2e8f0)', fontWeight: '500', fontFamily: 'monospace' }}>
                    https://{domain.domain}
                  </div>
                </div>
                <div>
                  <div style={{ color: 'var(--text-secondary, #94a3b8)', marginBottom: '0.25rem' }}>Internal Container</div>
                  <div style={{ color: 'var(--text-primary, #e2e8f0)', fontWeight: '500', fontFamily: 'monospace' }}>
                    {domain.container}
                  </div>
                </div>
                <div>
                  <div style={{ color: 'var(--text-secondary, #94a3b8)', marginBottom: '0.25rem' }}>Port</div>
                  <div style={{ color: 'var(--text-primary, #e2e8f0)', fontWeight: '500', fontFamily: 'monospace' }}>
                    {domain.port}
                  </div>
                </div>
              </div>

              {domain.id !== 'panel-route' && (
                <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--border, #334155)' }}>
                  <Link 
                    to={`/agent/${domains.find(d => d.domain === domain.domain)?.id || ''}`}
                    style={{ fontSize: '0.875rem', color: '#3b82f6', textDecoration: 'none' }}
                  >
                    View Agent Details →
                  </Link>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{
        marginTop: '2rem',
        padding: '1rem',
        background: 'var(--bg-secondary, #1e293b)',
        borderRadius: '0.5rem',
        fontSize: '0.875rem',
        color: 'var(--text-secondary, #94a3b8)'
      }}>
        <strong>ℹ️ About Domains:</strong>
        <p style={{ margin: '0.5rem 0 0 0' }}>
          Domains are automatically configured when agents are deployed with custom domain names.
          SSL certificates are provisioned automatically via Let's Encrypt.
        </p>
      </div>
    </div>
  )
}

export default Domains

import { useState, useEffect } from 'react'
import { authFetch } from '../lib/auth'

function Certificates() {
  const [certificates, setCertificates] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchCertificates()
  }, [])

  async function fetchCertificates() {
    try {
      const res = await authFetch('/api/certificates')
      const data = await res.json()
      setCertificates(data)
    } catch (err) {
      console.error('Failed to fetch certificates:', err)
    } finally {
      setLoading(false)
    }
  }

  function formatDate(dateStr) {
    if (!dateStr) return 'N/A'
    return new Date(dateStr).toLocaleDateString('sv-SE', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    })
  }

  function daysUntilExpiry(dateStr) {
    if (!dateStr) return null
    const now = new Date()
    const expiry = new Date(dateStr)
    const diff = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24))
    return diff
  }

  if (loading) {
    return <div className="loading">Loading certificates...</div>
  }

  return (
    <div>
      <h1 style={{ marginBottom: '2rem' }}>SSL Certificates</h1>

      {certificates.length === 0 ? (
        <div style={{
          padding: '2rem',
          background: 'var(--bg-secondary, #1e293b)',
          borderRadius: '0.5rem',
          textAlign: 'center',
          color: 'var(--text-secondary, #94a3b8)'
        }}>
          No SSL certificates found. Certificates are automatically provisioned when agents are deployed with domains.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '1rem' }}>
          {certificates.map((cert, i) => {
            const daysLeft = daysUntilExpiry(cert.notAfter)
            const isExpiringSoon = daysLeft !== null && daysLeft < 30
            const isExpired = daysLeft !== null && daysLeft < 0

            return (
              <div key={i} style={{
                background: 'var(--bg-secondary, #1e293b)',
                borderRadius: '0.5rem',
                padding: '1.5rem',
                border: isExpired ? '2px solid #ef4444' : isExpiringSoon ? '2px solid #f59e0b' : '1px solid var(--border, #334155)'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '1rem' }}>
                  <div>
                    <h3 style={{ margin: 0, fontSize: '1.25rem', color: 'var(--text-primary, #e2e8f0)' }}>
                      {cert.domain}
                    </h3>
                    <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary, #94a3b8)', marginTop: '0.25rem' }}>
                      Issuer: {cert.issuer}
                    </div>
                  </div>
                  <div style={{
                    padding: '0.25rem 0.75rem',
                    borderRadius: '0.25rem',
                    fontSize: '0.75rem',
                    fontWeight: '600',
                    background: isExpired ? '#ef4444' : isExpiringSoon ? '#f59e0b' : '#10b981',
                    color: 'white'
                  }}>
                    {isExpired ? 'EXPIRED' : isExpiringSoon ? 'EXPIRING SOON' : 'ACTIVE'}
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', fontSize: '0.875rem' }}>
                  <div>
                    <div style={{ color: 'var(--text-secondary, #94a3b8)', marginBottom: '0.25rem' }}>Issued</div>
                    <div style={{ color: 'var(--text-primary, #e2e8f0)', fontWeight: '500' }}>
                      {formatDate(cert.notBefore)}
                    </div>
                  </div>
                  <div>
                    <div style={{ color: 'var(--text-secondary, #94a3b8)', marginBottom: '0.25rem' }}>Expires</div>
                    <div style={{ color: 'var(--text-primary, #e2e8f0)', fontWeight: '500' }}>
                      {formatDate(cert.notAfter)}
                      {daysLeft !== null && (
                        <span style={{ marginLeft: '0.5rem', color: isExpired ? '#ef4444' : isExpiringSoon ? '#f59e0b' : '#10b981' }}>
                          ({daysLeft > 0 ? `${daysLeft} days left` : `${Math.abs(daysLeft)} days ago`})
                        </span>
                      )}
                    </div>
                  </div>
                  <div>
                    <div style={{ color: 'var(--text-secondary, #94a3b8)', marginBottom: '0.25rem' }}>Certificate Hash</div>
                    <div style={{ color: 'var(--text-primary, #e2e8f0)', fontFamily: 'monospace', fontSize: '0.75rem' }}>
                      {cert.hash?.substring(0, 16)}...
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
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
        <strong>ℹ️ About Certificates:</strong>
        <p style={{ margin: '0.5rem 0 0 0' }}>
          SSL certificates are automatically provisioned by Let's Encrypt when agents are deployed with custom domains.
          Certificates are renewed automatically before expiration.
        </p>
      </div>
    </div>
  )
}

export default Certificates

import { useState, useEffect } from 'react'
import { authFetch } from '../lib/auth'
import { Shield } from 'lucide-react'

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
    return (
      <div>
        <div style={{ width: '200px', height: '32px', background: 'var(--bg-secondary)', borderRadius: '0.5rem', marginBottom: '2rem', animation: 'pulse 1.5s ease-in-out infinite' }} />
        <div style={{ display: 'grid', gap: '1rem' }}>
          {[...Array(3)].map((_, i) => (
            <div key={i} style={{ background: 'var(--bg-secondary)', borderRadius: '0.5rem', padding: '1.5rem', animation: 'pulse 1.5s ease-in-out infinite' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '1rem' }}>
                <div>
                  <div style={{ width: '180px', height: '20px', background: 'var(--bg-tertiary)', borderRadius: '0.25rem', marginBottom: '0.5rem' }} />
                  <div style={{ width: '120px', height: '14px', background: 'var(--bg-tertiary)', borderRadius: '0.25rem' }} />
                </div>
                <div style={{ width: '80px', height: '24px', background: 'var(--bg-tertiary)', borderRadius: '0.25rem' }} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
                <div style={{ width: '100%', height: '14px', background: 'var(--bg-tertiary)', borderRadius: '0.25rem' }} />
                <div style={{ width: '100%', height: '14px', background: 'var(--bg-tertiary)', borderRadius: '0.25rem' }} />
                <div style={{ width: '100%', height: '14px', background: 'var(--bg-tertiary)', borderRadius: '0.25rem' }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div>
      <h1 style={{ marginBottom: '2rem' }}>SSL Certificates</h1>

      {certificates.length === 0 ? (
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
            <Shield size={40} color="var(--text-secondary)" />
          </div>
          <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1.25rem' }}>No SSL certificates found</h3>
          <p style={{ color: 'var(--text-secondary, #94a3b8)', margin: '0 auto 1.5rem', maxWidth: '400px' }}>
            Certificates are automatically provisioned by Let's Encrypt when agents are deployed with custom domains.
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '1rem' }}>
          {certificates.map((cert, i) => {
            const daysLeft = daysUntilExpiry(cert.notAfter)
            const isExpiringSoon = daysLeft !== null && daysLeft < 30
            const isExpired = daysLeft !== null && daysLeft < 0

            return (
              <div key={i} className={`cert-card ${isExpired ? 'expired' : isExpiringSoon ? 'expiring-soon' : ''}`}>
                <div className="cert-card-header">
                  <div>
                    <h3 className="cert-card-title">{cert.domain}</h3>
                    <div className="cert-card-issuer">Issuer: {cert.issuer}</div>
                  </div>
                  <span className="status-badge" style={{
                    background: isExpired ? 'var(--accent-red)' : isExpiringSoon ? 'var(--accent-yellow)' : 'var(--accent-green)',
                    color: 'white'
                  }}>
                    {isExpired ? 'EXPIRED' : isExpiringSoon ? 'EXPIRING SOON' : 'ACTIVE'}
                  </span>
                </div>

                <div className="cert-card-details">
                  <div className="cert-card-detail">
                    <div className="cert-card-detail-label">Issued</div>
                    <div className="cert-card-detail-value">{formatDate(cert.notBefore)}</div>
                  </div>
                  <div className="cert-card-detail">
                    <div className="cert-card-detail-label">Expires</div>
                    <div className="cert-card-detail-value">
                      {formatDate(cert.notAfter)}
                      {daysLeft !== null && (
                        <span style={{ 
                          marginLeft: '0.5rem', 
                          color: isExpired ? 'var(--accent-red)' : isExpiringSoon ? 'var(--accent-yellow)' : 'var(--accent-green)' 
                        }}>
                          ({daysLeft > 0 ? `${daysLeft} days left` : `${Math.abs(daysLeft)} days ago`})
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="cert-card-detail">
                    <div className="cert-card-detail-label">Certificate Hash</div>
                    <div className="cert-card-detail-value" style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>
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

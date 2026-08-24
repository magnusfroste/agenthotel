import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { authFetch } from '../lib/auth'
import RuntimeMark from './RuntimeMark'
import {
  ArrowLeft, ArrowRight, Package, Server, ExternalLink, Check, Sparkles, Info, AlertCircle
} from 'lucide-react'

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: '2rem' }}>
      <h2 style={{ fontSize: '1rem', margin: '0 0 0.75rem 0' }}>{title}</h2>
      {children}
    </div>
  )
}

// benefits/features share the same {title, description} shape in meta.yaml.
function ItemGrid({ items, icon: Icon, color }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '0.75rem' }}>
      {items.map((item, i) => (
        <div key={i} style={{
          background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          borderRadius: '0.6rem', padding: '1rem'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
            <Icon size={15} color={color} />
            <strong style={{ fontSize: '0.9rem' }}>{item.title}</strong>
          </div>
          <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            {item.description}
          </p>
        </div>
      ))}
    </div>
  )
}

function TemplateDetail() {
  const { id } = useParams()
  const [template, setTemplate] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const navigate = useNavigate()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    authFetch(`/api/templates/${id}`)
      .then(async res => {
        if (!res.ok) throw new Error(res.status === 404 ? 'Template not found' : `Request failed (${res.status})`)
        return res.json()
      })
      .then(data => { if (!cancelled) setTemplate(data) })
      .catch(err => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [id])

  if (loading) {
    return (
      <div>
        <div style={{ width: '120px', height: '18px', background: 'var(--bg-secondary)', borderRadius: '0.25rem', marginBottom: '1.5rem', animation: 'pulse 1.5s ease-in-out infinite' }} />
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '2rem' }}>
          <div style={{ width: '64px', height: '64px', borderRadius: '0.6rem', background: 'var(--bg-secondary)', animation: 'pulse 1.5s ease-in-out infinite' }} />
          <div style={{ flex: 1 }}>
            <div style={{ width: '40%', height: '28px', background: 'var(--bg-secondary)', borderRadius: '0.25rem', marginBottom: '0.75rem', animation: 'pulse 1.5s ease-in-out infinite' }} />
            <div style={{ width: '80%', height: '14px', background: 'var(--bg-secondary)', borderRadius: '0.25rem', animation: 'pulse 1.5s ease-in-out infinite' }} />
          </div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="empty-state">
        <AlertCircle size={40} color="var(--text-secondary)" style={{ margin: '0 auto 1rem' }} />
        <h2>{error}</h2>
        <p>The template <code>{id}</code> is not available.</p>
        <Link to="/templates" className="btn btn-secondary">Back to Templates</Link>
      </div>
    )
  }


  return (
    <div>
      <Link
        to="/templates"
        style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-secondary)', textDecoration: 'none', fontSize: '0.875rem', marginBottom: '1.25rem' }}
      >
        <ArrowLeft size={15} /> Templates
      </Link>

      {/* Header */}
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        <RuntimeMark meta={template} size={64} iconSize={32} />
        <div style={{ flex: 1, minWidth: '240px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', marginBottom: '0.4rem' }}>
            <h1 style={{ margin: 0 }}>{template.name}</h1>
            <span className="template-card-category">{template.category}</span>
          </div>
          <p style={{ margin: 0, color: 'var(--text-secondary)', lineHeight: 1.6, whiteSpace: 'pre-line' }}>
            {template.description}
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => navigate(`/create?runtime=${template.id}`)}>
          Deploy <ArrowRight size={16} color="white" />
        </button>
      </div>

      {/* Tags */}
      {(template.tags || []).length > 0 && (
        <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
          {template.tags.map(t => (
            <span key={t} style={{
              padding: '0.2rem 0.6rem', borderRadius: '999px',
              background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', fontSize: '0.75rem'
            }}>{t}</span>
          ))}
        </div>
      )}

      {/* At a glance */}
      <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', padding: '0.9rem 1rem', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: '0.6rem', marginBottom: '2rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
        {template.defaultImage && (
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
            <Package size={15} /> <code>{template.defaultImage}</code>
          </span>
        )}
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
          <Server size={15} /> Port {template.defaultPort}
        </span>
      </div>

      {template.instructions && (
        <Section title="After deployment">
          <div style={{
            background: 'var(--bg-secondary)', border: '1px solid var(--border)',
            borderRadius: '0.6rem', padding: '1rem', display: 'flex', gap: '0.75rem'
          }}>
            <Info size={16} color="var(--accent-blue)" style={{ flexShrink: 0, marginTop: '0.15rem' }} />
            <p style={{ margin: 0, fontSize: '0.875rem', lineHeight: 1.6, whiteSpace: 'pre-line' }}>
              {template.instructions}
            </p>
          </div>
        </Section>
      )}

      {(template.benefits || []).length > 0 && (
        <Section title="Benefits">
          <ItemGrid items={template.benefits} icon={Check} color="var(--accent-green, #10b981)" />
        </Section>
      )}

      {(template.features || []).length > 0 && (
        <Section title="Features">
          <ItemGrid items={template.features} icon={Sparkles} color={template.color} />
        </Section>
      )}

      {(template.configFields || []).length > 0 && (
        <Section title="Configuration">
          <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            These fields are filled in on the deploy form. Secrets left blank are auto-injected from your configured providers where possible.
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text-secondary)' }}>
                  <th style={{ padding: '0.5rem 0.75rem 0.5rem 0', fontWeight: 600 }}>Field</th>
                  <th style={{ padding: '0.5rem 0.75rem', fontWeight: 600 }}>Key</th>
                  <th style={{ padding: '0.5rem 0.75rem', fontWeight: 600 }}>Type</th>
                  <th style={{ padding: '0.5rem 0.75rem', fontWeight: 600 }}>Default</th>
                </tr>
              </thead>
              <tbody>
                {template.configFields.map(f => (
                  <tr key={f.key} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '0.55rem 0.75rem 0.55rem 0' }}>
                      {f.label}
                      {f.required && <span style={{ color: 'var(--accent-red, #ef4444)', marginLeft: '0.3rem' }}>*</span>}
                    </td>
                    <td style={{ padding: '0.55rem 0.75rem' }}><code>{f.key}</code></td>
                    <td style={{ padding: '0.55rem 0.75rem', color: 'var(--text-secondary)' }}>{f.type}</td>
                    <td style={{ padding: '0.55rem 0.75rem', color: 'var(--text-secondary)' }}>
                      {f.default !== undefined && f.default !== '' ? <code>{String(f.default)}</code> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {(template.links || []).length > 0 && (
        <Section title="Links">
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {template.links.map((l, i) => (
              <a
                key={i}
                href={l.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                  padding: '0.45rem 0.8rem', borderRadius: '0.5rem',
                  border: '1px solid var(--border)', background: 'var(--bg-secondary)',
                  color: 'var(--text-primary)', textDecoration: 'none', fontSize: '0.85rem'
                }}
              >
                {l.label} <ExternalLink size={13} />
              </a>
            ))}
          </div>
        </Section>
      )}

      {(template.changeLog || []).length > 0 && (
        <Section title="Changelog">
          <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.8 }}>
            {template.changeLog.map((c, i) => (
              <li key={i}><code>{c.date}</code> — {c.description}</li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  )
}

export default TemplateDetail

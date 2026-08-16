import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { authFetch } from '../lib/auth'
import { templateIcon } from '../lib/templateIcons'
import { Package, Server, Database, ArrowRight, Info, Search, X } from 'lucide-react'

function Templates() {
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [category, setCategory] = useState('all')
  const [tag, setTag] = useState(null)
  const [query, setQuery] = useState('')
  const navigate = useNavigate()

  useEffect(() => {
    fetchTemplates()
  }, [])

  async function fetchTemplates() {
    try {
      const res = await authFetch('/api/templates')
      const data = await res.json()
      setTemplates(Array.isArray(data) ? data : [])
    } catch (err) {
      console.error('Failed to fetch templates:', err)
    } finally {
      setLoading(false)
    }
  }

  // Categories and tags come from the templates themselves, so adding a
  // meta.yaml is enough to make a new filter appear.
  const categories = useMemo(
    () => ['all', ...Array.from(new Set(templates.map(t => t.category))).sort()],
    [templates]
  )
  const tags = useMemo(
    () => Array.from(new Set(templates.flatMap(t => t.tags || []))).sort(),
    [templates]
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return templates.filter(t => {
      if (category !== 'all' && t.category !== category) return false
      if (tag && !(t.tags || []).includes(tag)) return false
      if (!q) return true
      const haystack = [t.name, t.description, t.defaultImage, ...(t.tags || [])]
        .filter(Boolean).join(' ').toLowerCase()
      return haystack.includes(q)
    })
  }, [templates, category, tag, query])

  const hasFilters = category !== 'all' || tag || query.trim()

  function clearFilters() {
    setCategory('all')
    setTag(null)
    setQuery('')
  }

  if (loading) {
    return (
      <div>
        <div style={{ marginBottom: '2rem' }}>
          <div style={{ width: '180px', height: '32px', background: 'var(--bg-secondary)', borderRadius: '0.5rem', animation: 'pulse 1.5s ease-in-out infinite' }} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1rem' }}>
          {[...Array(5)].map((_, i) => (
            <div key={i} style={{ background: 'var(--bg-secondary)', borderRadius: '0.6rem', padding: '1.5rem', animation: 'pulse 1.5s ease-in-out infinite' }}>
              <div style={{ width: '48px', height: '48px', borderRadius: '0.5rem', background: 'var(--bg-tertiary)', marginBottom: '1rem' }} />
              <div style={{ width: '60%', height: '20px', background: 'var(--bg-tertiary)', borderRadius: '0.25rem', marginBottom: '0.5rem' }} />
              <div style={{ width: '100%', height: '14px', background: 'var(--bg-tertiary)', borderRadius: '0.25rem', marginBottom: '1rem' }} />
              <div style={{ width: '80%', height: '14px', background: 'var(--bg-tertiary)', borderRadius: '0.25rem' }} />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ margin: '0 0 0.5rem 0' }}>Templates</h1>
        <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
          Pick a template to check a new guest in. Each one is pre-configured with sensible defaults.
        </p>
      </div>

      {/* Search */}
      <div style={{ position: 'relative', marginBottom: '1rem', maxWidth: '420px' }}>
        <Search size={16} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)', pointerEvents: 'none' }} />
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search templates…"
          style={{ width: '100%', padding: '0.55rem 0.75rem 0.55rem 2.25rem' }}
        />
      </div>

      {/* Category filter */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        {categories.map(cat => (
          <button
            key={cat}
            onClick={() => setCategory(cat)}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '0.5rem',
              border: category === cat ? '1px solid #3b82f6' : '1px solid var(--border)',
              background: category === cat ? 'rgba(59,130,246,0.1)' : 'var(--bg-secondary)',
              color: category === cat ? '#3b82f6' : 'var(--text-primary)',
              cursor: 'pointer',
              fontSize: '0.875rem',
              fontWeight: category === cat ? '600' : '400',
              transition: 'all 0.15s'
            }}
          >
            {cat === 'all' ? 'All Templates' : cat}
          </button>
        ))}
      </div>

      {/* Tag filter */}
      {tags.length > 0 && (
        <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '1.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
          {tags.map(t => (
            <button
              key={t}
              onClick={() => setTag(tag === t ? null : t)}
              style={{
                padding: '0.25rem 0.65rem',
                borderRadius: '999px',
                border: '1px solid ' + (tag === t ? '#3b82f6' : 'var(--border)'),
                background: tag === t ? 'rgba(59,130,246,0.12)' : 'transparent',
                color: tag === t ? '#3b82f6' : 'var(--text-secondary)',
                cursor: 'pointer',
                fontSize: '0.75rem',
                transition: 'all 0.15s'
              }}
            >
              {t}
            </button>
          ))}
          {hasFilters && (
            <button
              onClick={clearFilters}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.25rem',
                padding: '0.25rem 0.65rem', borderRadius: '999px',
                border: '1px solid var(--border)', background: 'transparent',
                color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.75rem'
              }}
            >
              <X size={12} /> Clear
            </button>
          )}
        </div>
      )}

      {/* Grid */}
      {filtered.length === 0 ? (
        <div className="empty-state">
          <Info size={40} color="var(--text-secondary)" style={{ margin: '0 auto 1rem' }} />
          <h2>No templates match</h2>
          <p>Try a different search or clear the filters.</p>
          {hasFilters && (
            <button className="btn btn-secondary" onClick={clearFilters}>Clear filters</button>
          )}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1rem' }}>
          {filtered.map(tpl => {
            const Icon = templateIcon(tpl.icon)
            return (
              <div
                key={tpl.id}
                className="template-card"
                onClick={() => navigate(`/templates/${tpl.id}`)}
              >
                <div className="template-card-header">
                  <div className="template-card-icon" style={{ background: tpl.color }}>
                    <Icon size={24} color="white" />
                  </div>
                  <span className="template-card-category">{tpl.category}</span>
                </div>

                <h3 className="template-card-title">{tpl.name}</h3>
                <p className="template-card-description">{tpl.description}</p>

                {(tpl.tags || []).length > 0 && (
                  <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
                    {tpl.tags.slice(0, 4).map(t => (
                      <span key={t} style={{
                        padding: '0.15rem 0.5rem', borderRadius: '999px',
                        background: 'var(--bg-tertiary)', color: 'var(--text-secondary)',
                        fontSize: '0.7rem'
                      }}>{t}</span>
                    ))}
                  </div>
                )}

                <div className="template-card-meta">
                  {tpl.defaultImage && (
                    <div className="template-card-meta-item">
                      <Package size={14} color="currentColor" />
                      <span style={{ fontFamily: 'monospace' }}>{tpl.defaultImage}</span>
                    </div>
                  )}
                  <div className="template-card-meta-item">
                    <Server size={14} color="currentColor" />
                    <span>Port: {tpl.defaultPort}</span>
                  </div>
                  {tpl.configFieldCount > 0 && (
                    <div className="template-card-meta-item">
                      <Database size={14} color="currentColor" />
                      <span>{tpl.configFieldCount} config fields</span>
                    </div>
                  )}
                </div>

                <button
                  className="btn btn-primary"
                  onClick={(e) => {
                    e.stopPropagation()
                    navigate(`/create?runtime=${tpl.id}`)
                  }}
                >
                  Deploy <ArrowRight size={16} color="white" />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default Templates

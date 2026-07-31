import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { authFetch } from '../lib/auth'
import { Bot, PawPrint, Layers, Container, Zap, Package, Server, Database, ArrowRight, Info } from 'lucide-react'

const RUNTIME_ICONS = {
  hermes: Zap,
  openclaw: PawPrint,
  odysseus: Bot,
  'docker-app': Container,
  compose: Layers
}

const RUNTIME_CATEGORIES = {
  hermes: 'AI Agent',
  openclaw: 'AI Agent',
  odysseus: 'AI Agent',
  'docker-app': 'Docker App',
  compose: 'Docker Compose'
}

const RUNTIME_COLORS = {
  hermes: '#3b82f6',
  openclaw: '#10b981',
  odysseus: '#8b5cf6',
  'docker-app': '#f59e0b',
  compose: '#ec4899'
}

function Templates() {
  const [runtimes, setRuntimes] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedCategory, setSelectedCategory] = useState('all')
  const navigate = useNavigate()

  useEffect(() => {
    fetchRuntimes()
  }, [])

  async function fetchRuntimes() {
    try {
      const res = await authFetch('/api/runtimes')
      const data = await res.json()
      setRuntimes(data)
    } catch (err) {
      console.error('Failed to fetch runtimes:', err)
    } finally {
      setLoading(false)
    }
  }

  const categories = ['all', 'AI Agent', 'Docker App', 'Docker Compose']
  const filteredRuntimes = selectedCategory === 'all' 
    ? runtimes 
    : runtimes.filter(rt => RUNTIME_CATEGORIES[rt.id] === selectedCategory)

  if (loading) {
    return (
      <div>
        <div style={{ marginBottom: '2rem' }}>
          <div style={{ width: '180px', height: '32px', background: 'var(--bg-secondary)', borderRadius: '0.5rem', animation: 'pulse 1.5s ease-in-out infinite' }} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '1rem' }}>
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
      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ margin: '0 0 0.5rem 0' }}>Templates</h1>
        <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
          Choose a template to deploy. Each template is pre-configured with sensible defaults.
        </p>
      </div>

      {/* Category Filter */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        {categories.map(cat => (
          <button
            key={cat}
            onClick={() => setSelectedCategory(cat)}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '0.5rem',
              border: selectedCategory === cat ? '1px solid #3b82f6' : '1px solid var(--border)',
              background: selectedCategory === cat ? 'rgba(59,130,246,0.1)' : 'var(--bg-secondary)',
              color: selectedCategory === cat ? '#3b82f6' : 'var(--text-primary)',
              cursor: 'pointer',
              fontSize: '0.875rem',
              fontWeight: selectedCategory === cat ? '600' : '400',
              transition: 'all 0.15s'
            }}
          >
            {cat === 'all' ? 'All Templates' : cat}
          </button>
        ))}
      </div>

      {/* Templates Grid */}
      {filteredRuntimes.length === 0 ? (
        <div className="empty-state">
          <Info size={40} color="var(--text-secondary)" style={{ margin: '0 auto 1rem' }} />
          <h2>No templates in this category</h2>
          <p>Try selecting a different category.</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1rem' }}>
          {filteredRuntimes.map(rt => {
            const Icon = RUNTIME_ICONS[rt.id] || Container
            const category = RUNTIME_CATEGORIES[rt.id]
            const color = RUNTIME_COLORS[rt.id] || '#3b82f6'
            
            return (
              <div 
                key={rt.id} 
                className="template-card"
                onClick={() => navigate(`/create?runtime=${rt.id}`)}
              >
                <div className="template-card-header">
                  <div className="template-card-icon" style={{ background: color }}>
                    <Icon size={24} color="white" />
                  </div>
                  <span className="template-card-category">
                    {category}
                  </span>
                </div>

                <h3 className="template-card-title">{rt.name}</h3>
                <p className="template-card-description">
                  {rt.description}
                </p>

                <div className="template-card-meta">
                  {rt.defaultImage && (
                    <div className="template-card-meta-item">
                      <Package size={14} color="currentColor" />
                      <span style={{ fontFamily: 'monospace' }}>{rt.defaultImage}</span>
                    </div>
                  )}
                  <div className="template-card-meta-item">
                    <Server size={14} color="currentColor" />
                    <span>Port: {rt.defaultPort}</span>
                  </div>
                  {rt.configFields && rt.configFields.length > 0 && (
                    <div className="template-card-meta-item">
                      <Database size={14} color="currentColor" />
                      <span>{rt.configFields.length} config fields</span>
                    </div>
                  )}
                </div>

                <button 
                  className="btn btn-primary"
                  onClick={(e) => {
                    e.stopPropagation()
                    navigate(`/create?runtime=${rt.id}`)
                  }}
                >
                  Deploy <ArrowRight size={16} color="white" />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* Info Box */}
      <div style={{
        marginTop: '2rem',
        padding: '1rem',
        background: 'var(--bg-secondary)',
        borderRadius: '0.5rem',
        fontSize: '0.85rem',
        color: 'var(--text-secondary)'
      }}>
        <strong>About Templates:</strong>
        <p style={{ margin: '0.5rem 0 0 0' }}>
          Templates are pre-configured runtime environments. AI Agent templates (Hermes, OpenClaw, Odysseus) 
          come with built-in support for multiple LLM providers. Generic App and Compose templates allow 
          you to deploy any Docker image or multi-container application.
        </p>
      </div>
    </div>
  )
}

export default Templates

import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { authFetch } from '../lib/auth'
import { FileText, Plus, Trash2, Upload, Eye, AlertCircle, CheckCircle } from 'lucide-react'

function Compose() {
  const navigate = useNavigate()
  const [formData, setFormData] = useState({
    name: '',
    domain: '',
    composeYaml: '',
    envVars: [],
    projectName: ''
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showPreview, setShowPreview] = useState(false)
  const [bulkEnvInput, setBulkEnvInput] = useState('')
  const [showBulkImport, setShowBulkImport] = useState(false)

  // Example docker-compose.yml
  const exampleCompose = `version: '3.8'
services:
  web:
    image: nginx:alpine
    ports:
      - "80:80"
    environment:
      - NGINX_HOST=\${NGINX_HOST}
      - NGINX_PORT=\${NGINX_PORT}
    volumes:
      - ./html:/usr/share/nginx/html
  
  api:
    image: node:18-alpine
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=\${NODE_ENV}
      - DATABASE_URL=\${DATABASE_URL}
    depends_on:
      - db
  
  db:
    image: postgres:15
    environment:
      - POSTGRES_DB=\${POSTGRES_DB}
      - POSTGRES_USER=\${POSTGRES_USER}
      - POSTGRES_PASSWORD=\${POSTGRES_PASSWORD}
    volumes:
      - db-data:/var/lib/postgresql/data

volumes:
  db-data:
`

  function handleYamlChange(e) {
    setFormData({ ...formData, composeYaml: e.target.value })
  }

  function addEnvVar() {
    setFormData({
      ...formData,
      envVars: [...formData.envVars, { key: '', value: '' }]
    })
  }

  function removeEnvVar(index) {
    setFormData({
      ...formData,
      envVars: formData.envVars.filter((_, i) => i !== index)
    })
  }

  function updateEnvVar(index, field, value) {
    const updated = [...formData.envVars]
    updated[index][field] = value
    setFormData({ ...formData, envVars: updated })
  }

  function handleBulkImport() {
    const lines = bulkEnvInput.split('\n').filter(line => line.trim())
    const newVars = lines.map(line => {
      const [key, ...valueParts] = line.split('=')
      return {
        key: key?.trim() || '',
        value: valueParts.join('=').trim()
      }
    }).filter(v => v.key)
    
    setFormData({
      ...formData,
      envVars: [...formData.envVars, ...newVars]
    })
    setBulkEnvInput('')
    setShowBulkImport(false)
  }

  function loadExample() {
    setFormData({
      ...formData,
      composeYaml: exampleCompose,
      envVars: [
        { key: 'NGINX_HOST', value: 'localhost' },
        { key: 'NGINX_PORT', value: '80' },
        { key: 'NODE_ENV', value: 'production' },
        { key: 'DATABASE_URL', value: 'postgresql://user:pass@db:5432/mydb' },
        { key: 'POSTGRES_DB', value: 'mydb' },
        { key: 'POSTGRES_USER', value: 'user' },
        { key: 'POSTGRES_PASSWORD', value: 'pass' }
      ]
    })
  }

  function generateEnvString() {
    return formData.envVars
      .filter(v => v.key)
      .map(v => `${v.key}=${v.value}`)
      .join('\n')
  }

  function validateYaml() {
    try {
      // Basic YAML validation - check for common errors
      if (!formData.composeYaml.trim()) {
        return { valid: false, error: 'YAML is empty' }
      }
      
      // Check for required fields
      if (!formData.composeYaml.includes('services:')) {
        return { valid: false, error: 'YAML must include "services:"' }
      }
      
      return { valid: true }
    } catch (err) {
      return { valid: false, error: err.message }
    }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const validation = validateYaml()
    if (!validation.valid) {
      setError(validation.error)
      setLoading(false)
      return
    }

    try {
      const payload = {
        name: formData.name,
        runtime: 'compose',
        domain: formData.domain || undefined,
        config: {
          COMPOSE_FILE: formData.composeYaml,
          COMPOSE_ENV: generateEnvString(),
          COMPOSE_PROJECT: formData.projectName || formData.name
        }
      }

      const res = await authFetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Failed to deploy compose')
      }

      navigate('/')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const validation = validateYaml()

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Docker Compose</h1>
        <button onClick={loadExample} className="btn btn-secondary">
          <FileText size={18} />
          Load Example
        </button>
      </div>

      {error && (
        <div className="alert alert-error">
          <AlertCircle size={20} />
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div className="settings-section">
          <h2>Basic Information</h2>
          
          <div className="form-group">
            <label className="form-label">Project Name *</label>
            <input
              type="text"
              className="form-input"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="my-app"
              required
            />
            <div className="form-help">Unique name for this compose project</div>
          </div>

          <div className="form-group">
            <label className="form-label">Domain (optional)</label>
            <input
              type="text"
              className="form-input"
              value={formData.domain}
              onChange={(e) => setFormData({ ...formData, domain: e.target.value })}
              placeholder="app.example.com"
            />
          </div>

          <div className="form-group">
            <label className="form-label">Compose Project Name (optional)</label>
            <input
              type="text"
              className="form-input"
              value={formData.projectName}
              onChange={(e) => setFormData({ ...formData, projectName: e.target.value })}
              placeholder="Leave empty to use project name"
            />
          </div>
        </div>

        <div className="settings-section">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <FileText size={20} />
            Docker Compose YAML
            {validation.valid ? (
              <CheckCircle size={18} color="#10b981" style={{ marginLeft: 'auto' }} />
            ) : formData.composeYaml && (
              <AlertCircle size={18} color="#ef4444" style={{ marginLeft: 'auto' }} />
            )}
          </h2>
          
          <div className="form-group">
            <textarea
              className="form-textarea"
              value={formData.composeYaml}
              onChange={handleYamlChange}
              placeholder="Paste your docker-compose.yml here..."
              rows={20}
              style={{ fontFamily: 'monospace', fontSize: '0.875rem' }}
              required
            />
            {!validation.valid && formData.composeYaml && (
              <div className="form-help" style={{ color: '#ef4444' }}>
                {validation.error}
              </div>
            )}
          </div>
        </div>

        <div className="settings-section">
          <h2 style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Environment Variables</span>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                type="button"
                onClick={() => setShowBulkImport(!showBulkImport)}
                className="btn btn-secondary"
                style={{ padding: '0.5rem 1rem', fontSize: '0.875rem' }}
              >
                <Upload size={16} />
                Bulk Import
              </button>
              <button
                type="button"
                onClick={addEnvVar}
                className="btn btn-primary"
                style={{ padding: '0.5rem 1rem', fontSize: '0.875rem' }}
              >
                <Plus size={16} />
                Add Variable
              </button>
            </div>
          </h2>

          {showBulkImport && (
            <div style={{ marginBottom: '1.5rem' }}>
              <div className="form-group">
                <label className="form-label">Paste environment variables (KEY=VALUE, one per line)</label>
                <textarea
                  className="form-textarea"
                  value={bulkEnvInput}
                  onChange={(e) => setBulkEnvInput(e.target.value)}
                  placeholder={`DATABASE_URL=postgresql://user:pass@localhost:5432/db\nAPI_KEY=sk-...\nNODE_ENV=production`}
                  rows={8}
                  style={{ fontFamily: 'monospace', fontSize: '0.875rem' }}
                />
              </div>
              <button
                type="button"
                onClick={handleBulkImport}
                className="btn btn-primary"
              >
                Import Variables
              </button>
            </div>
          )}

          {formData.envVars.length === 0 ? (
            <div style={{ 
              textAlign: 'center', 
              padding: '2rem', 
              color: 'var(--text-secondary)',
              background: 'var(--bg-primary)',
              borderRadius: '0.5rem'
            }}>
              No environment variables added yet
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {formData.envVars.map((envVar, index) => (
                <div key={index} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <input
                    type="text"
                    className="form-input"
                    value={envVar.key}
                    onChange={(e) => updateEnvVar(index, 'key', e.target.value)}
                    placeholder="KEY"
                    style={{ flex: 1, fontFamily: 'monospace' }}
                  />
                  <input
                    type="text"
                    className="form-input"
                    value={envVar.value}
                    onChange={(e) => updateEnvVar(index, 'value', e.target.value)}
                    placeholder="VALUE"
                    style={{ flex: 2, fontFamily: 'monospace' }}
                  />
                  <button
                    type="button"
                    onClick={() => removeEnvVar(index)}
                    className="btn btn-danger"
                    style={{ padding: '0.5rem', minWidth: 'auto' }}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {formData.composeYaml && (
          <div className="settings-section">
            <h2 style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Eye size={20} />
                Preview
              </span>
              <button
                type="button"
                onClick={() => setShowPreview(!showPreview)}
                className="btn btn-secondary"
                style={{ padding: '0.5rem 1rem', fontSize: '0.875rem' }}
              >
                {showPreview ? 'Hide' : 'Show'} Preview
              </button>
            </h2>

            {showPreview && (
              <div>
                <div style={{ marginBottom: '1rem' }}>
                  <h3 style={{ fontSize: '0.875rem', marginBottom: '0.5rem' }}>Generated .env file:</h3>
                  <pre style={{
                    background: 'var(--bg-primary)',
                    padding: '1rem',
                    borderRadius: '0.5rem',
                    fontSize: '0.75rem',
                    fontFamily: 'monospace',
                    maxHeight: '200px',
                    overflow: 'auto'
                  }}>
                    {generateEnvString() || '(empty)'}
                  </pre>
                </div>

                <div>
                  <h3 style={{ fontSize: '0.875rem', marginBottom: '0.5rem' }}>
                    Environment variables: {formData.envVars.filter(v => v.key).length}
                  </h3>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={loading || !validation.valid}>
            {loading ? 'Deploying...' : 'Deploy Compose'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/')}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}

export default Compose

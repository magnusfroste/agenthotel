import { useState, useEffect } from 'react'
import { authFetch } from '../lib/auth'
import { Settings as SettingsIcon, Lock, Globe, Clock, Server, Shield, Save, RotateCcw, CheckCircle, AlertCircle, Database, Download, Upload } from 'lucide-react'

function Settings() {
  const [settings, setSettings] = useState({})
  const [originalSettings, setOriginalSettings] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState({ type: '', text: '' })

  useEffect(() => {
    fetchSettings()
  }, [])

  async function fetchSettings() {
    try {
      const res = await authFetch('/api/settings')
      const data = await res.json()
      setSettings(data)
      setOriginalSettings(data)
    } catch (err) {
      console.error('Failed to fetch settings:', err)
      showMessage('error', 'Failed to load settings')
    } finally {
      setLoading(false)
    }
  }

  function showMessage(type, text) {
    setMessage({ type, text })
    setTimeout(() => setMessage({ type: '', text: '' }), 4000)
  }

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    setMessage({ type: '', text: '' })

    try {
      const res = await authFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      })

      if (!res.ok) throw new Error('Failed to save settings')
      
      setOriginalSettings(settings)
      showMessage('success', 'Settings saved successfully!')
    } catch (err) {
      showMessage('error', 'Error: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  function handleReset() {
    setSettings(originalSettings)
    showMessage('success', 'Settings reset to last saved state')
  }

  function handleChange(e) {
    const { name, value, type, checked } = e.target
    const newValue = type === 'checkbox' ? (checked ? 'true' : 'false') : value
    setSettings(prev => ({ ...prev, [name]: newValue }))
  }

  function hasChanges() {
    return JSON.stringify(settings) !== JSON.stringify(originalSettings)
  }

  const [importing, setImporting] = useState(false)

  async function handleExport() {    try {
      const res = await authFetch('/api/system/export')
      if (!res.ok) throw new Error('Export failed')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `agentpanel-export-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      showMessage('success', 'Export downloaded — store it safely, it contains API keys')
    } catch (err) {
      showMessage('error', 'Export failed: ' + err.message)
    }
  }

  async function handleImport(e) {
    const file = e.target.files && e.target.files[0]
    if (!file) return
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      if (!confirm(`Import ${data.agents?.length || 0} agents and ${data.providers?.length || 0} providers from "${file.name}"? Existing entries are kept.`)) return
      setImporting(true)
      const res = await authFetch('/api/system/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: text
      })
      const result = await res.json()
      if (!res.ok) throw new Error(result.error || 'Import failed')
      showMessage('success', `Import done: ${result.agents.imported} agents added (${result.agents.skipped} skipped), ${result.providers.imported} providers added, ${result.providers.updated} updated`)
    } catch (err) {
      showMessage('error', 'Import failed: ' + err.message)
    } finally {
      setImporting(false)
      e.target.value = ''
    }
  }

  if (loading) {
    return (
      <div style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center', 
        minHeight: '400px',
        color: 'var(--text-secondary, #94a3b8)'
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ 
            width: '40px', 
            height: '40px', 
            border: '3px solid var(--border, #334155)',
            borderTopColor: '#3b82f6',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
            margin: '0 auto 1rem'
          }} />
          <div>Loading settings...</div>
        </div>
      </div>
    )
  }

  const inputStyle = {
    width: '100%',
    padding: '0.75rem',
    background: 'var(--bg-primary, #0f172a)',
    border: '1px solid var(--border, #334155)',
    borderRadius: '0.5rem',
    color: 'var(--text-primary, #e2e8f0)',
    fontSize: '0.9rem',
    transition: 'border-color 0.2s'
  }

  const labelStyle = {
    display: 'block',
    marginBottom: '0.5rem',
    color: 'var(--text-primary, #e2e8f0)',
    fontWeight: '500',
    fontSize: '0.9rem'
  }

  const helpTextStyle = {
    fontSize: '0.75rem',
    color: 'var(--text-secondary, #94a3b8)',
    marginTop: '0.25rem'
  }

  const sectionStyle = {
    background: 'var(--bg-secondary, #1e293b)',
    borderRadius: '0.75rem',
    padding: '2rem',
    marginBottom: '2rem',
    border: '1px solid var(--border, #334155)'
  }

  const sectionHeaderStyle = {
    margin: '0 0 1.5rem 0',
    fontSize: '1.25rem',
    fontWeight: '600',
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    color: 'var(--text-primary, #e2e8f0)'
  }

  const formGroupStyle = {
    marginBottom: '1.5rem'
  }

  return (
    <div>
      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ margin: '0 0 0.5rem 0', fontSize: '2rem', fontWeight: '700' }}>Settings</h1>
        <p style={{ margin: 0, color: 'var(--text-secondary, #94a3b8)', fontSize: '0.9rem' }}>
          Configure your AgentPanel instance
        </p>
      </div>

      {message.text && (
        <div style={{
          padding: '1rem 1.25rem',
          marginBottom: '1.5rem',
          background: message.type === 'error' ? 'rgba(239, 68, 68, 0.1)' : 'rgba(16, 185, 129, 0.1)',
          border: `1px solid ${message.type === 'error' ? '#ef4444' : '#10b981'}`,
          borderRadius: '0.5rem',
          color: message.type === 'error' ? '#ef4444' : '#10b981',
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          fontSize: '0.9rem'
        }}>
          {message.type === 'error' ? <AlertCircle size={18} /> : <CheckCircle size={18} />}
          {message.text}
        </div>
      )}

      <form onSubmit={handleSave}>
        <div style={sectionStyle}>
          <h2 style={sectionHeaderStyle}>
            <Globe size={22} color="#3b82f6" />
            General Settings
          </h2>

          <div style={formGroupStyle}>
            <label style={labelStyle}>Panel Domain</label>
            <input
              type="text"
              name="panel_domain"
              value={settings.panel_domain || ''}
              onChange={handleChange}
              placeholder="panel.example.com"
              style={inputStyle}
            />
            <div style={helpTextStyle}>The domain where AgentPanel is accessible</div>
          </div>

          <div style={formGroupStyle}>
            <label style={labelStyle}>Caddy Email (Let's Encrypt)</label>
            <input
              type="email"
              name="caddy_email"
              value={settings.caddy_email || ''}
              onChange={handleChange}
              placeholder="admin@example.com"
              style={inputStyle}
            />
            <div style={helpTextStyle}>Email for Let's Encrypt SSL certificates</div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '1.5rem' }}>
            <div style={formGroupStyle}>
              <label style={labelStyle}>Default Timeout (seconds)</label>
              <input
                type="number"
                name="default_timeout"
                value={settings.default_timeout || '30'}
                onChange={handleChange}
                style={inputStyle}
              />
            </div>

            <div style={formGroupStyle}>
              <label style={labelStyle}>Timezone</label>
              <input
                type="text"
                name="timezone"
                value={settings.timezone || 'Europe/Stockholm'}
                onChange={handleChange}
                style={inputStyle}
              />
            </div>
          </div>

          <div style={formGroupStyle}>
            <label style={labelStyle}>Theme</label>
            <select
              name="theme"
              value={settings.theme || 'dark'}
              onChange={handleChange}
              style={inputStyle}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>

          <div style={formGroupStyle}>
            <label style={labelStyle}>Language</label>
            <select
              name="language"
              value={settings.language || 'sv'}
              onChange={handleChange}
              style={inputStyle}
            >
              <option value="sv">Svenska</option>
              <option value="en">English</option>
            </select>
          </div>
        </div>

        <div style={sectionStyle}>
          <h2 style={sectionHeaderStyle}>
            <Server size={22} color="#10b981" />
            Docker Configuration
          </h2>

          <div style={formGroupStyle}>
            <label style={labelStyle}>Default Docker Network</label>
            <input
              type="text"
              name="default_network"
              value={settings.default_network || 'agentpanel_agentpanel'}
              onChange={handleChange}
              style={inputStyle}
            />
            <div style={helpTextStyle}>Docker network for agent containers</div>
          </div>

          <div style={formGroupStyle}>
            <label style={labelStyle}>Container Restart Policy</label>
            <select
              name="container_restart_policy"
              value={settings.container_restart_policy || 'unless-stopped'}
              onChange={handleChange}
              style={inputStyle}
            >
              <option value="unless-stopped">Unless Stopped</option>
              <option value="always">Always</option>
              <option value="on-failure">On Failure</option>
              <option value="no">No</option>
            </select>
            <div style={helpTextStyle}>When to restart containers automatically</div>
          </div>
        </div>

        <div style={sectionStyle}>
          <h2 style={sectionHeaderStyle}>
            <Shield size={22} color="#f59e0b" />
            Security
          </h2>

          <div style={formGroupStyle}>
            <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                name="rate_limit_enabled"
                checked={settings.rate_limit_enabled === 'true'}
                onChange={handleChange}
                style={{ width: 'auto', cursor: 'pointer' }}
              />
              Enable Rate Limiting
            </label>
            <div style={helpTextStyle}>Limit API requests per minute</div>
          </div>

          {settings.rate_limit_enabled === 'true' && (
            <div style={formGroupStyle}>
              <label style={labelStyle}>Rate Limit (requests/minute)</label>
              <input
                type="number"
                name="rate_limit_requests"
                value={settings.rate_limit_requests || '100'}
                onChange={handleChange}
                style={inputStyle}
              />
            </div>
          )}

          <div style={formGroupStyle}>
            <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                name="require_https"
                checked={settings.require_https === 'true'}
                onChange={handleChange}
                style={{ width: 'auto', cursor: 'pointer' }}
              />
              Require HTTPS
            </label>
            <div style={helpTextStyle}>Force HTTPS for all connections</div>
          </div>

          <div style={formGroupStyle}>
            <label style={labelStyle}>Session Timeout (minutes)</label>
            <input
              type="number"
              name="session_timeout"
              value={settings.session_timeout || '60'}
              onChange={handleChange}
              style={inputStyle}
            />
            <div style={helpTextStyle}>Auto-logout after inactivity</div>
          </div>
        </div>

        <div style={{ 
          display: 'flex', 
          gap: '1rem', 
          marginBottom: '2rem',
          padding: '1.5rem',
          background: 'var(--bg-secondary, #1e293b)',
          borderRadius: '0.75rem',
          border: '1px solid var(--border, #334155)'
        }}>
          <button 
            type="submit" 
            className="btn btn-primary" 
            disabled={saving || !hasChanges()}
            style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: '0.5rem',
              opacity: (!hasChanges() || saving) ? 0.6 : 1
            }}
          >
            <Save size={18} />
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
          
          <button 
            type="button"
            className="btn btn-secondary"
            onClick={handleReset}
            disabled={!hasChanges()}
            style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: '0.5rem',
              opacity: !hasChanges() ? 0.6 : 1
            }}
          >
            <RotateCcw size={18} />
            Reset
          </button>

          {hasChanges() && (
            <div style={{ 
              marginLeft: 'auto', 
              display: 'flex', 
              alignItems: 'center', 
              gap: '0.5rem',
              color: '#f59e0b',
              fontSize: '0.875rem'
            }}>
              <AlertCircle size={16} />
              Unsaved changes
            </div>
          )}
        </div>
      </form>

      <div style={sectionStyle}>
        <h2 style={sectionHeaderStyle}>
          <Database size={22} color="#8b5cf6" />
          Backup & Migration
        </h2>
        <p style={{ margin: '0 0 1.5rem 0', color: 'var(--text-secondary, #94a3b8)', fontSize: '0.9rem' }}>
          Move this instance to another VPS: export here, import on the new AgentPanel instance.
          Agents, providers (including API keys) and panel settings are included — admin credentials are never exported.
        </p>

        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleExport}
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
          >
            <Download size={18} />
            Export Instance
          </button>

          <label
            className="btn btn-secondary"
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: importing ? 'wait' : 'pointer', opacity: importing ? 0.6 : 1 }}
          >
            <Upload size={18} />
            {importing ? 'Importing...' : 'Import Instance'}
            <input
              type="file"
              accept="application/json,.json"
              onChange={handleImport}
              disabled={importing}
              style={{ display: 'none' }}
            />
          </label>
        </div>

        <div style={helpTextStyle}>
          The export file contains provider API keys in plain text — store it safely.
          Imported agents start as stopped; redeploy them from the dashboard. Existing agents are kept (matched on name/domain); existing providers are updated.
        </div>
      </div>
    </div>
  )
}

export default Settings

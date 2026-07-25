import { useState, useEffect } from 'react'
import { authFetch } from '../lib/auth'

function Settings() {
  const [settings, setSettings] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    fetchSettings()
  }, [])

  async function fetchSettings() {
    try {
      const res = await authFetch('/api/settings')
      const data = await res.json()
      setSettings(data)
    } catch (err) {
      console.error('Failed to fetch settings:', err)
    } finally {
      setLoading(false)
    }
  }

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    setMessage('')

    try {
      const res = await authFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      })

      if (!res.ok) throw new Error('Failed to save settings')
      setMessage('Settings saved successfully!')
      setTimeout(() => setMessage(''), 3000)
    } catch (err) {
      setMessage('Error: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  function handleChange(e) {
    const { name, value } = e.target
    setSettings(prev => ({ ...prev, [name]: value }))
  }

  if (loading) {
    return <div className="loading">Loading settings...</div>
  }

  return (
    <div>
      <h1 style={{ marginBottom: '2rem' }}>Settings</h1>

      {message && (
        <div style={{
          padding: '1rem',
          marginBottom: '1.5rem',
          background: message.startsWith('Error') ? 'rgba(239, 68, 68, 0.1)' : 'rgba(16, 185, 129, 0.1)',
          border: `1px solid ${message.startsWith('Error') ? '#ef4444' : '#10b981'}`,
          borderRadius: '0.5rem',
          color: message.startsWith('Error') ? '#ef4444' : '#10b981'
        }}>
          {message}
        </div>
      )}

      <form onSubmit={handleSave}>
        <div style={{
          background: 'var(--bg-secondary, #1e293b)',
          borderRadius: '0.5rem',
          padding: '1.5rem',
          marginBottom: '2rem'
        }}>
          <h2 style={{ margin: '0 0 1.5rem 0', fontSize: '1.25rem' }}>⚙️ General Settings</h2>

          <div className="form-group">
            <label>Panel Domain</label>
            <input
              type="text"
              name="panel_domain"
              value={settings.panel_domain || ''}
              onChange={handleChange}
              placeholder="panel.example.com"
            />
          </div>

          <div className="form-group">
            <label>Caddy Email (Let's Encrypt)</label>
            <input
              type="email"
              name="caddy_email"
              value={settings.caddy_email || ''}
              onChange={handleChange}
              placeholder="admin@example.com"
            />
          </div>

          <div className="form-group">
            <label>Default Timeout (seconds)</label>
            <input
              type="number"
              name="default_timeout"
              value={settings.default_timeout || '30'}
              onChange={handleChange}
            />
          </div>

          <div className="form-group">
            <label>Default Docker Network</label>
            <input
              type="text"
              name="default_network"
              value={settings.default_network || 'agentpanel_agentpanel'}
              onChange={handleChange}
            />
          </div>

          <div className="form-group">
            <label>Container Restart Policy</label>
            <select
              name="container_restart_policy"
              value={settings.container_restart_policy || 'unless-stopped'}
              onChange={handleChange}
            >
              <option value="unless-stopped">Unless Stopped</option>
              <option value="always">Always</option>
              <option value="on-failure">On Failure</option>
              <option value="no">No</option>
            </select>
          </div>

          <div className="form-group">
            <label>Theme</label>
            <select
              name="theme"
              value={settings.theme || 'dark'}
              onChange={handleChange}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>

          <div className="form-group">
            <label>Language</label>
            <select
              name="language"
              value={settings.language || 'sv'}
              onChange={handleChange}
            >
              <option value="sv">Svenska</option>
              <option value="en">English</option>
            </select>
          </div>

          <div className="form-group">
            <label>Timezone</label>
            <input
              type="text"
              name="timezone"
              value={settings.timezone || 'Europe/Stockholm'}
              onChange={handleChange}
            />
          </div>
        </div>

        <div style={{
          background: 'var(--bg-secondary, #1e293b)',
          borderRadius: '0.5rem',
          padding: '1.5rem',
          marginBottom: '2rem'
        }}>
          <h2 style={{ margin: '0 0 1.5rem 0', fontSize: '1.25rem' }}>🔒 Security</h2>

          <div className="form-group">
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input
                type="checkbox"
                name="rate_limit_enabled"
                checked={settings.rate_limit_enabled === 'true'}
                onChange={(e) => setSettings(prev => ({ ...prev, rate_limit_enabled: e.target.checked ? 'true' : 'false' }))}
              />
              Enable Rate Limiting
            </label>
          </div>

          <div className="form-group">
            <label>Rate Limit (requests/minute)</label>
            <input
              type="number"
              name="rate_limit_requests"
              value={settings.rate_limit_requests || '100'}
              onChange={handleChange}
            />
          </div>

          <div className="form-group">
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input
                type="checkbox"
                name="require_https"
                checked={settings.require_https === 'true'}
                onChange={(e) => setSettings(prev => ({ ...prev, require_https: e.target.checked ? 'true' : 'false' }))}
              />
              Require HTTPS
            </label>
          </div>

          <div className="form-group">
            <label>Session Timeout (minutes)</label>
            <input
              type="number"
              name="session_timeout"
              value={settings.session_timeout || '60'}
              onChange={handleChange}
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: '1rem', marginBottom: '2rem' }}>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </form>
    </div>
  )
}

export default Settings

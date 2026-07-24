import { useState, useEffect } from 'react'
import { authFetch } from '../lib/auth'

function Settings() {
  const [settings, setSettings] = useState({})
  const [domain, setDomain] = useState('')
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
      setDomain(data.panel_domain || '')
    } catch (err) {
      console.error('Failed to fetch settings:', err)
      setMessage({ type: 'error', text: 'Failed to load settings' })
    } finally {
      setLoading(false)
    }
  }

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    setMessage({ type: '', text: '' })

    try {
      const res = await authFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ panel_domain: domain })
      })

      if (!res.ok) {
        throw new Error('Failed to save settings')
      }

      setMessage({ type: 'success', text: 'Settings saved successfully' })
    } catch (err) {
      setMessage({ type: 'error', text: err.message })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="loading">Loading settings...</div>
  }

  return (
    <div className="settings-container">
      <div className="dashboard-header">
        <h1>Settings</h1>
      </div>

      {message.text && (
        <div className={message.type}>{message.text}</div>
      )}

      <form onSubmit={handleSave}>
        <div className="settings-section">
          <h2>Panel Domain</h2>
          <p className="settings-info">
            Configure the domain for accessing this panel. Leave empty to access via IP address.
            After setting a domain, ensure DNS points to this server's IP address.
          </p>

          <div className="form-group">
            <label>Domain</label>
            <input
              type="text"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="panel.example.com"
            />
          </div>

          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        </div>
      </form>

      <div className="settings-section">
        <h2>Account Information</h2>
        <div className="agent-detail-info">
          <div className="info-item">
            <div className="info-label">Email</div>
            <div className="info-value">{settings.admin_email || 'Not set'}</div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default Settings

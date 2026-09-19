import { useState, useEffect } from 'react'
import { authFetch } from '../lib/auth'
import { Globe, Server, Shield, Save, RotateCcw, CheckCircle, AlertCircle, Database, Download, Upload, Bell, Send } from 'lucide-react'

// Each card saves only its own keys. One form for everything meant that a
// changed Telegram chat id re-sent the panel domain too — and the backend, seeing
// the domain key, rewrote the Caddy route and the ACME e-mail on every save,
// whatever had actually changed. Fields nobody reads were removed rather than
// kept as decoration: a switch connected to nothing is worse than no switch.
const SECTIONS = [
  {
    id: 'panel', title: 'Panel', icon: Globe, color: '#3b82f6',
    keys: ['panel_domain', 'caddy_email'],
  },
  {
    id: 'docker', title: 'Docker', icon: Server, color: '#10b981',
    keys: ['default_network'],
  },
  {
    id: 'security', title: 'Security', icon: Shield, color: '#f59e0b',
    keys: ['rate_limit_enabled', 'rate_limit_requests', 'session_timeout'],
  },
  {
    id: 'notifications', title: 'Notifications', icon: Bell, color: '#8b5cf6',
    keys: ['notify_webhook_url', 'notify_telegram_token', 'notify_telegram_chat_id', 'notify_disk_threshold', 'notify_mem_threshold'],
  },
]

function Settings() {
  const [settings, setSettings] = useState({})
  const [originalSettings, setOriginalSettings] = useState({})
  const [loading, setLoading] = useState(true)
  const [savingSection, setSavingSection] = useState(null)
  const [message, setMessage] = useState({ type: '', text: '' })
  const [importing, setImporting] = useState(false)
  const [testingNotify, setTestingNotify] = useState(false)

  useEffect(() => { fetchSettings() }, [])

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

  const pick = (keys, from) => Object.fromEntries(keys.map(k => [k, from[k] ?? '']))
  const sectionChanged = (section) => JSON.stringify(pick(section.keys, settings)) !== JSON.stringify(pick(section.keys, originalSettings))

  async function saveSection(section) {
    setSavingSection(section.id)
    setMessage({ type: '', text: '' })
    try {
      const body = pick(section.keys, settings)
      const res = await authFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      if (!res.ok) throw new Error('Failed to save settings')
      setOriginalSettings(prev => ({ ...prev, ...body }))
      showMessage('success', `${section.title} saved`)
    } catch (err) {
      showMessage('error', 'Error: ' + err.message)
    } finally {
      setSavingSection(null)
    }
  }

  function resetSection(section) {
    setSettings(prev => ({ ...prev, ...pick(section.keys, originalSettings) }))
  }

  function handleChange(e) {
    const { name, value, type, checked } = e.target
    const newValue = type === 'checkbox' ? (checked ? 'true' : 'false') : value
    setSettings(prev => ({ ...prev, [name]: newValue }))
  }

  async function handleTestNotification() {
    setTestingNotify(true)
    try {
      // Persist the notification keys first so the test uses the values on screen.
      const section = SECTIONS.find(s => s.id === 'notifications')
      await authFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pick(section.keys, settings))
      })
      setOriginalSettings(prev => ({ ...prev, ...pick(section.keys, settings) }))
      const res = await authFetch('/api/system/notify-test', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Test failed')
      showMessage('success', 'Test notification sent!')
    } catch (err) {
      showMessage('error', err.message)
    } finally {
      setTestingNotify(false)
    }
  }

  async function handleExport() {
    try {
      const res = await authFetch('/api/system/export')
      if (!res.ok) throw new Error('Export failed')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `agenthotel-export-${new Date().toISOString().slice(0, 10)}.json`
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
      if (!confirm(`Import ${data.agents?.length || 0} agents and ${data.providers?.length || 0} providers from "${file.name}"? Existing entries with the same name are kept.`)) return
      setImporting(true)
      const res = await authFetch('/api/system/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: text
      })
      const result = await res.json()
      if (!res.ok) throw new Error(result.error || 'Import failed')
      showMessage('success', `Import done: ${result.agents.imported} agents added (${result.agents.skipped} skipped), ${result.providers.imported} providers added (${result.providers.skipped} skipped)`)
    } catch (err) {
      showMessage('error', 'Import failed: ' + err.message)
    } finally {
      setImporting(false)
      e.target.value = ''
    }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px', color: 'var(--text-secondary, #94a3b8)' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: '40px', height: '40px', border: '3px solid var(--border, #334155)', borderTopColor: '#3b82f6', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 1rem' }} />
          <div>Loading settings...</div>
        </div>
      </div>
    )
  }

  const inputStyle = { width: '100%', padding: '0.75rem', background: 'var(--bg-primary, #0f172a)', border: '1px solid var(--border, #334155)', borderRadius: '0.5rem', color: 'var(--text-primary, #e2e8f0)', fontSize: '0.9rem', transition: 'border-color 0.2s' }
  const labelStyle = { display: 'block', marginBottom: '0.5rem', color: 'var(--text-primary, #e2e8f0)', fontWeight: '500', fontSize: '0.9rem' }
  const helpTextStyle = { fontSize: '0.75rem', color: 'var(--text-secondary, #94a3b8)', marginTop: '0.25rem' }
  const sectionStyle = { background: 'var(--bg-secondary, #1e293b)', borderRadius: '0.75rem', padding: '2rem', marginBottom: '2rem', border: '1px solid var(--border, #334155)' }
  const sectionHeaderStyle = { margin: '0 0 1.5rem 0', fontSize: '1.25rem', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '0.75rem', color: 'var(--text-primary, #e2e8f0)' }
  const formGroupStyle = { marginBottom: '1.5rem' }
  const twoCols = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '1.5rem' }

  const field = ({ name, label, help, type = 'text', placeholder, fallback = '' }) => (
    <div style={formGroupStyle}>
      <label style={labelStyle}>{label}</label>
      <input type={type} name={name} value={settings[name] ?? fallback} onChange={handleChange} placeholder={placeholder} style={inputStyle} />
      {help && <div style={helpTextStyle}>{help}</div>}
    </div>
  )

  // The card's own save and reset. Disabled until something in *this* card
  // differs from what was loaded, so the button also answers "did I change
  // anything here?"
  const cardFooter = (section) => {
    const changed = sectionChanged(section)
    const saving = savingSection === section.id
    return (
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', paddingTop: '1rem', borderTop: '1px solid var(--border, #334155)' }}>
        <button type="button" className="btn btn-primary" disabled={saving || !changed} onClick={() => saveSection(section)}
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', opacity: (!changed || saving) ? 0.6 : 1 }}>
          <Save size={16} /> {saving ? 'Saving…' : `Save ${section.title}`}
        </button>
        <button type="button" className="btn btn-secondary" disabled={!changed} onClick={() => resetSection(section)}
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', opacity: !changed ? 0.6 : 1 }}>
          <RotateCcw size={16} /> Reset
        </button>
        {changed && (
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#f59e0b', fontSize: '0.875rem' }}>
            <AlertCircle size={16} /> Unsaved changes
          </span>
        )}
      </div>
    )
  }

  const card = (section, body) => {
    const Icon = section.icon
    return (
      <div key={section.id} style={sectionStyle}>
        <h2 style={sectionHeaderStyle}><Icon size={22} color={section.color} /> {section.title}</h2>
        {body}
        {cardFooter(section)}
      </div>
    )
  }

  const [panel, dockerSec, security, notifications] = SECTIONS

  return (
    <div>
      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ margin: '0 0 0.5rem 0', fontSize: '2rem', fontWeight: '700' }}>Settings</h1>
        <p style={{ margin: 0, color: 'var(--text-secondary, #94a3b8)', fontSize: '0.9rem' }}>
          Each card saves on its own. Nothing here applies until you press its Save.
        </p>
      </div>

      {message.text && (
        <div style={{ padding: '1rem 1.25rem', marginBottom: '1.5rem', background: message.type === 'error' ? 'rgba(239, 68, 68, 0.1)' : 'rgba(16, 185, 129, 0.1)', border: `1px solid ${message.type === 'error' ? '#ef4444' : '#10b981'}`, borderRadius: '0.5rem', color: message.type === 'error' ? '#ef4444' : '#10b981', display: 'flex', alignItems: 'center', gap: '0.75rem', fontSize: '0.9rem' }}>
          {message.type === 'error' ? <AlertCircle size={18} /> : <CheckCircle size={18} />}
          {message.text}
        </div>
      )}

      {card(panel, <>
        {field({ name: 'panel_domain', label: 'Panel domain', placeholder: 'panel.example.com',
          help: 'The hostname this panel answers on. Changing it rewrites the panel\'s own Caddy route and requests a certificate for the new name — DNS must already point here.' })}
        {field({ name: 'caddy_email', label: 'Certificate e-mail', type: 'email', placeholder: 'admin@example.com',
          help: 'Given to Let\'s Encrypt with every certificate request. They write here when a certificate is about to expire and could not be renewed.' })}
      </>)}

      {card(dockerSec, <>
        {field({ name: 'default_network', label: 'Panel network', fallback: 'agenthotel_agenthotel',
          help: 'The Docker network agents and compose guests are joined to so Caddy can reach them by name. Only change this if you renamed the compose project.' })}
      </>)}

      {card(security, <>
        <div style={formGroupStyle}>
          <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
            <input type="checkbox" name="rate_limit_enabled" checked={settings.rate_limit_enabled === 'true'} onChange={handleChange} style={{ width: 'auto', cursor: 'pointer' }} />
            Rate limit the API
          </label>
          <div style={helpTextStyle}>A ceiling per address on API calls per minute. The login page has its own, much stricter rule — ten failed attempts in fifteen minutes — which is always on.</div>
        </div>
        {settings.rate_limit_enabled === 'true' && field({ name: 'rate_limit_requests', label: 'Requests per minute', type: 'number', fallback: '600',
          help: 'Generous on purpose: the dashboard polls stats every few seconds per open tab. This catches a runaway script, not a person.' })}
        {field({ name: 'session_timeout', label: 'Session timeout (minutes)', type: 'number', fallback: '60',
          help: 'How long a browser session stays signed in without activity. API and MCP clients use the panel token and are not affected.' })}
      </>)}

      {card(notifications, <>
        <p style={{ margin: '0 0 1.5rem 0', color: 'var(--text-secondary, #94a3b8)', fontSize: '0.9rem' }}>
          Get alerted when an agent goes down or recovers, when a login is blocked, and when host disk or memory usage crosses a threshold.
        </p>
        {field({ name: 'notify_webhook_url', label: 'Webhook URL', type: 'url', placeholder: 'https://hooks.slack.com/services/… or Discord webhook',
          help: 'Slack or Discord incoming webhook — receives a JSON {"text": "…"} POST' })}
        <div style={twoCols}>
          {field({ name: 'notify_telegram_token', label: 'Telegram bot token', placeholder: '123456:ABC-DEF…', help: 'From @BotFather. Leave both Telegram fields empty to use the webhook only.' })}
          {field({ name: 'notify_telegram_chat_id', label: 'Telegram chat ID', placeholder: '-1001234567890', help: 'The chat or group the bot posts to. Groups start with -100.' })}
        </div>
        <div style={twoCols}>
          {field({ name: 'notify_disk_threshold', label: 'Disk alert threshold (%)', type: 'number', fallback: '85', help: 'Alert when the host disk is fuller than this. Checked every five minutes.' })}
          {field({ name: 'notify_mem_threshold', label: 'Memory alert threshold (%)', type: 'number', fallback: '90', help: 'Alert when host memory use is above this. Agents have their own caps; this is the whole machine.' })}
        </div>
        <button type="button" className="btn btn-secondary" onClick={handleTestNotification} disabled={testingNotify}
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
          <Send size={16} /> {testingNotify ? 'Sending…' : 'Send test notification'}
        </button>
      </>)}

      <div style={sectionStyle}>
        <h2 style={sectionHeaderStyle}><Database size={22} color="#8b5cf6" /> Backup & Migration</h2>
        <p style={{ margin: '0 0 1.5rem 0', color: 'var(--text-secondary, #94a3b8)', fontSize: '0.9rem' }}>
          Move this instance to another VPS: export here, import on the new AgentHotel instance.
          Agents, providers (including API keys) and panel settings are included — admin credentials are never exported.
        </p>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-secondary" onClick={handleExport} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Download size={18} /> Export Instance
          </button>
          <label className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: importing ? 'wait' : 'pointer', opacity: importing ? 0.6 : 1 }}>
            <Upload size={18} /> {importing ? 'Importing...' : 'Import Instance'}
            <input type="file" accept="application/json,.json" onChange={handleImport} disabled={importing} style={{ display: 'none' }} />
          </label>
        </div>
        <div style={helpTextStyle}>
          The export file contains provider API keys in plain text — store it safely.
          Imported agents start as stopped; redeploy them from the dashboard. Existing agents are kept (matched on name/domain); existing providers are kept (matched on name).
        </div>
      </div>
    </div>
  )
}

export default Settings

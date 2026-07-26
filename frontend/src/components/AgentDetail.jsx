import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { authFetch, getToken } from '../lib/auth'
import {
  Key, Copy, ExternalLink, Play, Square, RefreshCw, Trash2, Plus, X,
  Settings as SettingsIcon, FileText, Terminal as TerminalIcon, Save, Box, Globe
} from 'lucide-react'

const SENSITIVE = /key|token|password|secret/i

const TABS = [
  { id: 'overview', label: 'Overview', icon: Box },
  { id: 'logs', label: 'Logs', icon: FileText },
  { id: 'console', label: 'Console', icon: TerminalIcon },
  { id: 'environment', label: 'Environment', icon: SettingsIcon },
  { id: 'credentials', label: 'Credentials', icon: Key },
  { id: 'settings', label: 'Settings', icon: Globe }
]

function AgentDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [agent, setAgent] = useState(null)
  const [tab, setTab] = useState('overview')
  const [logs, setLogs] = useState('')
  const [envPairs, setEnvPairs] = useState([])
  const [envSaving, setEnvSaving] = useState(false)
  const [settings, setSettings] = useState({ domain: '', image: '', port: '' })
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [showTerminal, setShowTerminal] = useState(false)
  const terminalRef = useRef(null)
  const xtermRef = useRef(null)
  const logBoxRef = useRef(null)

  useEffect(() => { fetchAgent() }, [id])
  useEffect(() => { if (tab === 'logs') fetchLogs() }, [tab, id])

  async function fetchAgent() {
    try {
      const res = await authFetch(`/api/agents/${id}`)
      const data = await res.json()
      setAgent(data)
      setEnvPairs(Object.entries(data.config || {}).map(([k, v]) => ({ key: k, value: String(v) })))
      setSettings({ domain: data.domain || '', image: data.image || '', port: data.port || '' })
    } catch (err) { console.error('Failed to fetch agent:', err) }
  }

  async function fetchLogs() {
    try {
      const res = await authFetch(`/api/agents/${id}/logs?tail=300`)
      setLogs(await res.text())
    } catch (err) { console.error('Failed to fetch logs:', err) }
  }

  useEffect(() => { if (tab === 'logs' && logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight }, [logs, tab])

  function flash(text) { setMsg(text); setTimeout(() => setMsg(''), 3000) }

  async function handleAction(path, method = 'POST') {
    try {
      await authFetch(`/api/agents/${id}/${path}`, { method })
      await fetchAgent()
      if (path === 'redeploy') fetchLogs()
    } catch (err) { flash('Error: ' + err.message) }
  }

  async function handleDelete() {
    if (!confirm('Delete this agent? This cannot be undone.')) return
    try { await authFetch(`/api/agents/${id}`, { method: 'DELETE' }); navigate('/') }
    catch (err) { flash('Delete failed: ' + err.message) }
  }

  async function saveEnv() {
    setEnvSaving(true)
    try {
      const config = {}
      for (const p of envPairs) {
        const k = p.key.trim(); if (k) config[k] = p.value
      }
      const res = await authFetch(`/api/agents/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config })
      })
      if (!res.ok) { const e = await res.json(); throw new Error(e.error) }
      flash('Environment saved & redeployed')
      await fetchAgent()
    } catch (err) { flash('Save failed: ' + err.message) }
    finally { setEnvSaving(false) }
  }

  async function saveSettings() {
    setSettingsSaving(true)
    try {
      const res = await authFetch(`/api/agents/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: settings.domain })
      })
      if (!res.ok) { const e = await res.json(); throw new Error(e.error) }
      flash('Settings saved & redeployed')
      await fetchAgent()
    } catch (err) { flash('Save failed: ' + err.message) }
    finally { setSettingsSaving(false) }
  }

  // ---- terminal ----
  useEffect(() => {
    if (tab === 'console' && !showTerminal) setShowTerminal(true)
    if (tab === 'console' && !xtermRef.current) setTimeout(initTerminal, 100)
    // eslint-disable-next-line
  }, [tab])

  function initTerminal() {
    if (!terminalRef.current || xtermRef.current) return
    const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'Menlo, monospace', theme: { background: '#0f172a', foreground: '#e2e8f0', cursor: '#3b82f6' } })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(terminalRef.current)
    fitAddon.fit()
    const token = getToken()
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${window.location.host}/api/agents/${id}/terminal?token=${token}`)
    ws.onopen = () => term.writeln('Connected to agent terminal\r')
    ws.onmessage = (e) => term.write(e.data)
    ws.onclose = () => term.writeln('\r\nDisconnected from terminal')
    term.onData((d) => ws.send(d))
    xtermRef.current = { term, ws, fitAddon }
    window.addEventListener('resize', onResize)
    function onResize() { fitAddon.fit() }
    term._onResize = onResize
  }

  useEffect(() => () => {
    if (xtermRef.current) {
      if (xtermRef.current.term._onResize) window.removeEventListener('resize', xtermRef.current.term._onResize)
      xtermRef.current.ws.close(); xtermRef.current.term.dispose()
    }
  }, [])

  function getCredentials() {
    const c = agent.config || {}
    const creds = []
    if (agent.runtime === 'openclaw' && c.OPENCLAW_GATEWAY_TOKEN) creds.push({ label: 'Gateway Token', value: c.OPENCLAW_GATEWAY_TOKEN })
    if (agent.runtime === 'hermes') {
      creds.push({ label: 'Dashboard Username', value: 'admin' })
      creds.push({ label: 'Dashboard Password', value: c.HERMES_DASHBOARD_PASSWORD || 'agentpanel' })
    }
    if (c.OPENAI_API_KEY) creds.push({ label: 'OpenAI API Key', value: c.OPENAI_API_KEY })
    if (c.OPENROUTER_API_KEY) creds.push({ label: 'OpenRouter API Key', value: c.OPENROUTER_API_KEY })
    if (c.ANTHROPIC_API_KEY) creds.push({ label: 'Anthropic API Key', value: c.ANTHROPIC_API_KEY })
    return creds
  }

  function copy(text) { navigator.clipboard.writeText(text); flash('Copied to clipboard') }

  if (!agent) return <div className="loading">Loading…</div>

  const appUrl = agent.domain && agent.domain.includes('.') ? `https://${agent.domain}` : null
  const credentials = getCredentials()

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem', marginBottom: '1.5rem' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <h1 style={{ margin: 0 }}>{agent.name}</h1>
            <span style={{
              padding: '0.2rem 0.6rem', borderRadius: '1rem', fontSize: '0.75rem', fontWeight: 600,
              background: agent.status === 'running' ? '#10b981' : agent.status === 'stopped' ? '#ef4444' : '#f59e0b',
              color: 'white', textTransform: 'uppercase'
            }}>{agent.status}</span>
          </div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginTop: '0.35rem' }}>
            {agent.runtime} · {agent.image}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {appUrl && (
            <a href={appUrl} target="_blank" rel="noopener noreferrer" className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', textDecoration: 'none' }}>
              <ExternalLink size={16} color="white" /> Open
            </a>
          )}
          {agent.status === 'running' ? (
            <button className="btn btn-warning" style={{ background: '#f59e0b', color: 'white', display: 'flex', alignItems: 'center', gap: '0.4rem' }} onClick={() => handleAction('stop')}><Square size={16} color="white" /> Stop</button>
          ) : (
            <button className="btn btn-success" style={{ background: '#10b981', color: 'white', display: 'flex', alignItems: 'center', gap: '0.4rem' }} onClick={() => handleAction('start')}><Play size={16} color="white" /> Start</button>
          )}
          <button className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }} onClick={() => handleAction('redeploy')}><RefreshCw size={16} color="white" /> Redeploy</button>
          <button className="btn btn-danger" onClick={handleDelete} title="Delete"><Trash2 size={16} color="white" /></button>
        </div>
      </div>

      {msg && <div style={{ background: '#1e293b', border: '1px solid #3b82f6', color: '#93c5fd', padding: '0.6rem 1rem', borderRadius: '0.4rem', marginBottom: '1rem', fontSize: '0.875rem' }}>{msg}</div>}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '0.25rem', borderBottom: '1px solid var(--border, #334155)', marginBottom: '1.5rem', overflowX: 'auto' }}>
        {TABS.map(t => {
          const Icon = t.icon
          return (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              display: 'flex', alignItems: 'center', gap: '0.4rem',
              padding: '0.6rem 1rem', background: 'none', border: 'none', borderBottom: tab === t.id ? '2px solid #3b82f6' : '2px solid transparent',
              color: tab === t.id ? 'var(--text-primary, #e2e8f0)' : 'var(--text-secondary, #94a3b8)',
              cursor: 'pointer', fontSize: '0.875rem', fontWeight: tab === t.id ? 600 : 400, whiteSpace: 'nowrap'
            }}>
              <Icon size={15} color="currentColor" /> {t.label}
            </button>
          )
        })}
      </div>

      {/* Overview */}
      {tab === 'overview' && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
            {[
              ['Runtime', agent.runtime], ['Domain', agent.domain || '—'],
              ['Image', agent.image], ['Port', String(agent.port || '—')],
              ['Created', new Date(agent.created_at).toLocaleString()], ['Updated', new Date(agent.updated_at).toLocaleString()]
            ].map(([label, value]) => (
              <div key={label} style={{ background: 'var(--bg-secondary, #1e293b)', borderRadius: '0.5rem', padding: '1rem', border: '1px solid var(--border, #334155)' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.35rem' }}>{label}</div>
                <div style={{ fontSize: '0.9rem', wordBreak: 'break-all', fontFamily: label === 'Image' ? 'monospace' : 'inherit' }}>{value}</div>
              </div>
            ))}
          </div>
          {appUrl && (
            <div style={{ background: 'var(--bg-secondary, #1e293b)', borderRadius: '0.5rem', padding: '1rem 1.25rem', border: '1px solid var(--border, #334155)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>PUBLIC URL</div>
                <a href={appUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#60a5fa', fontFamily: 'monospace', textDecoration: 'none' }}>{appUrl}</a>
              </div>
              <a href={appUrl} target="_blank" rel="noopener noreferrer" className="btn btn-secondary" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '0.4rem' }}><ExternalLink size={15} color="white" /> Open app</a>
            </div>
          )}
        </div>
      )}

      {/* Logs */}
      {tab === 'logs' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <h3 style={{ margin: 0, fontSize: '1rem' }}>Container logs</h3>
            <button className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }} onClick={fetchLogs}><RefreshCw size={15} color="white" /> Refresh</button>
          </div>
          <pre ref={logBoxRef} style={{ background: '#0f172a', color: '#cbd5e1', padding: '1rem', borderRadius: '0.5rem', maxHeight: '60vh', overflow: 'auto', fontSize: '0.8rem', fontFamily: 'Menlo, monospace', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{logs || 'No logs available'}</pre>
        </div>
      )}

      {/* Console */}
      {tab === 'console' && (
        <div>
          <div style={{ background: '#0f172a', borderRadius: '0.5rem', padding: '0.5rem' }}>
            <div ref={terminalRef} style={{ height: '55vh' }}></div>
          </div>
        </div>
      )}

      {/* Environment */}
      {tab === 'environment' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <div>
              <h3 style={{ margin: 0, fontSize: '1rem' }}>Environment variables</h3>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>Saving redeploys the agent with the new configuration.</div>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }} onClick={() => setEnvPairs([...envPairs, { key: '', value: '' }])}><Plus size={15} color="white" /> Add</button>
              <button className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }} disabled={envSaving} onClick={saveEnv}><Save size={15} color="white" /> {envSaving ? 'Saving…' : 'Save & Deploy'}</button>
            </div>
          </div>
          <div style={{ display: 'grid', gap: '0.5rem' }}>
            {envPairs.length === 0 && <div style={{ color: 'var(--text-secondary)', fontStyle: 'italic', padding: '1rem' }}>No environment variables.</div>}
            {envPairs.map((p, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 1fr) 2fr auto', gap: '0.5rem', alignItems: 'center' }}>
                <input style={{ fontFamily: 'monospace', fontSize: '0.85rem' }} value={p.key} placeholder="KEY" onChange={(e) => setEnvPairs(envPairs.map((x, j) => j === i ? { ...x, key: e.target.value } : x))} />
                <input style={{ fontFamily: 'monospace', fontSize: '0.85rem' }} type={SENSITIVE.test(p.key) ? 'password' : 'text'} value={p.value} placeholder="value" onChange={(e) => setEnvPairs(envPairs.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} />
                <button className="btn btn-danger" title="Remove" onClick={() => setEnvPairs(envPairs.filter((_, j) => j !== i))}><X size={15} color="white" /></button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Credentials */}
      {tab === 'credentials' && (
        <div>
          {credentials.length === 0 ? (
            <div style={{ color: 'var(--text-secondary)', fontStyle: 'italic', padding: '1rem' }}>No credentials for this agent.</div>
          ) : (
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              {credentials.map((cred, i) => {
                const masked = SENSITIVE.test(cred.label) && cred.value.length > 8 ? '••••••' + cred.value.slice(-8) : cred.value
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg-secondary, #1e293b)', borderRadius: '0.5rem', padding: '0.85rem 1rem', border: '1px solid var(--border, #334155)' }}>
                    <div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>{cred.label}</div>
                      <div style={{ fontFamily: 'monospace', fontSize: '0.85rem', wordBreak: 'break-all' }}>{masked}</div>
                    </div>
                    <button className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.35rem 0.75rem' }} onClick={() => copy(cred.value)}><Copy size={14} color="white" /> Copy</button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Settings */}
      {tab === 'settings' && (
        <div style={{ maxWidth: '560px' }}>
          <div className="form-group" style={{ marginBottom: '1rem' }}>
            <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Domain (subdomain or FQDN)</label>
            <input type="text" value={settings.domain} placeholder="myapp.froste.eu" onChange={(e) => setSettings({ ...settings, domain: e.target.value })} style={{ width: '100%', marginTop: '0.3rem' }} />
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.3rem' }}>Changing the domain provisions a new HTTPS route via Caddy.</div>
          </div>
          <div className="form-group" style={{ marginBottom: '1rem' }}>
            <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Image (read-only)</label>
            <input type="text" value={settings.image} disabled style={{ width: '100%', marginTop: '0.3rem', opacity: 0.6 }} />
          </div>
          <div className="form-group" style={{ marginBottom: '1.5rem' }}>
            <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Port (read-only)</label>
            <input type="text" value={settings.port} disabled style={{ width: '100%', marginTop: '0.3rem', opacity: 0.6 }} />
          </div>
          <button className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }} disabled={settingsSaving} onClick={saveSettings}><Save size={15} color="white" /> {settingsSaving ? 'Saving…' : 'Save & Redeploy'}</button>
          <div style={{ marginTop: '2rem', paddingTop: '1.5rem', borderTop: '1px solid var(--border, #334155)' }}>
            <h4 style={{ margin: '0 0 0.5rem 0', color: '#f87171', fontSize: '0.9rem' }}>Danger zone</h4>
            <button className="btn btn-danger" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }} onClick={handleDelete}><Trash2 size={15} color="white" /> Delete agent</button>
          </div>
        </div>
      )}
    </div>
  )
}

export default AgentDetail

import { useState, useEffect, useRef } from 'react'
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom'
import { getToken, clearToken, authFetch } from './lib/auth'
import { ToastProvider, useToast } from './components/Toast'
import Dashboard from './components/Dashboard'
import CreateAgent from './components/CreateAgent'
import Compose from './components/Compose'
import AgentDetail from './components/AgentDetail'
import Settings from './components/Settings'
import System from './components/System'
import Connect from './components/Connect'
import Providers from './components/Providers'
import Console from './components/Console'
import Certificates from './components/Certificates'
import Profile from './components/Profile'
import Domains from './components/Domains'
import Templates from './components/Templates'
import TemplateDetail from './components/TemplateDetail'
import Setup from './components/Setup'
import Login from './components/Login'
import { Bot, BarChart3, Plus, Globe, Lock, Terminal, Monitor, MonitorSmartphone, Link2, Key, Settings as SettingsIcon, Layers, LayoutTemplate, Sun, Moon, Package, User, Download, Menu, X, AlertTriangle, ChevronDown, Copy, LogOut, ExternalLink } from 'lucide-react'
import { getThemeChoice, setThemeChoice } from './lib/theme'
import './index.css'

// A small dropdown: opens on click, closes on a click elsewhere or Escape.
function useDropdown() {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
  return { open, setOpen, ref }
}

function ThemeSwitch() {
  const [choice, setChoice] = useState(getThemeChoice)
  const options = [
    { value: 'light', label: 'Light', Icon: Sun },
    { value: 'dark', label: 'Dark', Icon: Moon },
    { value: 'system', label: 'System', Icon: MonitorSmartphone },
  ]
  return (
    <div className="theme-switch" role="radiogroup" aria-label="Theme">
      {options.map(({ value, label, Icon }) => (
        <button key={value} type="button" role="radio" aria-checked={choice === value} title={label}
          className={choice === value ? 'active' : ''}
          onClick={() => { setThemeChoice(value); setChoice(value) }}>
          <Icon size={15} color="currentColor" />
        </button>
      ))}
    </div>
  )
}

function NewAgentMenu() {
  const { open, setOpen, ref } = useDropdown()
  return (
    <div className="topbar-dropdown" ref={ref}>
      <button type="button" className="topbar-new" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
        <Plus size={15} color="currentColor" /> <span className="topbar-new-label">New agent</span> <ChevronDown size={14} color="currentColor" />
      </button>
      {open && (
        <div className="dropdown-menu" role="menu" onClick={() => setOpen(false)}>
          <Link to="/create" role="menuitem" className="dropdown-item">
            <Bot size={15} color="currentColor" /> <span><strong>Agent</strong><small>Hermes, OpenClaw, an image or a repo</small></span>
          </Link>
          <Link to="/templates" role="menuitem" className="dropdown-item">
            <LayoutTemplate size={15} color="currentColor" /> <span><strong>From a template</strong><small>Ready-made, one click</small></span>
          </Link>
          <Link to="/compose" role="menuitem" className="dropdown-item">
            <Layers size={15} color="currentColor" /> <span><strong>Compose</strong><small>A stack from a compose file</small></span>
          </Link>
        </div>
      )}
    </div>
  )
}

function UserMenu({ onLogout }) {
  const { open, setOpen, ref } = useDropdown()
  const [email, setEmail] = useState('')
  const [ip, setIp] = useState('')
  const toast = useToast()

  useEffect(() => {
    authFetch('/api/profile').then(r => r.json()).then(d => setEmail(d.email || '')).catch(() => {})
    authFetch('/api/system/ip').then(r => r.json()).then(d => setIp(d.ip || '')).catch(() => {})
  }, [])

  const initial = (email.trim()[0] || 'A').toUpperCase()
  return (
    <div className="topbar-dropdown" ref={ref}>
      <button type="button" className="topbar-avatar" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} aria-label="Account menu">
        {initial}
      </button>
      {open && (
        <div className="dropdown-menu dropdown-menu-right" role="menu">
          {email && <div className="dropdown-caption" data-secret="">{email}</div>}
          <Link to="/profile" role="menuitem" className="dropdown-item" onClick={() => setOpen(false)}>
            <User size={15} color="currentColor" /> Profile
          </Link>
          <Link to="/settings" role="menuitem" className="dropdown-item" onClick={() => setOpen(false)}>
            <SettingsIcon size={15} color="currentColor" /> Settings
          </Link>
          {ip && (
            // The host address is what you paste into a DNS A record when the
            // panel is not behind a tunnel; one click copies it.
            <button type="button" role="menuitem" className="dropdown-item"
              onClick={() => {
                setOpen(false)
                navigator.clipboard.writeText(ip)
                  .then(() => toast.success(`${ip} copied`))
                  .catch(() => toast.error('Could not copy — the browser blocked clipboard access'))
              }}>
              <Copy size={15} color="currentColor" /> <span>Copy host IP <small data-secret="">{ip}</small></span>
            </button>
          )}
          <div className="dropdown-divider" />
          <button type="button" role="menuitem" className="dropdown-item" onClick={() => { setOpen(false); onLogout() }}>
            <LogOut size={15} color="currentColor" /> Log out
          </button>
        </div>
      )}
    </div>
  )
}

function Topbar({ onLogout, onToggleMenu, menuOpen, alerts }) {
  const location = useLocation()
  const fleetActive = location.pathname === '/' || location.pathname.startsWith('/agent/')
  const templatesActive = location.pathname.startsWith('/templates')
  const connectActive = location.pathname.startsWith('/connect')
  const over = ['disk', 'mem'].filter(k => alerts?.[k]?.over)
  return (
    <header className="topbar">
      <button type="button" className="topbar-menu" onClick={onToggleMenu} aria-label="Toggle menu">
        {menuOpen ? <X size={20} /> : <Menu size={20} />}
      </button>
      <Link to="/" className="topbar-brand"><Bot size={20} color="currentColor" /> AgentHotel</Link>
      <nav className="topbar-nav">
        <Link to="/" className={fleetActive ? 'active' : ''}>Fleet</Link>
        <Link to="/templates" className={templatesActive ? 'active' : ''}>Templates</Link>
        <Link to="/connect" className={connectActive ? 'active' : ''}>Connect</Link>
        <a href="https://github.com/magnusfroste/agenthotel" target="_blank" rel="noopener noreferrer">
          Docs <ExternalLink size={12} color="currentColor" />
        </a>
      </nav>
      <div className="topbar-spacer" />
      {/* Only when something is over its threshold. A host at 96% disk once
          said nothing anywhere; this is where people look. */}
      {over.map(k => (
        <Link key={k} to="/system" className="topbar-alert"
          title={`Above the ${alerts[k].threshold}% threshold — see System`}>
          <AlertTriangle size={14} color="currentColor" /> {k === 'disk' ? 'Disk' : 'Memory'} {alerts[k].pct}%
        </Link>
      ))}
      <NewAgentMenu />
      <ThemeSwitch />
      <UserMenu onLogout={onLogout} />
    </header>
  )
}

function Sidebar({ onNavigate, className = '' }) {
  const location = useLocation()
  const [version, setVersion] = useState('')
  const [updateInfo, setUpdateInfo] = useState(null)
  const [upgrading, setUpgrading] = useState(false)
  const [agents, setAgents] = useState([])
  const toast = useToast()

  useEffect(() => {
    fetchVersion()
    checkForUpdates()
    fetchAgents()
    const interval = setInterval(() => { if (!document.hidden) fetchAgents() }, 5000)
    return () => clearInterval(interval)
  }, [])

  async function fetchVersion() {
    try {
      const versionData = await (await authFetch('/api/system/version')).json()
      setVersion(versionData.version)
    } catch (err) {
      console.error('Failed to fetch system info:', err)
    }
  }

  async function checkForUpdates() {
    try {
      const res = await authFetch('/api/system/check-update')
      const data = await res.json()
      setUpdateInfo(data)
    } catch (err) {
      console.error('Failed to check for updates:', err)
    }
  }

  async function fetchAgents() {
    try {
      const res = await authFetch('/api/agents')
      const data = await res.json()
      setAgents(data)
    } catch (err) {
      console.error('Failed to fetch agents:', err)
    }
  }

  async function handleUpgrade() {
    if (!confirm('This will upgrade AgentHotel to the latest version. The panel will be temporarily unavailable. Continue?')) return

    setUpgrading(true)
    try {
      const res = await authFetch('/api/system/upgrade', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error || 'Upgrade failed. Please check logs.')
        setUpgrading(false)
        return
      }
      toast.success('Upgrade started. The panel restarts once the new image is built…')
      waitForNewVersion(data.currentVersion || updateInfo?.currentVersion)
    } catch (err) {
      console.error('Failed to upgrade:', err)
      toast.error('Upgrade failed. Please check logs.')
      setUpgrading(false)
    }
  }

  // The build takes a few minutes and restarts the backend, so poll for a
  // version different from the one we started on rather than reloading blindly.
  function waitForNewVersion(before) {
    // /api/system/version reports GIT_COMMIT verbatim, the upgrade endpoint
    // reports it shortened — compare on a common prefix.
    const short = (sha) => (sha || '').substring(0, 7)
    const deadline = Date.now() + 15 * 60 * 1000
    const poll = setInterval(async () => {
      if (Date.now() > deadline) {
        clearInterval(poll)
        toast.error('Upgrade is taking longer than expected. Check /api/system/upgrade-log.')
        setUpgrading(false)
        return
      }
      try {
        const res = await authFetch('/api/system/version')
        if (!res.ok) return
        const data = await res.json()
        if (data.commit && short(data.commit) !== short(before)) {
          clearInterval(poll)
          window.location.reload()
        }
      } catch (err) {
        // Backend is restarting — keep polling.
      }
    }, 5000)
  }

  function isActive(path) {
    if (path === '/' && location.pathname === '/') return 'active'
    if (path !== '/' && location.pathname.startsWith(path)) return 'active'
    return ''
  }

  const statusColor = (status) =>
    status === 'running' ? 'var(--accent-green)' : status === 'stopped' ? 'var(--accent-red)' : 'var(--accent-yellow)'

  const infrastructure = [
    { to: '/providers', label: 'Providers', Icon: Key },
    { to: '/domains', label: 'Domains', Icon: Globe },
    { to: '/certificates', label: 'Certificates', Icon: Lock },
    { to: '/console', label: 'Console', Icon: Terminal },
    { to: '/system', label: 'System', Icon: Monitor },
  ]

  return (
    <aside className={`sidebar ${className}`}>
      <div className="sidebar-header">
        <Link to="/" className="sidebar-brand"><Bot size={20} color="currentColor" /> AgentHotel</Link>
      </div>
      <nav className="sidebar-nav" onClick={onNavigate}>
        {/* On a phone the top bar has no room for its links; they live here. */}
        <div className="sidebar-group sidebar-mobile-only">
          <Link to="/" className={`sidebar-link ${isActive('/')}`}><BarChart3 size={16} color="currentColor" /> Fleet</Link>
          <Link to="/templates" className={`sidebar-link ${isActive('/templates')}`}><LayoutTemplate size={16} color="currentColor" /> Templates</Link>
          <Link to="/connect" className={`sidebar-link ${isActive('/connect')}`}><Link2 size={16} color="currentColor" /> Connect</Link>
          <Link to="/settings" className={`sidebar-link ${isActive('/settings')}`}><SettingsIcon size={16} color="currentColor" /> Settings</Link>
        </div>

        <div className="sidebar-group">
          <div className="sidebar-label">Agents</div>
          {agents.length === 0 && (
            <Link to="/create" className="sidebar-link sidebar-empty"><Plus size={16} color="currentColor" /> Check in your first agent</Link>
          )}
          {agents.map(agent => (
            <Link key={agent.id} to={`/agent/${agent.id}`}
              className={`sidebar-agent ${location.pathname === `/agent/${agent.id}` ? 'active' : ''}`}>
              <span className="sidebar-agent-name">
                <span className="sidebar-agent-dot" style={{ background: statusColor(agent.status) }} />
                <span>{agent.name}</span>
              </span>
              <span className="sidebar-agent-runtime">{agent.runtime}</span>
            </Link>
          ))}
        </div>

        <div className="sidebar-group">
          <div className="sidebar-label">Infrastructure</div>
          {infrastructure.map(({ to, label, Icon }) => (
            <Link key={to} to={to} className={`sidebar-link ${isActive(to)}`}>
              <Icon size={16} color="currentColor" /> {label}
            </Link>
          ))}
        </div>
      </nav>

      <div className="sidebar-footer">
        {version && version !== 'unknown' && (() => {
          // The version links to its commit; a newer one, when there is one,
          // to the compare view — the list of exactly what an upgrade would
          // bring. Deliberately quiet: the Upgrade button is the action, this
          // is the information behind it.
          const repo = updateInfo?.repoUrl || 'https://github.com/magnusfroste/agenthotel'
          const latest = updateInfo?.hasUpdate ? updateInfo.latestVersion : null
          return (
            <div className="sidebar-meta-item">
              <Package size={13} color="currentColor" />
              <a className="sidebar-meta-link" href={`${repo}/commit/${version}`} target="_blank" rel="noreferrer"
                title={`Running commit ${version} — open it on GitHub`}>v{version}</a>
              {latest && (
                <a className="sidebar-meta-link sidebar-meta-newer" href={`${repo}/compare/${version}...${latest}`} target="_blank" rel="noreferrer"
                  title={`${latest} is newer${updateInfo.latestSubject ? `: ${updateInfo.latestSubject}` : ''}. See what changed since ${version}.`}>
                  → {latest}
                </a>
              )}
            </div>
          )
        })()}
        {updateInfo?.hasUpdate && (
          <button onClick={handleUpgrade} disabled={upgrading} className="btn-upgrade">
            {upgrading ? 'Upgrading…' : <><Download size={14} color="currentColor" /> Upgrade to {updateInfo.latestVersion}</>}
          </button>
        )}
      </div>
    </aside>
  )
}

function App() {
  const [state, setState] = useState('loading')
  const [mobileOpen, setMobileOpen] = useState(false)
  // Disk or memory past its threshold, shown as a quiet badge in the top bar.
  const [alerts, setAlerts] = useState(null)

  useEffect(() => {
    checkState()
  }, [])

  useEffect(() => {
    if (state !== 'authenticated') return
    const fetchAlerts = () => authFetch('/api/system/alerts').then(r => r.json()).then(setAlerts).catch(() => {})
    fetchAlerts()
    // The backend re-reads disk and memory every five minutes; once a minute
    // here is plenty to pick that up.
    const interval = setInterval(() => { if (!document.hidden) fetchAlerts() }, 60000)
    return () => clearInterval(interval)
  }, [state])

  async function checkState() {
    try {
      const res = await fetch('/api/setup')
      const data = await res.json()
      
      if (!data.configured) {
        setState('setup')
      } else if (!getToken()) {
        setState('login')
      } else {
        setState('authenticated')
      }
    } catch (err) {
      console.error('Failed to check setup state:', err)
      setState('login')
    }
  }

  function handleLogout() {
    // Revoke on the server too — clearing localStorage alone would leave the
    // session valid until it lapses.
    authFetch('/api/logout', { method: 'POST' }).catch(() => {})
    clearToken()
    setState('login')
  }

  if (state === 'loading') {
    return <div className="loading">Loading...</div>
  }

  if (state === 'setup') {
    return <Setup onDone={() => setState('authenticated')} />
  }

  if (state === 'login') {
    return <Login onDone={() => setState('authenticated')} />
  }

  return (
    <ToastProvider>
      <BrowserRouter>
        <div className="app">
          <Topbar
            onLogout={handleLogout}
            onToggleMenu={() => setMobileOpen(!mobileOpen)}
            menuOpen={mobileOpen}
            alerts={alerts}
          />

          {mobileOpen && (
            <div
              className="mobile-sidebar-overlay active"
              onClick={() => setMobileOpen(false)}
            />
          )}

          <Sidebar
            onNavigate={() => setMobileOpen(false)}
            className={mobileOpen ? 'sidebar-open' : ''}
          />
          <main className="main-content">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/templates" element={<Templates />} />
              <Route path="/templates/:id" element={<TemplateDetail />} />
              <Route path="/create" element={<CreateAgent />} />
              <Route path="/compose" element={<Compose />} />
              <Route path="/agent/:id" element={<AgentDetail />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/system" element={<System />} />
              <Route path="/connect" element={<Connect />} />
              <Route path="/providers" element={<Providers />} />
              <Route path="/console" element={<Console />} />
              <Route path="/certificates" element={<Certificates />} />
              <Route path="/profile" element={<Profile />} />
              <Route path="/domains" element={<Domains />} />
            </Routes>
          </main>
        </div>
      </BrowserRouter>
    </ToastProvider>
  )
}

export default App

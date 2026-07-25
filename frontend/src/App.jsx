import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom'
import { getToken, clearToken, authFetch } from './lib/auth'
import Dashboard from './components/Dashboard'
import CreateAgent from './components/CreateAgent'
import AgentDetail from './components/AgentDetail'
import Settings from './components/Settings'
import System from './components/System'
import Connect from './components/Connect'
import Providers from './components/Providers'
import Console from './components/Console'
import Certificates from './components/Certificates'
import Profile from './components/Profile'
import Domains from './components/Domains'
import Setup from './components/Setup'
import Login from './components/Login'
import './index.css'

function Sidebar({ onLogout }) {
  const location = useLocation()
  const [ip, setIp] = useState('')
  const [version, setVersion] = useState('')
  const [updateInfo, setUpdateInfo] = useState(null)
  const [upgrading, setUpgrading] = useState(false)
  const [agents, setAgents] = useState([])
  const [darkMode, setDarkMode] = useState(() => {
    return localStorage.getItem('darkMode') !== 'false'
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light')
    localStorage.setItem('darkMode', darkMode)
  }, [darkMode])

  useEffect(() => {
    fetchSystemInfo()
    checkForUpdates()
    fetchAgents()
    const interval = setInterval(fetchAgents, 5000)
    return () => clearInterval(interval)
  }, [])

  async function fetchSystemInfo() {
    try {
      const [ipRes, versionRes] = await Promise.all([
        authFetch('/api/system/ip'),
        authFetch('/api/system/version')
      ])
      const ipData = await ipRes.json()
      const versionData = await versionRes.json()
      setIp(ipData.ip)
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
    if (!confirm('This will upgrade AgentPanel to the latest version. The panel will be temporarily unavailable. Continue?')) return
    
    setUpgrading(true)
    try {
      await authFetch('/api/system/upgrade', { method: 'POST' })
      setTimeout(() => {
        window.location.reload()
      }, 30000)
    } catch (err) {
      console.error('Failed to upgrade:', err)
      alert('Upgrade failed. Please check logs.')
      setUpgrading(false)
    }
  }

  function isActive(path) {
    if (path === '/' && location.pathname === '/') return 'active'
    if (path !== '/' && location.pathname.startsWith(path)) return 'active'
    return ''
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <Link to="/" className="sidebar-brand"><Bot size={24} color="white" /> AgentPanel</Link>
      </div>
      <nav className="sidebar-nav">
        <Link to="/" className={`sidebar-link ${isActive('/')}`}>
          <span className="sidebar-icon"><BarChart3 size={18} color="white" /></span>
          <span>Dashboard</span>
        </Link>
        <Link to="/create" className={`sidebar-link ${isActive('/create')}`}>
          <span className="sidebar-icon"><Plus size={18} color="white" /></span>
          <span>Create Agent</span>
        </Link>
        <Link to="/domains" className={`sidebar-link ${isActive('/domains')}`}>
          <span className="sidebar-icon"><Globe size={18} color="white" /></span>
          <span>Domains</span>
        </Link>
        <Link to="/certificates" className={`sidebar-link ${isActive('/certificates')}`}>
          <span className="sidebar-icon"><Lock size={18} color="white" /></span>
          <span>Certificates</span>
        </Link>
        <Link to="/console" className={`sidebar-link ${isActive('/console')}`}>
          <span className="sidebar-icon"><Terminal size={18} color="white" /></span>
          <span>Console</span>
        </Link>
        <Link to="/system" className={`sidebar-link ${isActive('/system')}`}>
          <span className="sidebar-icon"><Monitor size={18} color="white" /></span>
          <span>System</span>
        </Link>
        <Link to="/connect" className={`sidebar-link ${isActive('/connect')}`}>
          <span className="sidebar-icon"><Link2 size={18} color="white" /></span>
          <span>Connect</span>
        </Link>
        <Link to="/providers" className={`sidebar-link ${isActive('/providers')}`}>
          <span className="sidebar-icon"><Key size={18} color="white" /></span>
          <span>Providers</span>
        </Link>
        <Link to="/settings" className={`sidebar-link ${isActive('/settings')}`}>
          <span className="sidebar-icon"><Settings size={18} color="white" /></span>
          <span>Settings</span>
        </Link>
        <a href="https://github.com/magnusfroste/agentpanel" target="_blank" rel="noopener noreferrer" className="sidebar-link">
          <span className="sidebar-icon"><BookOpen size={18} color="white" /></span>
          <span>Docs</span>
        </a>
      </nav>
      
      {agents.length > 0 && (
        <div className="sidebar-agents" style={{ 
          padding: '0.5rem', 
          borderTop: '1px solid var(--border, #334155)',
          borderBottom: '1px solid var(--border, #334155)',
          margin: '0.5rem 0'
        }}>
          <div style={{ fontSize: '0.75rem', fontWeight: '600', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>
            ACTIVE AGENTS
          </div>
          {agents.map(agent => (
            <Link 
              key={agent.id}
              to={`/agent/${agent.id}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0.5rem',
                marginBottom: '0.25rem',
                borderRadius: '0.25rem',
                background: 'var(--bg-secondary, #1e293b)',
                textDecoration: 'none',
                color: 'inherit',
                fontSize: '0.875rem'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <div style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  background: agent.status === 'running' ? '#10b981' : agent.status === 'stopped' ? '#ef4444' : '#f59e0b'
                }} />
                <span style={{ fontWeight: '500' }}>{agent.name}</span>
              </div>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                {agent.runtime}
              </span>
            </Link>
          ))}
        </div>
      )}
      
      <div className="sidebar-footer">
        <button 
          onClick={() => setDarkMode(!darkMode)}
          style={{
            width: '100%',
            marginBottom: '0.5rem',
            background: 'var(--bg-secondary, #1e293b)',
            color: 'var(--text-primary, #e2e8f0)',
            border: '1px solid var(--border, #334155)',
            padding: '0.5rem',
            borderRadius: '0.25rem',
            cursor: 'pointer',
            fontSize: '0.875rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.5rem'
          }}
        >
          {darkMode ? '☀️ Light Mode' : '🌙 Dark Mode'}
        </button>
        
        {updateInfo?.hasUpdate && (
          <button 
            onClick={handleUpgrade} 
            disabled={upgrading}
            className="btn-upgrade"
            style={{
              width: '100%',
              marginBottom: '0.5rem',
              background: '#10b981',
              color: 'white',
              border: 'none',
              padding: '0.5rem',
              borderRadius: '0.25rem',
              cursor: upgrading ? 'not-allowed' : 'pointer',
              fontSize: '0.875rem'
            }}
          >
            {upgrading ? 'Upgrading...' : <><Download size={16} color="white" /> Upgrade to {updateInfo.latestVersion}</>}
          </button>
        )}
        {ip && (
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
            <Globe size={16} color="white" /> IP: {ip}
          </div>
        )}
        {version && version !== 'unknown' && (
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
            📦 v{version}
          </div>
        )}
        <Link to="/profile" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.5rem', textDecoration: 'none' }}>
          👤 Profile
        </Link>
        <button onClick={onLogout} className="btn-logout">
          Logout
        </button>
      </div>
    </div>
  )
}

function App() {
  const [state, setState] = useState('loading')

  useEffect(() => {
    checkState()
  }, [])

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
    <BrowserRouter>
      <div className="app">
        <Sidebar onLogout={handleLogout} />
        <main className="main-content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/create" element={<CreateAgent />} />
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
  )
}

export default App

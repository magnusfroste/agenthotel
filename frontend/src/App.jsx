import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom'
import { getToken, clearToken } from './lib/auth'
import Dashboard from './components/Dashboard'
import CreateAgent from './components/CreateAgent'
import AgentDetail from './components/AgentDetail'
import Settings from './components/Settings'
import Setup from './components/Setup'
import Login from './components/Login'
import './index.css'

function Sidebar({ onLogout }) {
  const location = useLocation()

  function isActive(path) {
    if (path === '/' && location.pathname === '/') return 'active'
    if (path !== '/' && location.pathname.startsWith(path)) return 'active'
    return ''
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <Link to="/" className="sidebar-brand">🤖 AgentPanel</Link>
      </div>
      <nav className="sidebar-nav">
        <Link to="/" className={`sidebar-link ${isActive('/')}`}>
          <span className="sidebar-icon">📊</span>
          <span>Dashboard</span>
        </Link>
        <Link to="/create" className={`sidebar-link ${isActive('/create')}`}>
          <span className="sidebar-icon">➕</span>
          <span>Create Agent</span>
        </Link>
        <Link to="/settings" className={`sidebar-link ${isActive('/settings')}`}>
          <span className="sidebar-icon">⚙️</span>
          <span>Settings</span>
        </Link>
      </nav>
      <div className="sidebar-footer">
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
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}

export default App

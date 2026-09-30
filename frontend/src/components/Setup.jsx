import { useState } from 'react'
import { setToken } from '../lib/auth'

function Setup({ onDone }) {
  // install.sh prints a link carrying the code, so the usual path is to
  // arrive with it already filled in.
  const [code, setCode] = useState(() => new URLSearchParams(window.location.search).get('setup') || '')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')

    if (password !== confirm) {
      setError('Passwords do not match')
      return
    }

    setLoading(true)
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, setupCode: code })
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Setup failed')
      }

      const data = await res.json()
      // The code is spent; keep it out of the address bar and the history.
      window.history.replaceState(null, '', window.location.pathname)
      setToken(data.token)
      onDone()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-container">
      <div className="auth-card">
        <h1 className="auth-title">AgentHotel</h1>
        <p className="auth-subtitle">Create your admin account</p>

        {error && <div className="error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Setup code</label>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Printed at the end of install"
              autoComplete="off"
              spellCheck="false"
              required
              style={{ fontFamily: 'monospace' }}
            />
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.3rem' }}>
              Only whoever installed the panel can create its admin. Lost it? Run <code>agenthotel setup-code</code> on the server.
            </div>
          </div>

          <div className="form-group">
            <label>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@example.com"
              required
            />
          </div>

          <div className="form-group">
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Min 8 characters"
              minLength={8}
              required
            />
          </div>

          <div className="form-group">
            <label>Confirm Password</label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Repeat password"
              required
            />
          </div>

          <button type="submit" className="btn btn-primary auth-btn" disabled={loading}>
            {loading ? 'Creating...' : 'Create Admin Account'}
          </button>
        </form>
      </div>
    </div>
  )
}

export default Setup

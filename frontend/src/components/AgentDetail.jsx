import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { authFetch, getToken } from '../lib/auth'

function AgentDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [agent, setAgent] = useState(null)
  const [logs, setLogs] = useState('')
  const [showTerminal, setShowTerminal] = useState(false)
  const terminalRef = useRef(null)
  const xtermRef = useRef(null)

  useEffect(() => {
    fetchAgent()
    fetchLogs()
  }, [id])

  async function fetchAgent() {
    try {
      const res = await authFetch(`/api/agents/${id}`)
      const data = await res.json()
      setAgent(data)
    } catch (err) {
      console.error('Failed to fetch agent:', err)
    }
  }

  async function fetchLogs() {
    try {
      const res = await authFetch(`/api/agents/${id}/logs?tail=100`)
      const text = await res.text()
      setLogs(text)
    } catch (err) {
      console.error('Failed to fetch logs:', err)
    }
  }

  async function handleRedeploy() {
    if (!confirm('Redeploy this agent?')) return
    
    try {
      await authFetch(`/api/agents/${id}/redeploy`, { method: 'POST' })
      fetchAgent()
      fetchLogs()
    } catch (err) {
      console.error('Failed to redeploy:', err)
    }
  }

  async function handleDelete() {
    if (!confirm('Delete this agent? This cannot be undone.')) return
    
    try {
      await authFetch(`/api/agents/${id}`, { method: 'DELETE' })
      navigate('/')
    } catch (err) {
      console.error('Failed to delete:', err)
    }
  }

  function toggleTerminal() {
    setShowTerminal(!showTerminal)
    if (!showTerminal && !xtermRef.current) {
      setTimeout(() => initTerminal(), 100)
    }
  }

  function initTerminal() {
    if (!terminalRef.current || xtermRef.current) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Monaco, Menlo, "Ubuntu Mono", monospace',
      theme: {
        background: '#0f172a',
        foreground: '#e2e8f0',
        cursor: '#3b82f6'
      }
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(terminalRef.current)
    fitAddon.fit()

    const token = getToken()
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/agents/${id}/terminal?token=${token}`)

    ws.onopen = () => {
      term.writeln('Connected to agent terminal\r\n')
    }

    ws.onmessage = (event) => {
      term.write(event.data)
    }

    ws.onclose = () => {
      term.writeln('\r\n\r\nDisconnected from terminal')
    }

    term.onData((data) => {
      ws.send(data)
    })

    xtermRef.current = { term, ws, fitAddon }

    window.addEventListener('resize', () => {
      fitAddon.fit()
    })
  }

  useEffect(() => {
    return () => {
      if (xtermRef.current) {
        xtermRef.current.ws.close()
        xtermRef.current.term.dispose()
      }
    }
  }, [])

  if (!agent) {
    return <div className="loading">Loading agent details...</div>
  }

  return (
    <div>
      <div className="agent-detail">
        <div className="agent-detail-header">
          <div>
            <h1>{agent.name}</h1>
            <div className={`agent-status status-${agent.status}`} style={{ display: 'inline-block', marginTop: '0.5rem' }}>
              {agent.status}
            </div>
          </div>
          <div className="agent-detail-actions">
            <button className="btn btn-secondary" onClick={toggleTerminal}>
              {showTerminal ? 'Hide Terminal' : 'Show Terminal'}
            </button>
            <button className="btn btn-primary" onClick={handleRedeploy}>
              Redeploy
            </button>
            <button className="btn btn-danger" onClick={handleDelete}>
              Delete
            </button>
          </div>
        </div>

        <div className="agent-detail-info">
          <div className="info-item">
            <div className="info-label">Runtime</div>
            <div className="info-value">{agent.runtime}</div>
          </div>
          <div className="info-item">
            <div className="info-label">Domain</div>
            <div className="info-value">{agent.domain || 'None'}</div>
          </div>
          <div className="info-item">
            <div className="info-label">Image</div>
            <div className="info-value">{agent.image}</div>
          </div>
          <div className="info-item">
            <div className="info-label">Port</div>
            <div className="info-value">{agent.port}</div>
          </div>
          <div className="info-item">
            <div className="info-label">Created</div>
            <div className="info-value">{new Date(agent.created_at).toLocaleString()}</div>
          </div>
          <div className="info-item">
            <div className="info-label">Updated</div>
            <div className="info-value">{new Date(agent.updated_at).toLocaleString()}</div>
          </div>
        </div>

        {showTerminal && (
          <div className="terminal-container">
            <div className="terminal-header">
              <h3>Terminal</h3>
            </div>
            <div ref={terminalRef} style={{ height: '400px' }}></div>
          </div>
        )}

        <div className="logs-container">
          <div className="logs-header">
            <h3>Logs</h3>
            <button className="btn btn-secondary" onClick={fetchLogs}>
              Refresh
            </button>
          </div>
          <div className="logs-content">{logs || 'No logs available'}</div>
        </div>
      </div>
    </div>
  )
}

export default AgentDetail

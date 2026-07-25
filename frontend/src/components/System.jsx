import { useState, useEffect, useRef } from 'react'
import { authFetch } from '../lib/auth'

function System() {
  const [systemInfo, setSystemInfo] = useState(null)
  const [systemStats, setSystemStats] = useState(null)
  const [mcpStatus, setMcpStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [confirmAction, setConfirmAction] = useState(null)
  const [consoleOutput, setConsoleOutput] = useState('')
  const [consoleCommand, setConsoleCommand] = useState('')
  const [consoleLoading, setConsoleLoading] = useState(false)
  const consoleRef = useRef(null)

  useEffect(() => {
    fetchSystemInfo()
    fetchSystemStats()
    fetchMcpStatus()
    const interval = setInterval(fetchSystemStats, 5000)
    return () => clearInterval(interval)
  }, [])

  async function fetchSystemInfo() {
    try {
      const res = await authFetch('/api/system/status')
      const data = await res.json()
      setSystemInfo(data)
    } catch (err) {
      console.error('Failed to fetch system info:', err)
    } finally {
      setLoading(false)
    }
  }

  async function fetchSystemStats() {
    try {
      const res = await authFetch('/api/system/stats')
      const data = await res.json()
      setSystemStats(data)
    } catch (err) {
      console.error('Failed to fetch system stats:', err)
    }
  }

  async function fetchMcpStatus() {
    try {
      const res = await authFetch('/api/system/mcp-status')
      const data = await res.json()
      setMcpStatus(data)
    } catch (err) {
      console.error('Failed to fetch MCP status:', err)
    }
  }

  async function enableMcp() {
    try {
      const res = await authFetch('/api/system/mcp-enable', { method: 'POST' })
      const data = await res.json()
      setMessage(data.message || 'MCP enabled')
      fetchMcpStatus()
    } catch (err) {
      setMessage('Error: ' + err.message)
    }
  }

  async function executeSystemAction(action) {
    try {
      const res = await authFetch(`/api/system/${action}`, { method: 'POST' })
      const data = await res.json()
      setMessage(data.message || 'Action executed')
      setConfirmAction(null)
    } catch (err) {
      setMessage('Error: ' + err.message)
    }
  }

  async function executeConsoleCommand(e) {
    e.preventDefault()
    if (!consoleCommand.trim()) return

    setConsoleLoading(true)
    setConsoleOutput(prev => prev + `\n$ ${consoleCommand}\n`)
    
    try {
      const res = await authFetch('/api/system/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: consoleCommand })
      })
      const data = await res.json()
      
      if (data.output) {
        setConsoleOutput(prev => prev + data.output + '\n')
      }
      if (data.error) {
        setConsoleOutput(prev => prev + 'Error: ' + data.error + '\n')
      }
    } catch (err) {
      setConsoleOutput(prev => prev + 'Error: ' + err.message + '\n')
    } finally {
      setConsoleLoading(false)
      setConsoleCommand('')
      if (consoleRef.current) {
        consoleRef.current.scrollTop = consoleRef.current.scrollHeight
      }
    }
  }

  if (loading) {
    return <div className="loading">Loading system information...</div>
  }

  return (
    <div>
      <h1 style={{ marginBottom: '2rem' }}>System</h1>

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

      {systemInfo && (
        <div style={{
          background: 'var(--bg-secondary, #1e293b)',
          borderRadius: '0.5rem',
          padding: '1.5rem',
          marginBottom: '2rem'
        }}>
          <h2 style={{ margin: '0 0 1rem 0', fontSize: '1.25rem' }}>🖥️ System Information</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary, #94a3b8)' }}>Hostname</div>
              <div style={{ fontSize: '1rem', fontWeight: '600' }}>{systemInfo.hostname}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary, #94a3b8)' }}>OS</div>
              <div style={{ fontSize: '1rem', fontWeight: '600' }}>{systemInfo.os}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary, #94a3b8)' }}>Kernel</div>
              <div style={{ fontSize: '1rem', fontWeight: '600' }}>{systemInfo.kernel}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary, #94a3b8)' }}>Uptime</div>
              <div style={{ fontSize: '1rem', fontWeight: '600' }}>{systemInfo.uptime}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary, #94a3b8)' }}>Docker</div>
              <div style={{ fontSize: '1rem', fontWeight: '600' }}>{systemInfo.dockerVersion}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary, #94a3b8)' }}>AgentPanel</div>
              <div style={{ fontSize: '1rem', fontWeight: '600' }}>{systemInfo.agentpanel.branch} ({systemInfo.agentpanel.commit})</div>
            </div>
          </div>
        </div>
      )}

      {systemStats && (
        <>
          <div style={{
            background: 'var(--bg-secondary, #1e293b)',
            borderRadius: '0.5rem',
            padding: '1.5rem',
            marginBottom: '2rem'
          }}>
            <h2 style={{ margin: '0 0 1rem 0', fontSize: '1.25rem' }}>📊 Resource Usage</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '1.5rem' }}>
              <div>
                <div style={{ fontSize: '0.875rem', marginBottom: '0.5rem', fontWeight: '600' }}>CPU</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary, #94a3b8)', marginBottom: '0.25rem' }}>
                  {systemStats.cpu.cores} cores @ {systemStats.cpu.frequency} MHz
                </div>
                <div style={{ 
                  background: 'var(--bg-primary, #0f172a)', 
                  borderRadius: '0.25rem', 
                  padding: '0.5rem',
                  fontSize: '0.875rem'
                }}>
                  Load: {systemStats.cpu.load.join(', ')}
                </div>
              </div>
              
              <div>
                <div style={{ fontSize: '0.875rem', marginBottom: '0.5rem', fontWeight: '600' }}>Memory</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary, #94a3b8)', marginBottom: '0.25rem' }}>
                  {systemStats.memory.used} / {systemStats.memory.total}
                </div>
                <div style={{ 
                  background: 'var(--bg-primary, #0f172a)', 
                  borderRadius: '0.25rem', 
                  height: '8px',
                  overflow: 'hidden'
                }}>
                  <div style={{ 
                    width: `${systemStats.memory.percent}%`,
                    height: '100%',
                    background: systemStats.memory.percent > 80 ? '#ef4444' : '#10b981',
                    transition: 'width 0.3s'
                  }} />
                </div>
                <div style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                  {systemStats.memory.percent}% used
                </div>
              </div>

              <div>
                <div style={{ fontSize: '0.875rem', marginBottom: '0.5rem', fontWeight: '600' }}>Disk</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary, #94a3b8)', marginBottom: '0.25rem' }}>
                  {systemStats.disk.used} / {systemStats.disk.total}
                </div>
                <div style={{ 
                  background: 'var(--bg-primary, #0f172a)', 
                  borderRadius: '0.25rem', 
                  height: '8px',
                  overflow: 'hidden'
                }}>
                  <div style={{ 
                    width: `${systemStats.disk.percent}%`,
                    height: '100%',
                    background: systemStats.disk.percent > 80 ? '#ef4444' : '#10b981',
                    transition: 'width 0.3s'
                  }} />
                </div>
                <div style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                  {systemStats.disk.percent}% used
                </div>
              </div>
            </div>
          </div>

          {systemStats.network && (
            <div style={{
              background: 'var(--bg-secondary, #1e293b)',
              borderRadius: '0.5rem',
              padding: '1.5rem',
              marginBottom: '2rem'
            }}>
              <h2 style={{ margin: '0 0 1rem 0', fontSize: '1.25rem' }}>🌐 Network</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
                {Object.entries(systemStats.network).map(([iface, info]) => (
                  <div key={iface} style={{ 
                    background: 'var(--bg-primary, #0f172a)', 
                    padding: '1rem', 
                    borderRadius: '0.25rem' 
                  }}>
                    <div style={{ fontSize: '0.875rem', fontWeight: '600', marginBottom: '0.5rem' }}>{iface}</div>
                    {info.ip && <div style={{ fontSize: '0.75rem' }}>IP: {info.ip}</div>}
                    {info.rx && <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary, #94a3b8)' }}>↓ {info.rx}</div>}
                    {info.tx && <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary, #94a3b8)' }}>↑ {info.tx}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {mcpStatus && (
        <div style={{
          background: 'var(--bg-secondary, #1e293b)',
          borderRadius: '0.5rem',
          padding: '1.5rem',
          marginBottom: '2rem'
        }}>
          <h2 style={{ margin: '0 0 1rem 0', fontSize: '1.25rem' }}>🔌 MCP Server</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary, #94a3b8)' }}>Status</div>
              <div style={{ 
                fontSize: '1rem', 
                fontWeight: '600',
                color: mcpStatus.running ? '#10b981' : mcpStatus.configured ? '#f59e0b' : '#ef4444'
              }}>
                {mcpStatus.running ? '● Running' : mcpStatus.configured ? '● Configured' : '● Not configured'}
              </div>
            </div>
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary, #94a3b8)' }}>Installed</div>
              <div style={{ fontSize: '1rem', fontWeight: '600' }}>
                {mcpStatus.installed ? 'Yes' : 'No'}
              </div>
            </div>
            {mcpStatus.endpoint && (
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary, #94a3b8)' }}>Endpoint</div>
                <div style={{ fontSize: '1rem', fontWeight: '600', fontFamily: 'monospace' }}>
                  {mcpStatus.endpoint}
                </div>
              </div>
            )}
            {mcpStatus.token && (
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary, #94a3b8)' }}>Token</div>
                <div style={{ fontSize: '1rem', fontWeight: '600', fontFamily: 'monospace' }}>
                  {mcpStatus.token}
                </div>
              </div>
            )}
          </div>
          {!mcpStatus.configured && (
            <button
              onClick={enableMcp}
              className="btn btn-primary"
              style={{ marginTop: '1rem' }}
            >
              Enable MCP
            </button>
          )}
          {mcpStatus.configured && (
            <div style={{
              marginTop: '1rem',
              padding: '1rem',
              background: 'var(--bg-primary, #0f172a)',
              borderRadius: '0.25rem',
              fontSize: '0.875rem'
            }}>
              <div style={{ marginBottom: '0.5rem', fontWeight: '600' }}>MCP Endpoint:</div>
              <code style={{ color: '#10b981' }}>https://{window.location.hostname}/mcp</code>
              <div style={{ marginTop: '1rem', marginBottom: '0.5rem', fontWeight: '600' }}>Available Tools:</div>
              <ul style={{ margin: 0, paddingLeft: '1.5rem', color: 'var(--text-secondary, #94a3b8)' }}>
                <li>list_agents - List all managed agents</li>
                <li>create_agent - Create new agent</li>
                <li>delete_agent - Remove agent</li>
                <li>redeploy_agent - Redeploy with latest image</li>
                <li>get_agent_logs - View agent logs</li>
                <li>system_status - System information</li>
                <li>list_runtimes - Available runtimes</li>
              </ul>
            </div>
          )}
        </div>
      )}

      <div style={{
        background: 'var(--bg-secondary, #1e293b)',
        borderRadius: '0.5rem',
        padding: '1.5rem',
        marginBottom: '2rem'
      }}>
        <h2 style={{ margin: '0 0 1rem 0', fontSize: '1.25rem' }}>💻 Console</h2>
        <div 
          ref={consoleRef}
          style={{
            background: '#000',
            color: '#0f0',
            fontFamily: 'monospace',
            fontSize: '0.875rem',
            padding: '1rem',
            borderRadius: '0.25rem',
            height: '300px',
            overflowY: 'auto',
            marginBottom: '1rem',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all'
          }}
        >
          {consoleOutput || 'Ready. Enter a command below.'}
        </div>
        <form onSubmit={executeConsoleCommand} style={{ display: 'flex', gap: '0.5rem' }}>
          <span style={{ color: 'var(--text-secondary, #94a3b8)', fontFamily: 'monospace' }}>$</span>
          <input
            type="text"
            value={consoleCommand}
            onChange={(e) => setConsoleCommand(e.target.value)}
            placeholder="Enter command..."
            disabled={consoleLoading}
            style={{
              flex: 1,
              fontFamily: 'monospace',
              background: 'var(--bg-primary, #0f172a)',
              color: 'var(--text-primary, #e2e8f0)',
              border: '1px solid var(--border, #334155)',
              borderRadius: '0.25rem',
              padding: '0.5rem'
            }}
          />
          <button type="submit" className="btn btn-primary" disabled={consoleLoading}>
            {consoleLoading ? 'Running...' : 'Run'}
          </button>
        </form>
      </div>

      <div style={{
        background: 'var(--bg-secondary, #1e293b)',
        borderRadius: '0.5rem',
        padding: '1.5rem',
        marginBottom: '2rem'
      }}>
        <h2 style={{ margin: '0 0 1.5rem 0', fontSize: '1.25rem' }}>🔧 System Controls</h2>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
          <button
            className="btn btn-secondary"
            onClick={() => setConfirmAction('restart-panel')}
            style={{ background: '#3b82f6', color: 'white' }}
          >
            🔄 Restart AgentPanel
          </button>

          <button
            className="btn btn-secondary"
            onClick={() => setConfirmAction('restart-docker')}
            style={{ background: '#f59e0b', color: 'white' }}
          >
            🐳 Restart Docker
          </button>

          <button
            className="btn btn-secondary"
            onClick={() => setConfirmAction('update')}
            style={{ background: '#10b981', color: 'white' }}
          >
            ⬆️ Update AgentPanel
          </button>

          <button
            className="btn btn-danger"
            onClick={() => setConfirmAction('reboot')}
          >
            ⚠️ Reboot Server
          </button>
        </div>
      </div>

      {confirmAction && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.7)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000
        }}>
          <div style={{
            background: 'var(--bg-primary, #0f172a)',
            borderRadius: '0.5rem',
            padding: '2rem',
            maxWidth: '500px',
            border: '1px solid var(--border, #334155)'
          }}>
            <h3 style={{ margin: '0 0 1rem 0' }}>Confirm Action</h3>
            <p style={{ marginBottom: '1.5rem' }}>
              {confirmAction === 'restart-panel' && 'Are you sure you want to restart AgentPanel? This will briefly interrupt service.'}
              {confirmAction === 'restart-docker' && 'Are you sure you want to restart Docker? All containers will be affected.'}
              {confirmAction === 'update' && 'Are you sure you want to update AgentPanel to the latest version?'}
              {confirmAction === 'reboot' && '⚠️ WARNING: This will reboot the entire server. All services will be interrupted.'}
            </p>
            <div style={{ display: 'flex', gap: '1rem' }}>
              <button
                className="btn btn-primary"
                onClick={() => executeSystemAction(confirmAction)}
              >
                Confirm
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => setConfirmAction(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default System

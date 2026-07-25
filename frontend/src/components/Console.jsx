import { useState, useRef, useEffect } from 'react'
import { authFetch } from '../lib/auth'

function Console() {
  const [output, setOutput] = useState('')
  const [command, setCommand] = useState('')
  const [loading, setLoading] = useState(false)
  const outputRef = useRef(null)

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [output])

  async function executeCommand(e) {
    e.preventDefault()
    if (!command.trim()) return

    setLoading(true)
    setOutput(prev => prev + `$ ${command}\n`)

    try {
      const res = await authFetch('/api/console/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command })
      })
      const data = await res.json()
      
      if (data.output) {
        setOutput(prev => prev + data.output + '\n')
      }
      
      if (!data.success) {
        setOutput(prev => prev + `[Error: ${data.error}]\n`)
      }
    } catch (err) {
      setOutput(prev => prev + `[Error: ${err.message}]\n`)
    } finally {
      setLoading(false)
      setCommand('')
    }
  }

  function clearOutput() {
    setOutput('')
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h1>Server Console</h1>
        <button className="btn btn-secondary" onClick={clearOutput}>
          Clear
        </button>
      </div>

      <div style={{
        background: '#0f172a',
        borderRadius: '0.5rem',
        padding: '1rem',
        marginBottom: '1rem',
        fontFamily: 'monospace',
        fontSize: '0.875rem',
        color: '#e2e8f0',
        minHeight: '400px',
        maxHeight: '600px',
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word'
      }} ref={outputRef}>
        {output || 'Welcome to AgentPanel Console. Type commands below to execute on the server.'}
      </div>

      <form onSubmit={executeCommand} style={{ display: 'flex', gap: '0.5rem' }}>
        <span style={{ color: '#10b981', fontFamily: 'monospace', fontSize: '1rem' }}>$</span>
        <input
          type="text"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="Enter command..."
          disabled={loading}
          style={{
            flex: 1,
            background: 'var(--bg-secondary, #1e293b)',
            border: '1px solid var(--border, #334155)',
            borderRadius: '0.25rem',
            padding: '0.5rem',
            fontFamily: 'monospace',
            fontSize: '0.875rem',
            color: 'var(--text-primary, #e2e8f0)'
          }}
        />
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? 'Executing...' : 'Execute'}
        </button>
      </form>

      <div style={{
        marginTop: '1rem',
        padding: '1rem',
        background: 'var(--bg-secondary, #1e293b)',
        borderRadius: '0.5rem',
        fontSize: '0.875rem',
        color: 'var(--text-secondary, #94a3b8)'
      }}>
        <strong>Common commands:</strong>
        <ul style={{ margin: '0.5rem 0 0 1.5rem', padding: 0 }}>
          <li><code>docker ps</code> - List running containers</li>
          <li><code>docker images</code> - List Docker images</li>
          <li><code>df -h</code> - Disk usage</li>
          <li><code>free -h</code> - Memory usage</li>
          <li><code>top -bn1 | head -20</code> - Top processes</li>
        </ul>
      </div>
    </div>
  )
}

export default Console

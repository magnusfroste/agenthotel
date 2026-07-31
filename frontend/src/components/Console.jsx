import TerminalPanel from './TerminalPanel'

function Console() {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h1>Server Console</h1>
      </div>

      <div style={{ borderRadius: '0.5rem', overflow: 'hidden', marginBottom: '1rem' }}>
        <TerminalPanel wsPath="/api/system/host-terminal" banner="Connecting to host…" height="60vh" />
      </div>

      <div style={{
        padding: '1rem',
        background: 'var(--bg-secondary, #1e293b)',
        borderRadius: '0.5rem',
        fontSize: '0.875rem',
        color: 'var(--text-secondary, #94a3b8)'
      }}>
        <strong>Common commands</strong> (run on the host):
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

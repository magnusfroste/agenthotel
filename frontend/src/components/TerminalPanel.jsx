import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { getToken } from '../lib/auth'

function TerminalPanel({ agentId, wsPath, banner = 'Connecting to container…', height = '55vh' }) {
  const containerRef = useRef(null)
  const instRef = useRef(null)

  useEffect(() => {
    if (!containerRef.current) return
    let disposed = false

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, monospace',
      theme: { background: '#0f172a', foreground: '#e2e8f0', cursor: '#3b82f6' }
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)
    try { fitAddon.fit() } catch (_) {}

    const token = getToken()
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const path = wsPath || `/api/agents/${agentId}/terminal`
    const ws = new WebSocket(`${proto}//${window.location.host}${path}?token=${token}`)

    ws.onopen = () => term.writeln(banner + '\r')
    ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : '')
    ws.onclose = () => { if (!disposed) term.writeln('\r\n\x1b[33mDisconnected from terminal\x1b[0m') }
    ws.onerror = () => { if (!disposed) term.writeln('\r\n\x1b[31mConnection error\x1b[0m') }
    term.onData((d) => { if (ws.readyState === WebSocket.OPEN) ws.send(d) })

    const onResize = () => { try { fitAddon.fit() } catch (_) {} }
    window.addEventListener('resize', onResize)

    instRef.current = { term, ws, fitAddon, onResize }

    return () => {
      disposed = true
      window.removeEventListener('resize', onResize)
      try { ws.close() } catch (_) {}
      try { term.dispose() } catch (_) {}
      instRef.current = null
    }
  }, [agentId, wsPath, banner])

  return <div ref={containerRef} style={{ height, background: '#0f172a' }} />
}

export default TerminalPanel

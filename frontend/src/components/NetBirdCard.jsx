import { useState, useEffect } from 'react'
import { Network, Power } from 'lucide-react'
import { authFetch } from '../lib/auth'
import { useToast } from './Toast'

// NetBird (backend/lib/netbird.js): the hotel as a peer on a WireGuard mesh —
// a front door through NetBird's reverse proxy, NetBird Cloud by default or a
// self-hosted management server, and a private way in for the operator.
export default function NetBirdCard() {
  const toast = useToast()
  const [status, setStatus] = useState(null)
  const [setupKey, setSetupKey] = useState('')
  const [selfHosted, setSelfHosted] = useState(false)
  const [managementUrl, setManagementUrl] = useState('')
  const [busy, setBusy] = useState(false)

  async function refresh() {
    try {
      const res = await authFetch('/api/system/netbird')
      const data = await res.json()
      setStatus(data)
      if (data.selfHosted) { setSelfHosted(true); setManagementUrl(m => m || data.managementUrl) }
    } catch (_) { /* card stays as it was */ }
  }

  useEffect(() => {
    refresh()
    const t = setInterval(() => { if (!document.hidden) refresh() }, 10000)
    return () => clearInterval(t)
  }, [])

  async function start() {
    setBusy(true)
    try {
      const res = await authFetch('/api/system/netbird', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setupKey, managementUrl: selfHosted ? managementUrl : '' })
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error || 'Could not start NetBird'); return }
      setSetupKey('')
      toast.success(`NetBird starting as ${data.hostname} — it shows as connected within a few seconds`)
      setTimeout(refresh, 4000)
    } catch (_) {
      toast.error('Could not start NetBird')
    } finally {
      setBusy(false)
    }
  }

  async function stop(forget) {
    if (forget && !confirm('Stop NetBird and forget its setup key and identity? This hotel leaves the mesh; starting again needs a new setup key.')) return
    setBusy(true)
    try {
      await authFetch(`/api/system/netbird${forget ? '?forget=1' : ''}`, { method: 'DELETE' })
      toast.success(forget ? 'NetBird stopped and forgotten' : 'NetBird stopped')
      refresh()
    } catch (_) {
      toast.error('Could not stop NetBird')
    } finally {
      setBusy(false)
    }
  }

  if (!status) return null
  const color = status.connected ? 'var(--accent-green)'
    : status.running ? 'var(--accent-yellow)'
    : status.configured ? 'var(--accent-yellow)' : 'var(--accent-red)'
  const label = status.connected ? '● Connected'
    : status.running ? `● Starting${status.daemonStatus ? ` (${status.daemonStatus})` : ''}`
    : status.configured ? '● Configured, not running' : '● Not configured'

  return (
    <section className="settings-section">
      <div className="section-header">
        <h2><Network size={20} /> NetBird</h2>
      </div>
      <p className="section-hint">
        A European front door, and a private network for the hotel. NetBird (Berlin, open
        source) puts this host on a WireGuard mesh: reach the panel and every guest from your
        own devices without open ports, and publish public hostnames through NetBird's reverse
        proxy — in NetBird Cloud (free for up to 5 users and 100 machines) or on your own
        NetBird server. Caddy still routes every guest; NetBird just points at it.
      </p>

      <div className="sysinfo-grid">
        <div className="sysinfo-item"><div>
          <div className="sysinfo-label">Status</div>
          <div className="sysinfo-value" style={{ color }}>{label}</div>
        </div></div>
        {status.ip && (
          <div className="sysinfo-item"><div>
            <div className="sysinfo-label">Mesh address</div>
            <div className="sysinfo-value text-mono">{status.ip}{status.fqdn ? ` · ${status.fqdn}` : ''}</div>
          </div></div>
        )}
        <div className="sysinfo-item"><div>
          <div className="sysinfo-label">Point reverse-proxy services at</div>
          <div className="sysinfo-value text-mono">{status.hostname || 'this peer'} · port {status.originPort} · HTTP</div>
        </div></div>
        <div className="sysinfo-item"><div>
          <div className="sysinfo-label">Management</div>
          <div className="sysinfo-value text-mono">{status.selfHosted ? status.managementUrl : 'NetBird Cloud'}</div>
        </div></div>
        {status.peers && (
          <div className="sysinfo-item"><div>
            <div className="sysinfo-label">Peers</div>
            <div className="sysinfo-value">{status.peers.connected} of {status.peers.total} connected</div>
          </div></div>
        )}
        {status.setupKey && (
          <div className="sysinfo-item"><div>
            <div className="sysinfo-label">Setup key</div>
            <div data-secret="" className="sysinfo-value text-mono">{status.setupKey}</div>
          </div></div>
        )}
      </div>

      {!status.connected && status.error && (
        <p className="section-hint" style={{ color: 'var(--accent-red)', marginTop: '0.75rem' }}>{status.error}</p>
      )}

      {!status.running && (
        <div style={{ marginTop: '1rem', display: 'grid', gap: '0.6rem', maxWidth: '520px' }}>
          <input data-secret="" type="password" className="input"
            placeholder={status.configured ? 'Stored setup key in use — paste a new one to replace it' : 'NetBird setup key'}
            value={setupKey} onChange={e => setSetupKey(e.target.value)} />
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontSize: '0.85rem' }}>
            <input type="checkbox" checked={selfHosted} onChange={e => setSelfHosted(e.target.checked)} />
            My own NetBird server (self-hosted)
          </label>
          {selfHosted && (
            <input className="input" placeholder="https://netbird.example.com" value={managementUrl}
              onChange={e => setManagementUrl(e.target.value)} />
          )}
        </div>
      )}

      <div className="section-actions" style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        {status.running ? (
          <button className="btn btn-secondary" onClick={() => stop(false)} disabled={busy}>
            <Power size={15} /> {busy ? 'Stopping…' : 'Stop NetBird'}
          </button>
        ) : (
          <button className="btn btn-primary" onClick={start}
            disabled={busy || (!setupKey && !status.configured) || (selfHosted && !managementUrl.trim())}>
            <Network size={15} /> {busy ? 'Starting…' : 'Join the mesh'}
          </button>
        )}
        {status.configured && (
          <button className="btn btn-secondary" onClick={() => stop(true)} disabled={busy}>Leave and forget</button>
        )}
      </div>

      {status.logs && (
        <pre data-secret="" className="log-tail" style={{ marginTop: '1rem', maxHeight: '180px', overflow: 'auto' }}>{status.logs}</pre>
      )}

      <p className="section-hint" style={{ marginTop: '0.75rem' }}>
        Create a setup key in NetBird (Setup Keys → reusable off, one peer). To publish a
        hostname, add a Reverse Proxy service in NetBird with this peer as the target, port{' '}
        <span className="text-mono">{status.originPort}</span>, HTTP — one per guest, as with
        a tunnel — and turn on <strong>Pass Host Header</strong> under Advanced Settings, or
        Caddy never sees the name. The guest needs its domain set here, which is what creates
        its route; for the panel itself, add the name on Domains → Also answers on.
      </p>
    </section>
  )
}

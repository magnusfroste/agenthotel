import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { HardDrive, RefreshCw } from 'lucide-react'
import { authFetch } from '../lib/auth'

// Where the disk goes, per agent (GET /api/system/disk, lib/diskUsage.js).
// An agent's total is what it alone holds: its volumes (its memory, files,
// databases) and its container's writable layer. The image it runs is shown
// beside it, not added in: images share layers, so their sizes overlap, and
// Docker's image layers are given once, at the bottom, counted once each.

const gb = (bytes) => {
  if (!bytes) return '0'
  if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

export default function DiskByAgent() {
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  async function load(refresh = false) {
    setLoading(true); setError(null)
    try {
      const res = await authFetch(`/api/system/disk${refresh ? '?refresh=1' : ''}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not measure the disk')
      setReport(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const host = report?.host
  const free = host ? host.total - host.used : 0
  const max = report ? Math.max(1, ...report.agents.map(a => a.total)) : 1

  return (
    <section className="settings-section">
      <div className="section-header">
        <h2><HardDrive size={20} /> Disk by agent</h2>
        <button className="btn btn-secondary" onClick={() => load(true)} disabled={loading}>
          <RefreshCw size={15} /> {loading ? 'Measuring…' : 'Measure again'}
        </button>
      </div>
      <p className="section-description">
        What each agent holds on this server: its data (volumes — memory, files, databases) and
        its container. The image it runs is listed beside it; images share layers, so they are
        counted once, in Docker's line below.
        {host && <> {gb(host.used)} of {gb(host.total)} used, <strong>{gb(free)} free</strong>.</>}
      </p>

      {error && <div className="table-empty" style={{ color: 'var(--accent-red)' }}>{error}</div>}
      {!report && !error && <div className="table-empty">Measuring — this takes a few seconds on a full disk…</div>}

      {report && (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th className="num">Data</th>
                <th className="num">Container</th>
                <th className="num">Holds</th>
                <th>Image</th>
              </tr>
            </thead>
            <tbody>
              {report.agents.map(a => (
                <tr key={a.id}>
                  <td>
                    <Link to={`/agent/${a.id}`}>{a.name}</Link>
                    <div style={{ height: 4, marginTop: 6, borderRadius: 2, background: 'var(--border)' }}>
                      <div style={{ height: 4, borderRadius: 2, width: `${Math.round((a.total / max) * 100)}%`, background: 'var(--accent-blue)' }} />
                    </div>
                  </td>
                  <td className="num" title={a.volumes.map(v => `${v.name}: ${gb(v.size)}`).join('\n')}>{gb(a.data)}</td>
                  <td className="num">{gb(a.container)}</td>
                  <td className="num"><strong>{gb(a.total)}</strong></td>
                  <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    {a.image ? <>
                      <span className="text-mono">{a.image.tag}</span> · {gb(a.image.size)}
                      {a.image.sharedWith > 0 && <> · shared with {a.image.sharedWith} other{a.image.sharedWith > 1 ? 's' : ''}</>}
                    </> : 'not running'}
                  </td>
                </tr>
              ))}
              <tr>
                <td>The panel <span style={{ color: 'var(--text-secondary)' }}>(and its front doors)</span></td>
                <td className="num">{gb(report.panel.data)}</td>
                <td className="num">{gb(report.panel.containers)}</td>
                <td className="num"><strong>{gb(report.panel.total)}</strong></td>
                <td />
              </tr>
              {(report.other.volumes > 0 || report.other.containers > 0) && (
                <tr>
                  <td>Nobody's <span style={{ color: 'var(--text-secondary)' }}>— {report.other.volumeCount} volume{report.other.volumeCount === 1 ? '' : 's'} and containers no agent owns</span></td>
                  <td className="num">{gb(report.other.volumes)}</td>
                  <td className="num">{gb(report.other.containers)}</td>
                  <td className="num"><strong>{gb(report.other.volumes + report.other.containers)}</strong></td>
                  <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Orphaned volumes are listed below</td>
                </tr>
              )}
              <tr>
                <td>Docker images and layers <span style={{ color: 'var(--text-secondary)' }}>— every layer once, {report.unusedImages.count} image{report.unusedImages.count === 1 ? '' : 's'} nothing runs</span></td>
                <td /><td />
                <td className="num"><strong>{gb(report.layersSize)}</strong></td>
                <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Includes a week of build cache, kept so Git Apps rebuild fast</td>
              </tr>
              {report.buildCache > 0 && (
                <tr>
                  <td>BuildKit cache</td>
                  <td /><td />
                  <td className="num"><strong>{gb(report.buildCache)}</strong></td>
                  <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Freed by Run Cleanup Now</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {report?.measuredAt && (
        <p className="section-description" style={{ marginTop: '0.5rem' }}>
          Measured {new Date(report.measuredAt).toLocaleTimeString()}.
        </p>
      )}
    </section>
  )
}

import { useState, useEffect } from 'react'
import { authFetch, authFetchOk } from '../lib/auth'
import { useToast } from './Toast'
import { Archive, Save, Play, CloudUpload, RotateCcw, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react'

// Nightly backups of every guest's memory (backend/lib/backups.js): the
// schedule, how many to keep, an optional S3 bucket, and each guest's backups
// on this host with a Restore button. The S3 secret is write-only here: the
// server says whether one is stored and its last four characters.

const mb = bytes => (bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(1)} GB` : `${Math.max(0.1, bytes / 1048576).toFixed(1)} MB`)
const when = stamp => new Date(stamp.replace(/T(\d\d)-(\d\d)-(\d\d)Z$/, 'T$1:$2:$3Z')).toLocaleString()

export default function BackupsCard() {
  const toast = useToast()
  const [data, setData] = useState(null)
  const [form, setForm] = useState(null)
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState('')

  async function load() {
    try {
      const res = await authFetch('/api/backups')
      if (!res.ok) return
      const d = await res.json()
      setData(d)
      setForm(f => f || { enabled: d.settings.enabled, hour: d.settings.hour, keepLocal: d.settings.keepLocal, keepRemote: d.settings.keepRemote, s3: { ...d.settings.s3 } })
    } catch (e) { /* next poll */ }
  }
  useEffect(() => {
    load()
    const t = setInterval(() => { if (!document.hidden) load() }, 10000)
    return () => clearInterval(t)
  }, [])

  if (!data || !form) return null
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const setS3 = (k, v) => setForm(f => ({ ...f, s3: { ...f.s3, [k]: v } }))

  async function save() {
    setBusy('save')
    try {
      const res = await authFetchOk('/api/backups/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, s3: { ...form.s3, secretKey: secret || undefined } })
      })
      const view = await res.json()
      setForm({ enabled: view.enabled, hour: view.hour, keepLocal: view.keepLocal, keepRemote: view.keepRemote, s3: { ...view.s3 } })
      setSecret('')
      toast.success('Backup settings saved')
      load()
    } catch (err) { toast.error(err.message) } finally { setBusy('') }
  }

  async function test() {
    setBusy('test')
    try {
      await authFetchOk('/api/backups/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ s3: { ...form.s3, secretKey: secret || undefined } }) })
      toast.success('The bucket works: a test file was written and removed')
    } catch (err) { toast.error(`S3: ${err.message}`) } finally { setBusy('') }
  }

  async function runNow() {
    setBusy('run')
    try { await authFetchOk('/api/backups/run', { method: 'POST' }); toast.success('Backup started'); setTimeout(load, 1500) }
    catch (err) { toast.error(err.message) } finally { setBusy('') }
  }

  async function restore(guest, b) {
    if (!confirm(`Restore ${guest.name} from ${when(b.stamp)}?\n\nIts current state is backed up first, then it is stopped, its volumes are replaced by the backup's, and it is started again.`)) return
    setBusy(`restore:${guest.name}`)
    try {
      const res = await authFetchOk(`/api/agents/${guest.agentId}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stamp: b.stamp }) })
      const r = await res.json()
      toast.success(`${guest.name} restored (${r.volumes} volume(s)). The state before is kept as a backup.`)
      load()
    } catch (err) { toast.error(`Restore failed: ${err.message}`) } finally { setBusy('') }
  }

  const s3 = form.s3
  const last = data.last
  const problems = last ? last.results.filter(r => !r.ok || (r.s3 && r.s3 !== 'uploaded')) : []

  return (
    <section className="settings-section">
      <div className="section-header">
        <h2><Archive size={20} /> Backups</h2>
        <button type="button" className="btn btn-secondary" onClick={runNow} disabled={data.running || busy === 'run'}
          style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          {data.running ? <Loader2 size={15} className="spin" /> : <Play size={15} />} {data.running ? `Backing up ${data.current || ''}…` : 'Back up now'}
        </button>
      </div>
      <p className="section-description">
        Every guest's memory, every night: its volumes, copied while its containers are paused for a few seconds, and its settings.
        The newest stay on this server; with an S3 bucket (Hetzner Object Storage, Cloudflare R2, Backblaze, MinIO) each backup is copied off it too.
        Backups include the guests' environment, API keys too, so keep the bucket private.
      </p>

      {last && (
        <div className="form-help" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '1rem', color: problems.length ? 'var(--accent-yellow)' : 'var(--text-secondary)' }}>
          {problems.length ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} color="var(--accent-green)" />}
          Last run {new Date(last.at).toLocaleString()} ({last.trigger}, {last.seconds}s): {last.results.filter(r => r.ok).length} of {last.results.length} guests{last.s3 ? ', copied to S3' : ''}
          {problems.length > 0 && ` — ${problems.map(r => `${r.name}: ${r.error || r.s3}`).join('; ')}`}
        </div>
      )}

      <div className="form-group" style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
          <input type="checkbox" checked={form.enabled} onChange={e => set('enabled', e.target.checked)} style={{ width: 'auto' }} /> Back up every night
        </label>
        <div><label className="form-label">At (UTC)</label>
          <select className="form-input" value={form.hour} onChange={e => set('hour', parseInt(e.target.value, 10))}>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
          </select></div>
        <div><label className="form-label">Keep on this server</label>
          <input className="form-input" type="number" min="1" value={form.keepLocal} onChange={e => set('keepLocal', e.target.value)} style={{ width: '6rem' }} /></div>
        <div><label className="form-label">Keep in S3</label>
          <input className="form-input" type="number" min="1" value={form.keepRemote} onChange={e => set('keepRemote', e.target.value)} style={{ width: '6rem' }} /></div>
      </div>

      <h3 style={{ fontSize: '0.95rem', margin: '1.25rem 0 0.75rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}><CloudUpload size={16} /> S3 bucket (optional)</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0 1rem' }}>
        <div className="form-group"><label className="form-label">Endpoint</label>
          <input className="form-input" placeholder="fsn1.your-objectstorage.com" value={s3.endpoint} onChange={e => setS3('endpoint', e.target.value)} /></div>
        <div className="form-group"><label className="form-label">Bucket</label>
          <input className="form-input" placeholder="agenthotel-backups" value={s3.bucket} onChange={e => setS3('bucket', e.target.value)} /></div>
        <div className="form-group"><label className="form-label">Region</label>
          <input className="form-input" placeholder="fsn1 (or auto)" value={s3.region} onChange={e => setS3('region', e.target.value)} /></div>
        <div className="form-group"><label className="form-label">Folder in the bucket</label>
          <input className="form-input" placeholder="agenthotel" value={s3.prefix} onChange={e => setS3('prefix', e.target.value)} /></div>
        <div className="form-group"><label className="form-label">Access key</label>
          <input className="form-input" data-secret="" value={s3.accessKey} onChange={e => setS3('accessKey', e.target.value)} /></div>
        <div className="form-group"><label className="form-label">Secret key</label>
          <input className="form-input" data-secret="" type="password" autoComplete="new-password" value={secret} onChange={e => setSecret(e.target.value)}
            placeholder={s3.secretSet ? `stored, ends in ${s3.secretLast4}` : ''} />
          <div className="form-help">Left empty, the stored secret is kept.</div></div>
      </div>
      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem' }}>
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy === 'save'} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}><Save size={15} /> Save</button>
        <button type="button" className="btn btn-secondary" onClick={test} disabled={busy === 'test'} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          {busy === 'test' ? <Loader2 size={15} className="spin" /> : <CloudUpload size={15} />} Test bucket</button>
      </div>

      <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.75rem' }}>On this server</h3>
      {data.guests.every(g => g.backups.length === 0) && <div className="form-help">No backups yet. Back up now, or turn on the nightly run.</div>}
      {data.guests.filter(g => g.backups.length > 0).map(g => (
        <div key={g.name} style={{ marginBottom: '0.9rem' }}>
          <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: '0.3rem' }}>{g.name}{!g.agentId && <span className="form-help" style={{ fontWeight: 400 }}> · no longer a guest here</span>}</div>
          {g.backups.map(b => (
            <div key={b.stamp} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', fontSize: '0.85rem', padding: '0.25rem 0', borderBottom: '1px solid var(--border)' }}>
              <span>{when(b.stamp)}</span>
              <span style={{ color: 'var(--text-secondary)', marginLeft: 'auto' }}>{mb(b.bytes)} · {b.files.filter(f => f.endsWith('.tar.gz')).length} volume(s)</span>
              {g.agentId && (
                <button type="button" className="btn btn-secondary" disabled={!!busy || data.running} onClick={() => restore(g, b)}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem', padding: '0.2rem 0.6rem' }}>
                  {busy === `restore:${g.name}` ? <Loader2 size={13} className="spin" /> : <RotateCcw size={13} />} Restore
                </button>
              )}
            </div>
          ))}
        </div>
      ))}
    </section>
  )
}

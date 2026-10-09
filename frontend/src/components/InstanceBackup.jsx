import { useState } from 'react'
import { authFetch } from '../lib/auth'
import { useToast } from './Toast'
import { Database, Download, Upload } from 'lucide-react'

// Moving this instance to another VPS: export here, import there. It lives on
// System — it is about the installation, not a preference.
export default function InstanceBackup() {
  const [importing, setImporting] = useState(false)
  const toast = useToast()

  async function handleExport() {
    try {
      const res = await authFetch('/api/system/export')
      if (!res.ok) throw new Error('Export failed')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `agenthotel-export-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      toast.success('Export downloaded — store it safely, it contains API keys')
    } catch (err) {
      toast.error('Export failed: ' + err.message)
    }
  }

  async function handleImport(e) {
    const file = e.target.files && e.target.files[0]
    if (!file) return
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      if (!confirm(`Import ${data.agents?.length || 0} agents and ${data.providers?.length || 0} providers from "${file.name}"? Existing entries with the same name are kept.`)) return
      setImporting(true)
      const res = await authFetch('/api/system/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: text
      })
      const result = await res.json()
      if (!res.ok) throw new Error(result.error || 'Import failed')
      toast.success(`Import done: ${result.agents.imported} agents added (${result.agents.skipped} skipped), ${result.providers.imported} providers added (${result.providers.skipped} skipped)`)
    } catch (err) {
      toast.error('Import failed: ' + err.message)
    } finally {
      setImporting(false)
      e.target.value = ''
    }
  }

  return (
    <section className="settings-section">
      <div className="section-header">
        <h2><Database size={20} /> Backup and migration</h2>
      </div>
      <p className="section-description">
        Move this instance to another VPS: export here, import on the new AgentHotel instance.
        Agents, providers (including API keys) and panel settings are included — admin credentials are never exported.
      </p>
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
        <button type="button" className="btn btn-secondary" onClick={handleExport} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Download size={18} /> Export instance
        </button>
        <label className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: importing ? 'wait' : 'pointer', opacity: importing ? 0.6 : 1, margin: 0 }}>
          <Upload size={18} /> {importing ? 'Importing…' : 'Import instance'}
          <input type="file" accept="application/json,.json" onChange={handleImport} disabled={importing} style={{ display: 'none' }} />
        </label>
      </div>
      <div className="form-help">
        The export file contains provider API keys in plain text — store it safely.
        Imported agents start as stopped; redeploy them from the dashboard. Existing agents are kept (matched on name/domain); existing providers are kept (matched on name).
      </div>
    </section>
  )
}

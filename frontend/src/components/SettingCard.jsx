import { useState, useEffect } from 'react'
import { authFetch } from '../lib/auth'
import { useToast } from './Toast'
import { Save, RotateCcw, AlertCircle } from 'lucide-react'

// A card of panel settings that lives on the page it belongs to — the panel
// domain on Domains, the certificate e-mail on Certificates, the Docker
// network on System — and saves only its own keys. The Settings page used to
// hold all of them, and is now only your own choices (security,
// notifications).
//
// fields: [{ name, label, help, type, placeholder, fallback, secret }]
export default function SettingCard({ title, icon: Icon, description, fields }) {
  const [values, setValues] = useState(null)
  const [original, setOriginal] = useState(null)
  const [saving, setSaving] = useState(false)
  const toast = useToast()

  useEffect(() => {
    authFetch('/api/settings')
      .then(r => r.json())
      .then(all => {
        // An unset key shows its default, as the old Settings page did.
        const mine = Object.fromEntries(fields.map(f => [f.name, all[f.name] ?? (f.fallback ?? '')]))
        setValues(mine)
        setOriginal(mine)
      })
      .catch(() => toast.error(`Could not load ${title.toLowerCase()}`))
  }, [])

  if (!values) return null
  const changed = JSON.stringify(values) !== JSON.stringify(original)

  async function save() {
    setSaving(true)
    try {
      const res = await authFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      })
      if (!res.ok) throw new Error('Saving failed')
      setOriginal(values)
      toast.success(`${title} saved`)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="settings-section">
      <div className="section-header">
        <h2>{Icon && <Icon size={20} />} {title}</h2>
      </div>
      {description && <p className="section-description">{description}</p>}
      {fields.map(({ name, label, help, type = 'text', placeholder, secret = false }) => (
        <div className="form-group" key={name}>
          <label className="form-label" htmlFor={`setting-${name}`}>{label}</label>
          <input id={`setting-${name}`} className="form-input" data-secret={secret ? '' : undefined}
            type={type} name={name} placeholder={placeholder}
            value={values[name]}
            onChange={e => setValues(v => ({ ...v, [name]: e.target.value }))} />
          {help && <div className="form-help">{help}</div>}
        </div>
      ))}
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
        <button type="button" className="btn btn-primary" disabled={saving || !changed} onClick={save}
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', opacity: (!changed || saving) ? 0.6 : 1 }}>
          <Save size={16} /> {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn btn-secondary" disabled={!changed} onClick={() => setValues(original)}
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', opacity: !changed ? 0.6 : 1 }}>
          <RotateCcw size={16} /> Reset
        </button>
        {changed && (
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--accent-yellow)', fontSize: '0.875rem' }}>
            <AlertCircle size={16} /> Unsaved changes
          </span>
        )}
      </div>
    </section>
  )
}

import { useState } from 'react'
import { templateIcon } from '../lib/templateIcons'

// A runtime's mark: its real upstream logo when the template ships one,
// otherwise the Lucide icon. Logo files are bundled under public/logos, so no
// third-party request leaves the panel and it still renders offline.
//
// A broken or missing file must never leave a blank tile, so a failed load
// falls back to the icon at runtime too.
function RuntimeMark({ meta, size = 34, iconSize = 19 }) {
  const [failed, setFailed] = useState(false)
  if (!meta) return null
  const Icon = templateIcon(meta.icon)
  const showLogo = meta.logo && !failed
  return (
    <div
      title={meta.name || ''}
      style={{
        width: size, height: size, borderRadius: '0.5rem',
        // Logos carry their own colours, so they sit on a neutral tile; the
        // fallback icon needs the runtime colour to stay distinguishable.
        background: showLogo ? 'var(--bg-tertiary)' : meta.color,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0, overflow: 'hidden'
      }}
    >
      {showLogo ? (
        <img
          src={meta.logo}
          alt=""
          onError={() => setFailed(true)}
          style={{ width: '78%', height: '78%', objectFit: 'contain' }}
        />
      ) : (
        <Icon size={iconSize} color="white" />
      )}
    </div>
  )
}

export default RuntimeMark

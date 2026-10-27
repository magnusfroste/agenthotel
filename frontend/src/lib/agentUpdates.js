import { useEffect, useState } from 'react'
import { authFetch } from './auth'

// Which agents could be updated (GET /api/agents/updates), shared by the Fleet
// and the sidebar so the page asks once. The server caches for a quarter of
// an hour; here a fresh look every five minutes is plenty.
const REFRESH_MS = 5 * 60 * 1000
let cached = null
let at = 0
let pending = null
const listeners = new Set()

async function load() {
  if (pending) return pending
  pending = authFetch('/api/agents/updates')
    .then(r => (r.ok ? r.json() : null))
    .then(data => {
      if (data && data.agents) { cached = data.agents; at = Date.now(); listeners.forEach(fn => fn(cached)) }
      return cached
    })
    .catch(() => cached)
    .finally(() => { pending = null })
  return pending
}

export function useAgentUpdates() {
  const [updates, setUpdates] = useState(cached || {})
  useEffect(() => {
    listeners.add(setUpdates)
    if (!cached || Date.now() - at > REFRESH_MS) load()
    const t = setInterval(() => { if (!document.hidden) load() }, REFRESH_MS)
    return () => { listeners.delete(setUpdates); clearInterval(t) }
  }, [])
  return updates
}

// One line for the marker's tooltip: what runs, what is newer, what to press.
export function updateText(status) {
  if (!status || !status.updateAvailable) return ''
  if (status.kind === 'git') {
    return `Update available — built from ${status.current}, ${status.ref || 'its branch'} is now at ${status.latest}. Redeploy to update.`
  }
  const now = status.current ? `${status.current}: ` : ''
  return status.action === 'rebuild'
    ? `Update available — ${now}${status.reason}. Rebuild image to update.`
    : `Update available — ${now}${status.reason}. Redeploy to update.`
}

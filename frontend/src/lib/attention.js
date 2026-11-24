// The sidebar's "Needs attention" rows, from the list endpoint's `attention`
// (backend/lib/attention.js) and the update markers (lib/agentUpdates.js).
//
// Updates are grouped: when a new Hermes comes out every Hermes guest has one
// at once, and thirteen rows saying the same thing would push a real fault
// below the fold. One guest with an update gets its own row.

// Guests with the same problem that become one row.
const GROUP_AT = 3

export const LEVEL_RANK = { critical: 3, warning: 2, busy: 1, update: 0 }

export const KIND_ORDER = ['agent', 'tool', 'app']
export const KIND_LABELS = { agent: 'Agents', tool: 'Tools', app: 'Apps' }

// Same order as backend/lib/attention.js compare(): worst first, newest
// problem first, then by name; guests with nothing to do after all of them.
export function compareAttention(a, b) {
  const la = a.attention ? LEVEL_RANK[a.attention.level] ?? 0 : -1
  const lb = b.attention ? LEVEL_RANK[b.attention.level] ?? 0 : -1
  if (la !== lb) return lb - la
  const sa = a.attention?.since || 0
  const sb = b.attention?.since || 0
  if (sa !== sb) return sb - sa
  return String(a.name).localeCompare(String(b.name))
}

// [{ key, level, title, text, to }] in the order the sidebar shows them.
export function attentionRows(agents, updates = {}) {
  const list = Array.isArray(agents) ? agents : []
  const flagged = list.filter(a => a.attention).sort(compareAttention)
  // Same problem on several guests at once is one problem, most often the
  // host's: when the disk filled on 2026-10-20 every guest went down in the
  // same minute. Grouped, as the uptime alerts are (lib/uptimeAlerts.js), so
  // a different fault on one guest is not pushed out of sight below them.
  const same = {}
  for (const a of flagged) {
    const k = `${a.attention.level}|${a.attention.text}`
    ;(same[k] = same[k] || []).push(a)
  }
  const rows = []
  const done = new Set()
  for (const a of flagged) {
    const k = `${a.attention.level}|${a.attention.text}`
    if (done.has(k)) continue
    const group = same[k]
    if (group.length >= GROUP_AT && a.attention.level !== 'busy') {
      done.add(k)
      rows.push({ key: `group:${k}`, level: a.attention.level, title: `${group.length} guests`, text: a.attention.text, to: '/agents?filter=attention' })
    } else {
      rows.push({ key: a.id, agentId: a.id, level: a.attention.level, title: a.name, text: a.attention.text, to: `/agent/${a.id}` })
    }
  }

  const behind = list.filter(a => updates[a.id]?.updateAvailable).sort((a, b) => a.name.localeCompare(b.name))
  if (behind.length === 1) {
    const a = behind[0]
    rows.push({ key: `update:${a.id}`, agentId: a.id, level: 'update', title: a.name, text: 'Update available', to: `/agent/${a.id}` })
  } else if (behind.length > 1) {
    const names = behind.slice(0, 3).map(a => a.name).join(', ') + (behind.length > 3 ? ` and ${behind.length - 3} more` : '')
    rows.push({ key: 'updates', level: 'update', title: `${behind.length} updates available`, text: names, to: '/agents?filter=updates' })
  }
  return rows
}

// How many guests need the operator: faults and warnings, not deploys in
// progress or updates.
export function problemCount(agents) {
  return (Array.isArray(agents) ? agents : []).filter(a => a.attention && (a.attention.level === 'critical' || a.attention.level === 'warning')).length
}

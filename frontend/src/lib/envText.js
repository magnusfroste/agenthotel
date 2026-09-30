// The Environment tab as one block of text, the way a .env file or Easypanel
// shows it. It is a view of the same key/value pairs, not a second store:
// switching back to rows, or saving, turns the text into pairs again, and the
// panel keeps storing one config key per variable. That is why the text view
// could be added without touching the backend — and why it must never lose a
// value it cannot show.

// Keys the container can receive. The backend passes on only names shaped
// like this, so a pasted `my-key=1` would be saved and then silently ignored.
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

// A value holding a line break — a compose file, a SOUL, a .env blob — has
// no honest one-line form. Such pairs stay in row view, untouched by the text.
export function isMultiline(value) {
  return typeof value === 'string' && value.includes('\n')
}

// Quote only when the value would otherwise read back differently: leading or
// trailing spaces, a leading quote or '#'. Everything else is written as-is, so
// what an operator pastes in comes back out looking the same.
function quote(value) {
  if (value === '') return ''
  if (/^\s|\s$/.test(value) || /^["'#]/.test(value)) return JSON.stringify(value)
  return value
}

export function toEnvText(pairs) {
  return pairs
    .filter(p => p.key.trim() && !isMultiline(p.value))
    .map(p => `${p.key.trim()}=${quote(p.value ?? '')}`)
    .join('\n')
}

function unquote(raw) {
  const v = raw.trim()
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try { return JSON.parse(v) } catch { return v.slice(1, -1) }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1)
  return v
}

// Reads what people actually paste: blank lines and # comments, `export KEY=…`
// from a shell profile, quoted values, and `=` inside a value (a base64 key,
// a URL with a query). Split at the first `=` only. A later line wins over an
// earlier one for the same key, as it would in a shell — and is reported, so
// a duplicate is a decision rather than an accident.
export function parseEnvText(text) {
  const pairs = []
  const errors = []
  const warnings = []
  const index = new Map()
  const lines = String(text || '').split(/\r?\n/)
  lines.forEach((line, i) => {
    const t = line.trim()
    if (!t || t.startsWith('#')) return
    const body = t.replace(/^export\s+/, '')
    const at = body.indexOf('=')
    if (at < 1) { errors.push(`Line ${i + 1}: expected KEY=value`); return }
    const key = body.slice(0, at).trim()
    if (!KEY_RE.test(key)) { errors.push(`Line ${i + 1}: "${key}" is not a valid variable name`); return }
    const value = unquote(body.slice(at + 1))
    if (index.has(key)) {
      warnings.push(`${key} appears more than once — the last one is kept`)
      pairs[index.get(key)].value = value
      return
    }
    index.set(key, pairs.length)
    pairs.push({ key, value })
  })
  return { pairs, errors, warnings }
}

// The full set after editing as text: what the text says, plus the multi-line
// pairs it never showed. A key typed in the text wins over a hidden one of the
// same name, since that is the edit the operator can see.
export function mergeTextEdit(text, previousPairs) {
  const parsed = parseEnvText(text)
  const typed = new Set(parsed.pairs.map(p => p.key))
  const hidden = previousPairs.filter(p => isMultiline(p.value) && !typed.has(p.key.trim()))
  return { ...parsed, pairs: [...parsed.pairs, ...hidden] }
}

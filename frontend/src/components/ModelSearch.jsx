import { useState, useRef, useEffect, useId } from 'react'

// Pick one model out of hundreds by typing part of its name.
//
// A provider like OpenRouter lists 455 chat models; a <select> of that is a
// scroll, not a choice. Here nothing is shown until you type, and then only
// the best dozen matches. Every word you type must appear somewhere in the id,
// in any order, so "sol 6.1" finds openai/gpt-6.1-sol and "claude sonnet"
// finds anthropic/claude-sonnet-5.5.
//
// options: [{ id, group }] — id is what is chosen, group a label shown beside it.
// extra:   [{ id, label }] — always offered first, e.g. "Automatic".

const LIMIT = 12

function matches(id, words) {
  const hay = id.toLowerCase()
  return words.every(w => hay.includes(w))
}

// Shorter ids first: typing "gpt-5" should offer gpt-5 before
// gpt-5-mini-2025-08-07. Then alphabetical, so the list does not jump.
function rank(a, b) {
  return a.id.length - b.id.length || a.id.localeCompare(b.id)
}

export default function ModelSearch({ options, value, onChange, placeholder, extra = [], label, compact = false }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const box = useRef(null)
  const listId = useId()

  useEffect(() => {
    const close = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const found = words.length ? options.filter(o => matches(o.id, words)).sort(rank) : []
  const shown = [...(words.length ? [] : extra), ...found.slice(0, LIMIT)]
  const more = found.length - Math.min(found.length, LIMIT)

  function choose(id) {
    onChange(id)
    setQuery('')
    setOpen(false)
  }

  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(a => Math.min(a + 1, shown.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { if (open && shown[active]) { e.preventDefault(); choose(shown[active].id) } }
    else if (e.key === 'Escape') { setOpen(false); setQuery('') }
  }

  const current = extra.find(x => x.id === value)
  const fontSize = compact ? '0.8rem' : '0.875rem'

  return (
    <div ref={box} style={{ position: 'relative', flex: 1, maxWidth: compact ? undefined : '32rem' }}>
      <input
        className="form-input"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        style={{ fontFamily: 'monospace', fontSize, padding: compact ? '0.4rem' : undefined }}
        value={open ? query : (current ? current.label : value)}
        placeholder={placeholder}
        onFocus={() => { setOpen(true); setActive(0) }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(0) }}
        onKeyDown={onKey}
        spellCheck="false"
        autoComplete="off"
      />
      {open && (shown.length > 0 || words.length > 0) && (
        <ul id={listId} role="listbox" style={{
          position: 'absolute', zIndex: 20, left: 0, right: 0, top: '100%', marginTop: '0.25rem',
          listStyle: 'none', padding: '0.25rem', maxHeight: '22rem', overflowY: 'auto',
          background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: '0.5rem',
          boxShadow: '0 8px 24px rgba(0,0,0,0.25)'
        }}>
          {shown.map((o, i) => (
            <li key={o.id || '(empty)'} role="option" aria-selected={o.id === value}
              onMouseDown={(e) => { e.preventDefault(); choose(o.id) }}
              onMouseEnter={() => setActive(i)}
              style={{
                display: 'flex', justifyContent: 'space-between', gap: '1rem',
                padding: '0.35rem 0.5rem', borderRadius: '0.35rem', cursor: 'pointer', fontSize,
                background: i === active ? 'var(--bg-tertiary)' : 'transparent',
                color: o.id === value ? 'var(--accent-blue)' : 'var(--text-primary)'
              }}>
              <span style={{ fontFamily: o.label ? 'inherit' : 'monospace', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.label || o.id}</span>
              {o.group && <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>{o.group}</span>}
            </li>
          ))}
          {words.length > 0 && found.length === 0 && (
            <li style={{ padding: '0.35rem 0.5rem', color: 'var(--text-secondary)', fontSize }}>No model matches “{query}”</li>
          )}
          {more > 0 && (
            <li style={{ padding: '0.35rem 0.5rem', color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
              {more} more — keep typing to narrow it down
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

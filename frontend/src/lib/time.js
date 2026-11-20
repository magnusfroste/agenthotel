import { useSyncExternalStore } from 'react'
import { authFetch } from './auth.js'

// Every time the panel shows, in one zone: the hotel's choice (the setting
// "timezone", an IANA name such as Europe/Stockholm), else wherever the
// browser is. Each component used to call toLocaleString() on its own, so the
// zone could not be chosen at all.
//
// The backend's own stamps come from SQLite's CURRENT_TIMESTAMP: UTC, written
// "2026-11-19 14:23:12", with no zone. new Date() reads such a string as local
// time, so the Created and Updated times on a guest were off by the browser's
// offset (an hour early in Stockholm in winter). toDate() reads them as UTC.

let saved = ''                     // the setting; '' means "where you are"
const listeners = new Set()

export function browserZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

// Whether a name is a zone this browser knows.
export function isZone(name) {
  try { new Intl.DateTimeFormat('en', { timeZone: name }); return true } catch { return false }
}

export function savedZone() { return saved }

// The zone times are shown in now.
export function currentZone() {
  return saved && isZone(saved) ? saved : browserZone()
}

export function setZone(name) {
  saved = typeof name === 'string' ? name.trim() : ''
  listeners.forEach(fn => fn())
}

export function loadZone() {
  return authFetch('/api/settings')
    .then(r => (r.ok ? r.json() : {}))
    .then(s => setZone(s.timezone || ''))
    .catch(() => {})
}

function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// Re-renders the caller when the zone changes; the App uses it so the whole
// panel follows a change without a reload.
export function useTimeZone() {
  return useSyncExternalStore(subscribe, currentZone)
}

const NO_ZONE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/

// A Date from what the backend sends: a SQLite stamp (UTC without a zone), an
// ISO string, milliseconds or a Date. null when it is not a time.
export function toDate(value) {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) return isNaN(value) ? null : value
  if (typeof value === 'number') return new Date(value)
  const text = String(value).trim()
  const d = new Date(NO_ZONE.test(text) ? `${text.replace(' ', 'T')}Z` : text)
  return isNaN(d) ? null : d
}

function show(value, method, options, locale) {
  const d = toDate(value)
  if (!d) return '—'
  return d[method](locale, { ...options, timeZone: currentZone() })
}

export const formatDateTime = (value, options = {}, locale) => show(value, 'toLocaleString', options, locale)
export const formatDate = (value, options = {}, locale) => show(value, 'toLocaleDateString', options, locale)
export const formatTime = (value, options = {}, locale) => show(value, 'toLocaleTimeString', options, locale)

// "UTC+1" for a zone at a given moment, to put beside its name.
export function zoneOffset(zone, at = new Date()) {
  try {
    const part = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'shortOffset' })
      .formatToParts(at).find(p => p.type === 'timeZoneName')
    return (part?.value || '').replace('GMT', 'UTC')
  } catch { return '' }
}

// Every zone the browser knows, for the setting's list.
export function allZones() {
  try { return Intl.supportedValuesOf('timeZone') } catch { return [browserZone(), 'UTC'] }
}

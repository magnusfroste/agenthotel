// The domain a new guest gets under the hotel's guest domain, as
// backend/lib/guestDomain.js says it: "My Agent" under hotel.example.com is
// my-agent.hotel.example.com. '' when either is missing.
export function nameLabel(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 63)
    .replace(/-+$/, '')
}

export function suggestDomain(name, base) {
  const label = nameLabel(name)
  const suffix = String(base || '').trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '')
  return label && suffix ? `${label}.${suffix}` : ''
}

// The hotel's own domain for guests: with `guest_domain` set to
// hotel.example.com, a new guest called zeroclaw gets zeroclaw.hotel.example.com
// without anyone touching DNS.
//
// Before this, every guest's name was a DNS record of its own, added by hand
// after the deploy, and a name added late left Caddy without a certificate
// until it was reloaded (a 525 behind Cloudflare). With one wildcard record,
// *.hotel.example.com pointing here, every name under it resolves before the
// guest exists, so Caddy gets its certificate over HTTP-01 at the first deploy,
// one name at a time, as for any other guest. No DNS provider's API key in the
// panel, and it works whoever runs the zone.
//
// It is a suggestion, not a rule: the form fills the domain in from the name,
// and the operator can change or clear it.

const crypto = require('crypto');
const { domainProblem } = require('./domainName');

const SETTING_KEY = 'guest_domain';

// What the operator typed, as it is stored: lower case, without a leading
// "*." (people type the DNS record) or a trailing dot. '' is "not set".
function normalizeGuestDomain(raw) {
  if (raw === undefined || raw === null) return '';
  return String(raw).trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
}

function guestDomainProblem(raw) {
  const domain = normalizeGuestDomain(raw);
  return domain ? domainProblem(domain) : null;
}

// A guest's name as one DNS label: "My Agent_2" → "my-agent-2". '' when
// nothing is left of it.
function nameLabel(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 63)
    .replace(/-+$/, '');
}

// The domain a guest of this name gets under the hotel's domain, or '' when
// there is no hotel domain or no usable name.
function suggestDomain(name, base) {
  const label = nameLabel(name);
  const suffix = normalizeGuestDomain(base);
  if (!label || !suffix) return '';
  const domain = `${label}.${suffix}`;
  return domainProblem(domain) ? '' : domain;
}

// Whether *.<base> reaches this hotel: a name nobody would create, looked up
// in public DNS and compared with the hotel's address. `domainCheck` is
// lib/domainCheck.js. The verdict is said for the operator, in the panel.
async function checkGuestDomain(base, domainCheck, { hotel = [], addresses = [] } = {}) {
  const domain = normalizeGuestDomain(base);
  if (!domain) return { domain: '', state: 'unset', ok: null, verdict: '' };
  const probe = `ah-check-${crypto.randomBytes(5).toString('hex')}.${domain}`;
  const dns = await domainCheck.check(probe, { hotel, addresses });
  const where = dns.hotelAddresses.length ? dns.hotelAddresses.join(', ') : "this server's address";
  const verdicts = {
    'here': [true, `*.${domain} points here: new guests answer on their name at once`],
    'no-record': [false, `No wildcard record yet. Add *.${domain} as an A record to ${where} (DNS only, not proxied, in Cloudflare)`],
    'elsewhere': [false, `*.${domain} points at ${dns.addresses.join(', ')}, which is not this server (${where})`],
    'proxied': [null, `*.${domain} goes through Cloudflare's proxy. Cloudflare's free certificate covers only one level below the zone, so a name like guest.${domain} fails there unless ${domain} is the zone itself. Set the record to DNS only`],
    'resolves': [null, `*.${domain} resolves; this server's own address is not known to compare with`],
    'unknown': [null, `DNS did not answer (${dns.error}). Try again`]
  };
  const [ok, verdict] = verdicts[dns.state] || [null, ''];
  return { domain, state: dns.state, ok, verdict, addresses: dns.addresses };
}

module.exports = { SETTING_KEY, normalizeGuestDomain, guestDomainProblem, nameLabel, suggestDomain, checkGuestDomain };

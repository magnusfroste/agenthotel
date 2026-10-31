// Whether a domain can carry a certificate, said when it is saved rather than
// found out from Let's Encrypt later. "take_01.agenthotel.org" was accepted,
// routed, and then refused by the CA because of the underscore, which left the
// guest unreachable with nothing in the panel saying why (2026-10-29).

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// The reason a domain is unusable, or null when it is fine. An empty domain
// means "no domain" and is fine.
function domainProblem(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') return 'The domain must be text';
  const domain = raw.trim();
  if (!domain) return 'The domain is only spaces';
  if (domain !== raw) return `"${domain}" has spaces around it`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(domain) || /[/?#]/.test(domain)) {
    return `"${domain}" is an address, not a domain. Give the name only, like agent.example.com`;
  }
  if (/:\d+$/.test(domain)) return `"${domain}" has a port. Give the name only; the panel serves it on 443`;
  if (domain !== domain.toLowerCase()) return `"${domain}" has capital letters. Write it in lower case`;
  if (/[^\x00-\x7f]/.test(domain)) {
    return `"${domain}" has letters outside a-z. Use its xn-- (punycode) form`;
  }
  if (domain.length > 253) return `"${domain}" is longer than the 253 characters a domain may have`;
  const labels = domain.split('.');
  if (labels.length < 2) return `"${domain}" needs a dot, like agent.example.com`;
  if (domain.includes('_')) {
    return `"${domain}" has an underscore. Certificates cannot be issued for it; use a hyphen instead`;
  }
  for (const label of labels) {
    if (!LABEL.test(label)) {
      return `"${domain}" is not a valid domain: each part between dots is 1–63 of a-z, 0-9 and hyphens, and does not start or end with a hyphen`;
    }
  }
  return null;
}

module.exports = { domainProblem };

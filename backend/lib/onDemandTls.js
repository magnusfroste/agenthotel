// Certificates for wildcard guests, one name at a time.
//
// A guest with `*.example.com` among its extra domains (Lobby, a web hotel for
// landing pages) gets every subdomain routed to it, but Caddy here gets its
// certificates over HTTP-01, one name each, and a wildcard certificate needs a
// DNS challenge. The route was there and HTTPS failed: behind Cloudflare a 525
// (2026-11-11). Nothing in the panel said so.
//
// So a wildcard gets an on-demand TLS policy instead: no certificate up front,
// and the first visit to a name asks the panel whether it should have one.
// The panel says yes only when the name is exactly one label under a guest's
// wildcard AND that guest answers for it — Lobby returns 404 for a site it
// does not have, so a stranger requesting random-12345.example.com cannot make
// the hotel ask Let's Encrypt for certificates until the rate limit (about 50
// new names per registered domain per week) locks out the real sites.
//
// Caddy asks over HTTP. The backend answers only on a Unix socket, so Caddy
// gets a second server on its own loopback that forwards one path there.
// Nothing outside Caddy's container can reach 127.0.0.1:2020.

const http = require('http');

const ASK_LISTEN = '127.0.0.1:2020';
const ASK_PATH = '/tls-ask';
const POLICY_ID_PREFIX = 'ondemand-';
const LETS_ENCRYPT = 'https://acme-v02.api.letsencrypt.org/directory';

// "*.example.com" → "example.com"; anything else → null.
function wildcardSuffix(domain) {
  const d = String(domain || '').trim().toLowerCase();
  return d.startsWith('*.') && d.length > 2 ? d.slice(2) : null;
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// The guest a hostname belongs to under a wildcard, or null. Exactly one label
// below the suffix, as a wildcard certificate and Caddy's matcher both mean it:
// *.example.com covers a.example.com, never a.b.example.com or example.com.
// The most specific wildcard wins when two would match.
//
// guests: [{ id, wildcards: ['*.example.com', …], … }]
function guestForHost(host, guests) {
  const name = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  const dot = name.indexOf('.');
  if (dot <= 0) return null;
  const label = name.slice(0, dot);
  const rest = name.slice(dot + 1);
  if (!LABEL.test(label)) return null;
  let best = null;
  for (const guest of guests || []) {
    for (const w of guest.wildcards || []) {
      const suffix = wildcardSuffix(w);
      if (suffix && suffix === rest && (!best || suffix.length > best.suffix.length)) best = { guest, suffix };
    }
  }
  return best ? best.guest : null;
}

// The loopback server Caddy asks through. Everything but the one path is a 404.
function askServer(backendDial) {
  return {
    listen: [ASK_LISTEN],
    automatic_https: { disable: true },
    routes: [
      { match: [{ path: [ASK_PATH] }], handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: backendDial }] }], terminal: true },
      { handle: [{ handler: 'static_response', status_code: 404 }] }
    ]
  };
}

// Where Caddy asks before an on-demand certificate.
function onDemandConfig() {
  return { permission: { module: 'http', endpoint: `http://${ASK_LISTEN}${ASK_PATH}` } };
}

// The TLS policy for one wildcard. on_demand also keeps Caddy from trying to
// get a certificate for the wildcard itself at startup, which HTTP-01 cannot.
// It must sit ahead of any policy without subjects: Caddy takes the first
// policy that matches a name, and a subject-less one matches every name.
function policyFor(wildcard, email = '') {
  const issuer = { module: 'acme', ca: LETS_ENCRYPT };
  if (email) issuer.contact = [`mailto:${email}`];
  return { '@id': policyId(wildcard), subjects: [wildcard], on_demand: true, issuers: [issuer] };
}

function policyId(wildcard) {
  return `${POLICY_ID_PREFIX}${wildcard}`;
}

// Whether the guest answers for this hostname: a GET of / with that Host,
// straight to its container. 2xx and 3xx are yes; 4xx, 5xx, a timeout or a
// refused connection are no.
function guestServes(host, container, port, { timeoutMs = 3000 } = {}) {
  return new Promise(resolve => {
    const req = http.request({ host: container, port, path: '/', method: 'GET', headers: { Host: host, 'User-Agent': 'agenthotel-tls-ask' }, timeout: timeoutMs }, res => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

module.exports = {
  ASK_LISTEN, ASK_PATH, POLICY_ID_PREFIX,
  wildcardSuffix, guestForHost, askServer, onDemandConfig, policyFor, policyId, guestServes
};

// Throttling for a panel that is root on its host.
//
// The panel container runs privileged with the Docker socket and the host's PID
// namespace, so whoever gets past the login page can run anything on the VPS.
// One password is the whole boundary, and until now nothing slowed an attacker
// down: the settings had rate_limit_enabled and rate_limit_requests, but no code
// ever read them.
//
// Fixed windows in memory. Not shared between processes and lost on restart,
// which is the right trade here — the panel is a single process, and a limiter
// that needs its own datastore is a limiter that gets switched off.

// Who is asking.
//
// The first version believed cf-connecting-ip and the first x-forwarded-for
// entry from any private peer. Both could be forged (security sweep,
// 2026-09-30, verified against a real Caddy):
//
// - Caddy forwards cf-connecting-ip untouched, so a request sent straight to
//   the server's IP — ports 80/443 are open even behind a tunnel — named its
//   own address and got a fresh login bucket per attempt.
// - Caddy appends to x-forwarded-for when the sender is on a private network,
//   which a guest is, and so is IPv6 traffic arriving through Docker's proxy.
//   The first entry is then whatever the sender wrote.
// - A guest shares the backend's network and could skip Caddy altogether.
//
// What can be believed is narrower. The socket peer is the truth, unless the
// peer is Caddy itself. Then the LAST x-forwarded-for entry is the address
// Caddy saw — Caddy writes that one, the sender cannot. And cf-connecting-ip is
// believed only when that address is the tunnel container, because Cloudflare's
// edge overwrites whatever the client sent.
//
// Which containers are Caddy and the tunnel is looked up by name on the
// panel's network (refreshProxies). Until a lookup has succeeded, any private
// peer counts as Caddy — so a panel whose DNS is odd degrades to a shared
// bucket, never to believing a forged header from the internet.

const dns = require('dns').promises;

const proxies = { caddy: new Set(), tunnel: new Set() };

function bare(ip) {
  return String(ip || '').trim().replace(/^::ffff:/, '');
}

const PRIVATE = /^(::1$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|f[cd][0-9a-f]{2}:)/i;

function isCaddy(peer) {
  return proxies.caddy.size ? proxies.caddy.has(peer) : PRIVATE.test(peer);
}

function clientIp(req) {
  const peer = bare(req.socket?.remoteAddress);
  if (!peer) return 'unknown';

  // A tunnel pointed straight at the backend, with no Caddy in between.
  if (proxies.tunnel.has(peer)) return cfAddress(req) || peer;
  if (!isCaddy(peer)) return peer;

  const fwd = req.headers['x-forwarded-for'];
  const hops = typeof fwd === 'string' ? fwd.split(',').map(bare).filter(Boolean) : [];
  const seen = hops.length ? hops[hops.length - 1] : peer;
  if (proxies.tunnel.has(seen)) return cfAddress(req) || seen;
  return seen;
}

function cfAddress(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf !== 'string') return null;
  const value = bare(cf);
  // An address, not a sentence — it becomes a map key and a log line.
  return /^[0-9a-f.:]{3,45}$/i.test(value) ? value : null;
}

// Tests set these directly; the panel resolves them.
function setProxies({ caddy = [], tunnel = [] } = {}) {
  proxies.caddy = new Set(caddy.map(bare));
  proxies.tunnel = new Set(tunnel.map(bare));
}

async function resolveAll(names) {
  const found = [];
  for (const name of names) {
    try { for (const r of await dns.lookup(name, { all: true })) found.push(r.address); } catch (e) { /* not running */ }
  }
  return found;
}

// A container's address changes when it is recreated, so look again now and
// then. A failed lookup keeps what was known rather than forgetting it.
async function refreshProxies(caddyNames = ['caddy', 'agenthotel-caddy'], tunnelNames = ['agenthotel-cloudflared']) {
  const caddy = await resolveAll(caddyNames);
  const tunnel = await resolveAll(tunnelNames);
  if (caddy.length) proxies.caddy = new Set(caddy.map(bare));
  // The tunnel may be switched off: then no address is the tunnel.
  proxies.tunnel = new Set(tunnel.map(bare));
  return { caddy: [...proxies.caddy], tunnel: [...proxies.tunnel] };
}

const windows = new Map(); // `${bucket}:${ip}` → { count, resetAt }

function hit(bucket, ip, limit, windowMs) {
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const entry = windows.get(key);
  if (!entry || entry.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfter: 0 };
  }
  entry.count++;
  if (entry.count > limit) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { allowed: true, remaining: limit - entry.count, retryAfter: 0 };
}

function reset(bucket, ip) {
  windows.delete(`${bucket}:${ip}`);
}

// Entries outlive their window only until someone asks again, so sweep.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of windows) if (entry.resetAt <= now) windows.delete(key);
}, 5 * 60 * 1000).unref?.();

module.exports = { clientIp, hit, reset, setProxies, refreshProxies };

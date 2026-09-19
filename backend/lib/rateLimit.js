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

// Who is asking. Behind Cloudflare the tunnel sets cf-connecting-ip, which
// cannot be forged through their edge. Behind a local reverse proxy the socket
// peer is the proxy, and the first x-forwarded-for entry is the client. Exposed
// directly, the socket address is the truth and the headers are not, so they are
// only believed when the peer is on a private network.
function clientIp(req) {
  const peer = req.socket?.remoteAddress || '';
  const local = /^(::1|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::ffff:(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.))/.test(peer);
  // Headers are believed only from a local proxy — the tunnel or Caddy on the
  // panel's own network. Believing cf-connecting-ip from any peer let a caller
  // reaching the backend directly pick a fresh address per request and walk
  // straight past the login throttle (found in review, 2026-09-19).
  if (local) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf.trim()) return cf.trim();
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  }
  return peer || 'unknown';
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

module.exports = { clientIp, hit, reset };

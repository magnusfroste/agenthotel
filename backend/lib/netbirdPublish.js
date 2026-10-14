// Publish every guest through NetBird's reverse proxy, without a click per guest.
//
// lib/netbird.js puts the hotel on the mesh; a public hostname still needed a
// Reverse Proxy service made by hand in NetBird for each guest. With an API
// token (a NetBird personal access token or a service user's) the panel keeps
// those services itself: one per guest domain, pointing at this hotel's peer,
// port 80, Host passed through — the same single origin as the panel's own.
//
// Only while NetBird is on and publishing is switched on. Only services the
// panel created are ever changed or removed: their ids are kept in the
// `netbird_published` setting, and a service someone made by hand — the
// panel's own, say — is never touched, even when it claims a guest's name.
//
// Which public name a guest gets:
// - its own domain, when that falls under a custom domain validated in NetBird
//   (the operator then CNAMEs the name to the proxy cluster, once per name or
//   with a wildcard);
// - otherwise a name under NetBird's free domain, `reel-froste-eu.eu1.netbird.services`
//   for `reel.froste.eu`. Caddy routes on Host, so that name is added to the
//   guest's route as an extra host (`extraHosts`).

const STATE_KEY = 'netbird_published';

// What the panel believes it published, by guest domain:
// { [domain]: { serviceId, publicName, error? } }. Read once, kept in memory —
// route code asks for it every minute.
let cache = null;

function loadState(db) {
  if (cache) return cache;
  try {
    cache = JSON.parse(db.prepare('SELECT value FROM settings WHERE key = ?').get(STATE_KEY)?.value || '{}') || {};
  } catch (_) {
    cache = {};
  }
  return cache;
}

function saveState(db, state) {
  cache = state;
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(STATE_KEY, JSON.stringify(state));
}

// The hostnames Caddy must also answer on for a guest: its NetBird name, when
// that is not the guest's own domain.
function extraHosts(db, domain) {
  if (!domain) return [];
  const entry = loadState(db)[String(domain).toLowerCase()];
  return entry && entry.serviceId && entry.publicName && entry.publicName !== domain ? [entry.publicName] : [];
}

function apiBase(managementUrl) {
  const url = new URL(managementUrl || 'https://api.netbird.io:443');
  const port = url.port && !((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) ? `:${url.port}` : '';
  return `${url.protocol}//${url.hostname}${port}`;
}

function client({ token, managementUrl, fetchImpl = fetch }) {
  const base = apiBase(managementUrl);
  return async function call(method, path, body) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { Authorization: `Token ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000)
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    if (!res.ok) {
      const why = (data && (data.message || data.error)) || String(text).slice(0, 200) || res.statusText;
      const err = new Error(res.status === 401 || res.status === 403
        ? `NetBird refused the API token (${res.status}): ${why}`
        : `NetBird ${method} ${path} answered ${res.status}: ${why}`);
      err.status = res.status;
      throw err;
    }
    return data;
  };
}

// A guest's name under NetBird's free domain: one DNS label, so the dots go.
function freeName(domain, freeDomain) {
  const label = String(domain).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63).replace(/-+$/, '');
  return `${label}.${freeDomain}`;
}

function publicNameFor(domain, domains) {
  const d = String(domain).toLowerCase();
  const custom = domains.filter(x => x.type === 'custom' && x.validated)
    .map(x => String(x.domain).toLowerCase())
    .sort((a, b) => b.length - a.length)
    .find(c => d === c || d.endsWith(`.${c}`));
  if (custom) return { publicName: d, custom };
  const free = domains.find(x => x.type === 'free');
  if (!free) return { error: 'NetBird offers no free domain to this account — add a custom domain in NetBird' };
  return { publicName: freeName(d, String(free.domain).toLowerCase()) };
}

function serviceBody(domain, publicName, peerId, originPort) {
  return {
    name: `agenthotel ${domain}`,
    domain: publicName,
    mode: 'http',
    enabled: true,
    // Caddy routes on Host: without this NetBird sends the peer's address and
    // Caddy answers with a redirect to it.
    pass_host_header: true,
    rewrite_redirects: false,
    targets: [{
      target_id: peerId,
      target_type: 'peer',
      protocol: 'http',
      port: originPort,
      path: '/',
      enabled: true
    }]
  };
}

// Does a service in NetBird still say what we would send?
function matches(svc, body) {
  const t = (svc.targets || [])[0] || {};
  return svc.domain === body.domain && svc.enabled !== false && !!svc.pass_host_header &&
    (svc.targets || []).length === 1 && t.target_id === body.targets[0].target_id &&
    t.target_type === 'peer' && Number(t.port) === body.targets[0].port && (t.protocol || 'http') === 'http';
}

// What to do, decided without touching anything — the part a mistake in would
// unpublish live sites, so it is pure and tested.
//   guests:   guest domains that should be public
//   domains:  GET /api/reverse-proxies/domains
//   services: GET /api/reverse-proxies/services
//   state:    what the panel published before
// Returns { create, update, remove, keep, errors }.
function plan({ guests, domains, services, state, peerId, originPort = 80 }) {
  const byId = new Map((services || []).map(s => [s.id, s]));
  const byDomain = new Map((services || []).map(s => [String(s.domain).toLowerCase(), s]));
  const out = { create: [], update: [], remove: [], keep: [], errors: [] };
  const wanted = new Set();

  for (const raw of guests) {
    const domain = String(raw).toLowerCase();
    // A wildcard is a Caddy catch-all; a proxy service is one name.
    if (!domain || domain.startsWith('*.') || wanted.has(domain)) continue;
    wanted.add(domain);
    const name = publicNameFor(domain, domains || []);
    if (name.error) { out.errors.push({ domain, error: name.error }); continue; }
    const body = serviceBody(domain, name.publicName, peerId, originPort);
    const mine = state[domain]?.serviceId ? byId.get(state[domain].serviceId) : null;
    if (mine) {
      if (matches(mine, body)) out.keep.push({ domain, serviceId: mine.id, publicName: body.domain });
      else out.update.push({ domain, serviceId: mine.id, body });
      continue;
    }
    const taken = byDomain.get(body.domain);
    if (taken) {
      out.errors.push({ domain, publicName: body.domain, error: `NetBird already has a service for ${body.domain} that the panel did not create — left as it is` });
      continue;
    }
    out.create.push({ domain, body });
  }

  for (const [domain, entry] of Object.entries(state || {})) {
    if (wanted.has(domain) || !entry?.serviceId) continue;
    out.remove.push({ domain, serviceId: entry.serviceId, exists: byId.has(entry.serviceId) });
  }
  return out;
}

// Make NetBird match the guests. Returns a report for the panel to show.
async function sync({ db, token, managementUrl, peerIp, guests, originPort = 80, fetchImpl, log = console }) {
  const call = client({ token, managementUrl, fetchImpl });
  const peers = await call('GET', `/api/peers?ip=${encodeURIComponent(peerIp)}`);
  const peer = (Array.isArray(peers) ? peers : []).find(p => p.ip === peerIp) || (Array.isArray(peers) ? peers[0] : null);
  if (!peer?.id) throw new Error(`NetBird does not know a peer at ${peerIp} — is this hotel on the same account as the token?`);

  const [domains, services] = await Promise.all([
    call('GET', '/api/reverse-proxies/domains'),
    call('GET', '/api/reverse-proxies/services')
  ]);
  const state = { ...loadState(db) };
  const p = plan({ guests, domains, services, state, peerId: peer.id, originPort });

  for (const k of p.keep) state[k.domain] = { serviceId: k.serviceId, publicName: k.publicName };
  for (const c of p.create) {
    try {
      const svc = await call('POST', '/api/reverse-proxies/services', c.body);
      state[c.domain] = { serviceId: svc.id, publicName: c.body.domain };
      log.log?.(`[NetBird] Published ${c.domain} as https://${c.body.domain}`);
    } catch (err) {
      p.errors.push({ domain: c.domain, publicName: c.body.domain, error: err.message });
    }
  }
  for (const u of p.update) {
    try {
      await call('PUT', `/api/reverse-proxies/services/${encodeURIComponent(u.serviceId)}`, u.body);
      state[u.domain] = { serviceId: u.serviceId, publicName: u.body.domain };
      log.log?.(`[NetBird] Updated the service for ${u.domain}`);
    } catch (err) {
      p.errors.push({ domain: u.domain, publicName: u.body.domain, error: err.message });
    }
  }
  for (const r of p.remove) {
    try {
      if (r.exists) await call('DELETE', `/api/reverse-proxies/services/${encodeURIComponent(r.serviceId)}`);
      delete state[r.domain];
      log.log?.(`[NetBird] Unpublished ${r.domain}`);
    } catch (err) {
      if (err.status === 404) delete state[r.domain];
      else p.errors.push({ domain: r.domain, error: err.message });
    }
  }
  saveState(db, state);

  const errorByDomain = new Map(p.errors.map(e => [e.domain, e]));
  const published = Object.entries(state).map(([domain, e]) => ({ domain, publicName: e.publicName, serviceId: e.serviceId }));
  const failed = p.errors.filter(e => !state[e.domain]).map(e => ({ domain: e.domain, publicName: e.publicName || null, error: e.error }));
  for (const item of published) if (errorByDomain.has(item.domain)) item.error = errorByDomain.get(item.domain).error;
  const custom = (domains || []).filter(d => d.type === 'custom').map(d => ({ domain: d.domain, validated: !!d.validated, cluster: d.target_cluster || null }));
  return { peerId: peer.id, published, failed, customDomains: custom, at: new Date().toISOString() };
}

// Take down everything the panel published — when publishing is switched off
// or the hotel leaves the mesh. Services made by hand stay.
async function unpublishAll({ db, token, managementUrl, fetchImpl, log = console }) {
  const state = { ...loadState(db) };
  const errors = [];
  let removed = 0;
  if (token) {
    const call = client({ token, managementUrl, fetchImpl });
    for (const [domain, entry] of Object.entries(state)) {
      try {
        await call('DELETE', `/api/reverse-proxies/services/${encodeURIComponent(entry.serviceId)}`);
        log.log?.(`[NetBird] Unpublished ${domain}`);
        removed++;
      } catch (err) {
        if (err.status !== 404) errors.push({ domain, error: `${err.message} — remove it in NetBird by hand` });
      }
    }
  }
  // Without a token there is nothing to call; forget them either way, or the
  // routes for their free names would stay in Caddy.
  saveState(db, {});
  return { removed, errors };
}

function resetCache() { cache = null; }

module.exports = { plan, sync, unpublishAll, extraHosts, freeName, publicNameFor, apiBase, resetCache, STATE_KEY };

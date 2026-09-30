// Which agent routes in Caddy belong to nobody.
//
// Deleting an agent removed its routes best effort — errors swallowed — and
// then its row. If Caddy was down at that moment the route stayed, and the
// reconciler could never find it again: it only walks agents that exist. The
// hostname went on answering 502 over a container that no longer did
// (review, 2026-09-30).
//
// The fix is to reconcile in both directions: add what an agent owns and is
// missing, remove what an agent route claims and nobody owns. This is the half
// that deletes, so it is kept pure and tested — a mistake here would take live
// sites down once a minute.

// routes: Caddy's route list. owned: every hostname an agent or the panel owns.
// Returns the routes to remove.
function unownedRoutes(routes, owned) {
  const own = new Set([...owned].filter(Boolean).map(h => String(h).toLowerCase()));
  const out = [];
  for (const r of routes || []) {
    const id = r && r['@id'];
    // Only routes the panel added for agents. The panel's own route, and
    // anything someone added to Caddy by hand, are never ours to remove.
    if (typeof id !== 'string' || !id.startsWith('agent-')) continue;
    const hosts = (r.match || []).flatMap(m => m.host || []).map(h => String(h).toLowerCase());
    // A route with no host to judge is left alone rather than guessed at.
    if (hosts.length === 0) continue;
    if (hosts.every(h => !own.has(h))) out.push({ id, hosts });
  }
  return out;
}

module.exports = { unownedRoutes };

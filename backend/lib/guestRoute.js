// The Caddy route for one guest hostname.
//
// Most guests answer on one port. A runtime with more than one web interface
// declares a layout (plugin.routeLayout): which port the root of the domain goes
// to, and which interfaces live under a path. The Hermes Webapp is the case this
// exists for: the workspace at /, the admin dashboard at /admin, on one domain,
// so a guest does not need a second DNS name for its own admin page.

function proxy(container, port, requestHeaders = {}) {
  return {
    handler: 'reverse_proxy',
    upstreams: [{ dial: `${container}:${port}` }],
    // The visitor's own address, worked out by Caddy from the proxies it
    // trusts (realClientIp in server.js). X-Forwarded-For alone named the
    // nearest hop: behind the tunnel every visitor was cloudflared, behind
    // NetBird the mesh proxy — AgentReports logged and throttled all of them as
    // one address (2026-10-27). Set, not appended: a guest sees one value.
    headers: { request: { set: { 'X-Real-Ip': ['{http.vars.client_ip}'], ...requestHeaders } } }
  };
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

// The sub-routes for one interface mounted under a path.
function mountedRoutes(container, mount) {
  const routes = [{
    match: [{ path: [mount.prefix, `${mount.prefix}/*`] }],
    handle: [
      { handler: 'rewrite', strip_path_prefix: mount.prefix },
      proxy(container, mount.port, { 'X-Forwarded-Prefix': [mount.prefix] })
    ],
    terminal: true
  }];
  if (mount.assetsFromReferer) {
    // Hermes's dashboard rewrites the URLs in its index.html for the prefix, but
    // the preload list inside its bundle still asks for /assets/… with no
    // prefix. Those reach the root interface and 404, and a failed CSS preload
    // rejects the whole chunk: the Chat page came up blank (found in testing,
    // 2026-11-09). The file names are content hashes, so sending the requests a
    // page under the prefix made to the interface that built them cannot catch
    // anything of the root interface's.
    routes.push({
      match: [{
        path: ['/assets/*'],
        header_regexp: { Referer: { pattern: `^https?://[^/]+${escapeRegex(mount.prefix)}(/|$)` } }
      }],
      handle: [proxy(container, mount.port)],
      terminal: true
    });
  }
  return routes;
}

function buildGuestRoute(domain, container, port, layout = null) {
  const route = { '@id': `agent-${domain}`, match: [{ host: [domain] }] };
  if (!layout) {
    route.handle = [proxy(container, port)];
    return route;
  }
  // A subroute keeps one @id per hostname, so removing or replacing a guest's
  // route stays one call however many interfaces it has.
  route.handle = [{
    handler: 'subroute',
    routes: [
      // Exact paths another interface answers as they are, prefix and all: an
      // A2A Agent Card is looked for at /.well-known/agent-card.json on the
      // domain itself, whatever the rest of the domain shows.
      ...(layout.paths || []).map(p => ({
        match: [{ path: p.paths }],
        handle: [proxy(container, p.port)],
        terminal: true
      })),
      ...(layout.mounts || []).flatMap(m => mountedRoutes(container, m)),
      { handle: [proxy(container, layout.rootPort)] }
    ]
  }];
  return route;
}

module.exports = { buildGuestRoute };

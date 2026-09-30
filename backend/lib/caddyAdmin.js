// How the panel reaches Caddy's admin API.
//
// The admin API rewrites every route on the host and has no authentication of
// its own. It used to listen on 0.0.0.0:2019, on the same Docker network as
// every guest — so any Git App built from a stranger's repository, or an agent
// talked into it by a web page, could point the panel's own domain at a copy of
// the login form. Found in the security sweep of 2026-09-30, by reading the
// whole route table from inside the Lobby guest.
//
// It now listens on a Unix socket in a volume only Caddy and the backend mount.
// A guest has no path to it: not the network, not the filesystem.
//
// The TCP address is kept as a fallback for exactly one moment — an upgrade in
// which the backend is already new and Caddy not yet restarted with the socket.
// Once the socket exists, it is the only way in.

const fs = require('fs');
const http = require('http');
const net = require('net');
const nodeFetch = require('node-fetch');

const SOCKET = process.env.CADDY_ADMIN_SOCKET || '/run/caddy-admin/admin.sock';

class SocketAgent extends http.Agent {
  createConnection(options, callback) {
    return net.createConnection(SOCKET, callback);
  }
}
const socketAgent = new SocketAgent({ keepAlive: false });

function usingSocket() {
  try { return fs.statSync(SOCKET).isSocket(); } catch (e) { return false; }
}

// Same signature and return value as fetch. The URL's host is ignored when the
// socket is used; only its path and query reach Caddy.
function caddyFetch(url, options = {}) {
  if (usingSocket()) return nodeFetch(url, { ...options, agent: socketAgent });
  return nodeFetch(url, options);
}

module.exports = { caddyFetch, usingSocket, SOCKET };

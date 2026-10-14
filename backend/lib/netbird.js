// NetBird as a front door, and a private network for the hotel.
//
// NetBird (NetBird GmbH, Berlin; open source) is a WireGuard mesh. The hotel
// joins it as a peer with a setup key, and then two things work that need no
// open ports and no US intermediary:
//
// - The panel and every guest are reachable from the operator's own devices
//   over the mesh, at the hotel's NetBird address or name.
// - NetBird's reverse proxy (v0.65+, NetBird Cloud or self-hosted) publishes a
//   public hostname to the internet by pointing it at this peer, port 80 —
//   the same single origin a Cloudflare Tunnel uses: Caddy routes on the Host
//   header, so one target serves the panel and every guest.
//
// The client runs as a container the panel manages, like cloudflared, but in
// the host's network namespace: the WireGuard interface then belongs to the
// host, so the hotel's mesh address reaches the ports Caddy publishes, and an
// agent's traffic to the mesh leaves through it. Its identity lives in a
// volume, so a restart is the same peer — the setup key is used once.
//
// NetBird Cloud is the default (its free plan covers 5 users and 100
// machines); a self-hosted NetBird is a management URL away.

const fs = require('fs');

const CONTAINER = 'agenthotel-netbird';
const IMAGE = 'netbirdio/netbird:latest';
const VOLUME = 'agenthotel-netbird';
const CLOUD_MANAGEMENT_URL = 'https://api.netbird.io:443';
// What a NetBird reverse-proxy service points at: this peer, port 80.
const ORIGIN_PORT = 80;
// NetBird gives peers addresses in the carrier-grade NAT range.
const MESH_RANGE = '100.64.0.0/10';

function demux(buf) {
  return String(require('./demux').demuxDockerBuffer(buf));
}

async function execJson(docker, cmd) {
  const exec = await docker.getContainer(CONTAINER).exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start();
  const chunks = [];
  await new Promise((resolve, reject) => {
    stream.on('data', c => chunks.push(c));
    stream.on('end', resolve);
    stream.on('error', reject);
    setTimeout(resolve, 8000);
  });
  const out = demux(Buffer.concat(chunks));
  const start = out.indexOf('{');
  return start >= 0 ? JSON.parse(out.slice(start)) : null;
}

// The last thing the client complained about, from its log — "setup key is
// invalid" is far more use on the card than a container that keeps restarting.
function lastError(logText) {
  const lines = String(logText || '').split('\n').reverse();
  const hit = lines.find(l => /\b(ERRO|Error:|FATAL|failed login)\b/.test(l));
  if (!hit) return null;
  const desc = /desc = (.+)$/.exec(hit);
  return (desc ? desc[1] : hit.replace(/^\S+\s+\S+\s+/, '')).trim().slice(0, 300);
}

async function logs(docker, tail = 40) {
  try {
    const buf = await docker.getContainer(CONTAINER).logs({ stdout: true, stderr: true, tail });
    return demux(buf).trim();
  } catch (_) {
    return '';
  }
}

// { installed, running, connected, ip, fqdn, management, peers, version, error }
async function status(docker) {
  let info;
  try {
    info = await docker.getContainer(CONTAINER).inspect();
  } catch (_) {
    return { installed: false, running: false, connected: false, state: 'absent' };
  }
  const out = {
    installed: true,
    running: !!info.State.Running,
    state: info.State.Status,
    restartCount: info.RestartCount || 0,
    connected: false
  };
  if (out.running) {
    try {
      const s = await execJson(docker, ['netbird', 'status', '--json']);
      if (s) {
        out.daemonStatus = s.daemonStatus;
        out.connected = s.daemonStatus === 'Connected' && !!s.management?.connected;
        out.ip = s.netbirdIp || null;
        out.fqdn = s.fqdn || null;
        out.management = s.management?.url || null;
        out.peers = s.peers ? { total: s.peers.total, connected: s.peers.connected } : null;
        out.version = s.daemonVersion || null;
      }
    } catch (_) { /* still starting */ }
  }
  if (!out.connected) out.error = lastError(await logs(docker, 60));
  return out;
}

async function remove(docker) {
  try {
    const c = docker.getContainer(CONTAINER);
    try { await c.stop(); } catch (_) {}
    await c.remove({ force: true });
  } catch (err) {
    if (err.statusCode !== 404) throw err;
  }
}

// A management URL as the client wants it: https, with a port.
function normalizeManagementUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return CLOUD_MANAGEMENT_URL;
  let url;
  try { url = new URL(value.includes('://') ? value : `https://${value}`); } catch (_) {
    throw new Error('The management URL is not a URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The management URL must be http or https');
  return `${url.protocol}//${url.hostname}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`;
}

// A peer name NetBird accepts: letters, digits and hyphens.
function peerName(raw) {
  const name = String(raw || 'agenthotel').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  return name || 'agenthotel';
}

async function start(docker, { setupKey, managementUrl, hostname, fresh = false }) {
  if (!setupKey || String(setupKey).trim().length < 20) throw new Error('A NetBird setup key is required');
  const mgmt = normalizeManagementUrl(managementUrl);

  // As with the tunnel: ask for the current client, fall back to the one on
  // disk if the registry cannot be reached, and only then touch the running
  // container.
  try {
    const stream = await docker.pull(IMAGE);
    await new Promise((res, rej) => docker.modem.followProgress(stream, err => err ? rej(err) : res()));
  } catch (err) {
    console.warn(`[NetBird] Could not pull ${IMAGE} (${err.message}) — using the image on disk`);
    await docker.getImage(IMAGE).inspect();
  }
  await remove(docker);
  // A new setup key or another management server means a new peer: the old
  // identity would log in to the old account.
  if (fresh) {
    try { await docker.getVolume(VOLUME).remove(); } catch (_) {}
  }

  const devices = fs.existsSync('/dev/net/tun')
    ? [{ PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' }]
    : [];
  const env = [`NB_SETUP_KEY=${String(setupKey).trim()}`, `NB_HOSTNAME=${peerName(hostname)}`];
  if (mgmt !== CLOUD_MANAGEMENT_URL) env.push(`NB_MANAGEMENT_URL=${mgmt}`);

  const container = await docker.createContainer({
    name: CONTAINER,
    Image: IMAGE,
    Env: env,
    Labels: { 'agenthotel.role': 'netbird' },
    HostConfig: {
      NetworkMode: 'host',
      CapAdd: ['NET_ADMIN', 'SYS_ADMIN', 'SYS_RESOURCE'],
      Devices: devices,
      Binds: [`${VOLUME}:/var/lib/netbird`],
      RestartPolicy: { Name: 'unless-stopped' },
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } }
    }
  });
  await container.start();
  return { managementUrl: mgmt, hostname: peerName(hostname) };
}

module.exports = {
  status, logs, start, remove, normalizeManagementUrl, peerName, lastError,
  CONTAINER, IMAGE, VOLUME, CLOUD_MANAGEMENT_URL, ORIGIN_PORT, MESH_RANGE
};

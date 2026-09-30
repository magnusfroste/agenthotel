// Which host paths a guest may have mounted.
//
// A Docker App volume written as an absolute path is a bind mount of the host,
// and it went straight into HostConfig.Binds. The panel's README says agents
// cannot reach the Docker socket; one line — /var/run/docker.sock:/sock —
// made that false, and with it any agent, or any MCP client allowed to create
// agents, held root on the host (review, 2026-09-30).
//
// A deny list rather than an allow list, deliberately: mounting a media library
// or a shared folder into an app is the ordinary reason this field exists, and
// an allow list would break every one of those. What is refused is the host's
// control surfaces and the panel's own state.

const path = require('path');

const DENIED = [
  '/etc', '/proc', '/sys', '/dev', '/boot', '/root',
  '/run', '/var/run',                 // the Docker and containerd sockets live here
  '/var/lib/docker',                  // every container's filesystem and volume
  '/var/lib/containerd',
  '/var/lib/agenthotel',              // compose checkouts, with their .env secrets
  '/opt/agenthotel',                  // the panel's own install
  '/usr', '/bin', '/sbin', '/lib', '/lib64',
];

// Why a host path may not be mounted, or null when it may.
function hostPathRefusal(source) {
  const raw = String(source || '');
  if (!raw.startsWith('/')) return null;          // a named volume, not the host
  const normalized = path.posix.normalize(raw);   // resolves . and .., collapses //
  if (normalized === '/') return 'the host root';
  if (/docker\.sock|containerd\.sock/.test(normalized)) return 'a container runtime socket';
  for (const denied of DENIED) {
    if (normalized === denied || normalized.startsWith(denied + '/')) return `${denied} on the host`;
  }
  return null;
}

// Throws on the first volume that mounts something it must not, naming it.
function assertSafeVolumes(volumes) {
  for (const spec of volumes || []) {
    if (typeof spec !== 'string') continue;
    const source = spec.split(':')[0];
    const reason = hostPathRefusal(source);
    if (reason) {
      throw new Error(`Volume "${spec}" would mount ${reason} into a guest. Agents must not reach the host's control surfaces — use a named volume or a directory of your own, such as /srv/<app>.`);
    }
  }
}

module.exports = { hostPathRefusal, assertSafeVolumes, DENIED };

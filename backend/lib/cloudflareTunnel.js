// Cloudflare Tunnel as an alternative front door.
//
// The panel's normal ingress needs ports 80 and 443 free and reachable, a DNS
// A record pointing at the VPS, and Let's Encrypt able to validate — three
// things that can fail before the operator has even seen the panel. A tunnel
// removes all three: cloudflared dials out, so nothing is exposed inbound and
// no certificate is issued locally. It also works behind NAT.
//
// Caddy is not replaced. The tunnel points at it, so every per-agent route the
// panel already manages keeps working — the tunnel is just another door into
// the same hallway.

const CONTAINER = 'agenthotel-cloudflared';
const IMAGE = 'cloudflare/cloudflared:latest';
// Public hostnames in the Cloudflare dashboard point here. Caddy routes on the
// Host header exactly as it does for a direct request.
const ORIGIN = 'http://agenthotel-caddy:80';

function panelNetwork(docker) {
  // Join whatever network the panel itself is on, rather than assuming the
  // compose project name — an operator who renamed the directory would
  // otherwise get a tunnel that cannot reach Caddy.
  return docker.getContainer('agenthotel-caddy').inspect()
    .then(info => Object.keys(info.NetworkSettings.Networks)[0] || 'agenthotel_agenthotel');
}

// The cloudflared build inside the running container. Parsed from its own
// `--version`, since the image tag says only "latest".
async function runningVersion(docker) {
  try {
    const exec = await docker.getContainer(CONTAINER).exec({
      Cmd: ['cloudflared', '--version'], AttachStdout: true, AttachStderr: true
    });
    const stream = await exec.start();
    const chunks = [];
    await new Promise((resolve, reject) => {
      stream.on('data', c => chunks.push(c));
      stream.on('end', resolve);
      stream.on('error', reject);
      setTimeout(resolve, 5000);
    });
    // demuxDockerBuffer returns a Buffer; matching on one never matches.
    const out = String(require('./demux').demuxDockerBuffer(Buffer.concat(chunks)));
    const m = out.match(/cloudflared version (\S+)/);
    return m ? m[1] : null;
  } catch (err) {
    return null;
  }
}

async function status(docker) {
  try {
    const info = await docker.getContainer(CONTAINER).inspect();
    return {
      installed: true,
      running: !!info.State.Running,
      state: info.State.Status,
      restartCount: info.RestartCount || 0,
      startedAt: info.State.StartedAt,
      // What is actually running, so an operator can see it has fallen behind
      // without opening a shell. Restarting the tunnel pulls the current one.
      version: await runningVersion(docker)
    };
  } catch (err) {
    return { installed: false, running: false, state: 'absent' };
  }
}

async function logs(docker, tail = 40) {
  try {
    const buf = await docker.getContainer(CONTAINER).logs({ stdout: true, stderr: true, tail });
    return require('./demux').demuxDockerBuffer(buf).trim();
  } catch (err) {
    return '';
  }
}

async function remove(docker) {
  try {
    const c = docker.getContainer(CONTAINER);
    try { await c.stop(); } catch (e) {}
    await c.remove({ force: true });
  } catch (err) {
    if (err.statusCode !== 404) throw err;
  }
}

async function start(docker, token) {
  if (!token || typeof token !== 'string' || token.length < 20) {
    throw new Error('A Cloudflare tunnel token is required');
  }
  await remove(docker);

  // Always ask for the current :latest. Pulling only when the image was
  // missing froze the tunnel at whatever version was first installed — and it
  // runs with --no-autoupdate, so nothing else ever moved it. One panel sat on
  // cloudflared 2026.8.3 for three weeks while :latest was two releases ahead.
  //
  // Best effort: a registry that cannot be reached must not leave the panel
  // without a tunnel, so a failed pull falls back to the image on disk. Only a
  // missing image is fatal.
  try {
    const stream = await docker.pull(IMAGE);
    await new Promise((res, rej) => docker.modem.followProgress(stream, err => err ? rej(err) : res()));
  } catch (err) {
    console.warn(`[Tunnel] Could not pull ${IMAGE} (${err.message}) — using the image on disk`);
    await docker.getImage(IMAGE).inspect();
  }

  const network = await panelNetwork(docker);
  // The token is passed as an argument rather than TUNNEL_TOKEN so that a
  // `docker inspect` and the panel's own container list show the same thing —
  // it is a secret either way, and hiding it in the environment only makes it
  // harder to see where it went.
  const container = await docker.createContainer({
    name: CONTAINER,
    Image: IMAGE,
    Cmd: ['tunnel', '--no-autoupdate', 'run', '--token', token],
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: network,
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } }
    }
  });
  await container.start();
  return { network, origin: ORIGIN };
}

module.exports = { status, logs, start, remove, CONTAINER, IMAGE, ORIGIN };

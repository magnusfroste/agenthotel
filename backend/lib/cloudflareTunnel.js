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

async function status(docker) {
  try {
    const info = await docker.getContainer(CONTAINER).inspect();
    return {
      installed: true,
      running: !!info.State.Running,
      state: info.State.Status,
      restartCount: info.RestartCount || 0,
      startedAt: info.State.StartedAt
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

  try { await docker.getImage(IMAGE).inspect(); }
  catch (e) {
    const stream = await docker.pull(IMAGE);
    await new Promise((res, rej) => docker.modem.followProgress(stream, err => err ? rej(err) : res()));
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

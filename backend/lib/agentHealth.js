// "The container is running" and "the agent works" are different questions,
// and the panel only ever asked the first one. agents.status was written as
// 'running' at deploy time and never reconciled against reality, so an
// OOM-killed openclaw restart-looping behind a 502 showed up green on the
// dashboard for an hour with nothing to say otherwise.
//
// A runtime knows what working means for it, so it declares a criterion
// (plugin.healthCheck) and this evaluates it. Runtimes that declare nothing
// fall back to Docker's own HEALTHCHECK when the image has one, and to the
// container's running state when it does not — never worse than before.

const RESTART_LOOP_THRESHOLD = 3;

function containerIp(info) {
  const nets = (info.NetworkSettings && info.NetworkSettings.Networks) || {};
  for (const net of Object.values(nets)) {
    if (net && net.IPAddress) return net.IPAddress;
  }
  return null;
}

async function probeHttp(fetch, info, agent, plugin, spec) {
  const ip = containerIp(info);
  if (!ip) return { healthy: false, reason: 'container has no network address' };
  const port = spec.port || agent.port || plugin.defaultPort;
  if (!port) return { healthy: false, reason: 'no port to probe' };

  const path = spec.path || '/';
  const limit = spec.expectBelow || 500;
  try {
    const res = await fetch(`http://${ip}:${port}${path}`, { timeout: 8000, redirect: 'manual' });
    // A login redirect or a 401 means the app is up and answering; only a
    // server-side failure counts as unhealthy.
    return res.status < limit
      ? { healthy: true, reason: `HTTP ${res.status}` }
      : { healthy: false, reason: `HTTP ${res.status}` };
  } catch (err) {
    return { healthy: false, reason: `unreachable: ${err.message}` };
  }
}

async function probeExec(docker, info, spec) {
  try {
    const exec = await docker.getContainer(info.Id).exec({
      Cmd: spec.cmd, AttachStdout: true, AttachStderr: true, Tty: false
    });
    const stream = await exec.start({ Tty: false });
    await new Promise(resolve => { stream.on('end', resolve); stream.on('error', resolve); stream.resume(); });
    const details = await exec.inspect();
    return details.ExitCode === 0
      ? { healthy: true, reason: 'exec exit 0' }
      : { healthy: false, reason: `exec exit ${details.ExitCode}` };
  } catch (err) {
    return { healthy: false, reason: `exec failed: ${err.message}` };
  }
}

/**
 * Resolve an agent's real state.
 * Returns { state, healthy, reason } where state is one of:
 * missing | stopped | restarting | unhealthy | healthy | running
 */
async function evaluateHealth(docker, fetch, agent, plugin) {
  let info;
  try {
    info = await docker.getContainer(`agenthotel-${agent.id}`).inspect();
  } catch (_) {
    return { state: 'missing', healthy: false, reason: 'container not found' };
  }

  if (!info.State.Running) {
    return { state: 'stopped', healthy: false, reason: `container ${info.State.Status}` };
  }

  // A container that keeps dying and being restarted is not healthy no matter
  // what a probe says between restarts — this is precisely the shape of the
  // OOM-at-boot failure, which otherwise reads as "running".
  if ((info.RestartCount || 0) >= RESTART_LOOP_THRESHOLD) {
    return { state: 'restarting', healthy: false, reason: `restarted ${info.RestartCount} times` };
  }

  // A runtime that hosts arbitrary apps cannot declare one criterion for all
  // of them: Git App and Docker App guests may serve HTTP, speak some other
  // protocol, or listen on nothing at all. So the guest itself can name a path
  // to probe, and only then is it held to it — a criterion that fires wrongly
  // on a worker container would be worse than none.
  let spec = plugin && plugin.healthCheck;
  if (!spec) {
    let cfg = {};
    try { cfg = JSON.parse(agent.config || '{}'); } catch (e) {}
    if (cfg.HEALTHCHECK_PATH) {
      spec = { type: 'http', path: cfg.HEALTHCHECK_PATH, expectBelow: 500 };
    }
  }

  if (!spec) {
    const dockerHealth = info.State.Health && info.State.Health.Status;
    if (dockerHealth === 'healthy') return { state: 'healthy', healthy: true, reason: 'docker healthcheck' };
    if (dockerHealth === 'unhealthy') return { state: 'unhealthy', healthy: false, reason: 'docker healthcheck' };
    if (dockerHealth === 'starting') return { state: 'running', healthy: true, reason: 'docker healthcheck starting' };
    return { state: 'running', healthy: true, reason: 'container running (no criterion declared)' };
  }

  const result = spec.type === 'exec'
    ? await probeExec(docker, info, spec)
    : await probeHttp(fetch, info, agent, plugin, spec);

  return {
    state: result.healthy ? 'healthy' : 'unhealthy',
    healthy: result.healthy,
    reason: result.reason
  };
}

module.exports = { evaluateHealth };

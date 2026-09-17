// Run one command inside an agent's container.
//
// Extracted so the MCP tool, the panel's template actions and anything else
// that needs a shell in a guest share one implementation — the output demux,
// the timeout, the size cap and the "run as the runtime's own user" rule are
// each easy to get subtly wrong, and two copies drift.

const { demuxDockerBuffer } = require('./demux');

const OUTPUT_CAP = 256 * 1024; // a runaway command must not flood the caller
const MAX_TIMEOUT_MS = 300000;

async function execInAgent(docker, agentId, command, { timeoutMs = 60000, user = null, container: containerName = null } = {}) {
  const cmd = String(command || '').trim();
  if (!cmd) throw new Error('command is required');

  const container = docker.getContainer(containerName || `agenthotel-${agentId}`);
  const info = await container.inspect().catch(() => null);
  if (!info || !info.State.Running) throw new Error('Agent is not running');

  // Run as the runtime's own user where it declares one. OpenClaw's state
  // volumes belong to `node`; a root shell there leaves root-owned files it
  // can no longer write.
  const exec = await container.exec({
    Cmd: ['/bin/sh', '-c', cmd],
    AttachStdout: true, AttachStderr: true, Tty: false,
    ...(user ? { User: user } : {})
  });
  const stream = await exec.start({ Tty: false });

  const chunks = [];
  let size = 0;
  const limit = Math.min(parseInt(timeoutMs) || 60000, MAX_TIMEOUT_MS);
  const reason = await new Promise((resolve) => {
    const timer = setTimeout(() => { try { stream.destroy(); } catch (_) {} resolve('timeout'); }, limit);
    stream.on('data', (c) => { if (size < OUTPUT_CAP) { chunks.push(c); size += c.length; } });
    stream.on('end', () => { clearTimeout(timer); resolve('end'); });
    stream.on('error', () => { clearTimeout(timer); resolve('error'); });
  });

  const details = await exec.inspect().catch(() => ({}));
  return {
    exitCode: details.ExitCode ?? null,
    timedOut: reason === 'timeout',
    truncated: size >= OUTPUT_CAP,
    output: demuxDockerBuffer(Buffer.concat(chunks)).toString('utf8')
  };
}

module.exports = { execInAgent };

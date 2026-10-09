// A browser chat pane talks to an agent over the Agent Client Protocol (ACP,
// https://agentclientprotocol.com): JSON-RPC 2.0, one message per line, on the
// agent's stdin and stdout. Hermes (`hermes acp`) and OpenClaw (`openclaw acp`)
// both speak it. This module starts the agent's ACP command inside its own
// container — the same `docker exec` the Console tab uses, without a TTY — and
// carries lines between it and one WebSocket. The protocol itself (initialize,
// session/new, session/prompt, permission requests) is the browser's business;
// this side only moves lines and cleans up.
//
// Every pane is its own process. `hermes acp` is a full Hermes (200-300 MB), so
// the number of live sessions is capped per agent and in total, and a session
// ends with its WebSocket: stdin is closed, and the process is sent SIGTERM if
// it has not gone a few seconds later.

const { PassThrough } = require('stream');

const MAX_PER_AGENT = 4;
const MAX_TOTAL = 8;
// A single message larger than this is not a chat message; drop the line
// rather than let one runaway write grow memory without bound.
const MAX_LINE = 4 * 1024 * 1024;
const STDERR_TAIL = 40;

const live = new Map(); // agentId -> Set of sessions

function liveCount(agentId) {
  if (agentId) return live.get(agentId)?.size || 0;
  let total = 0;
  for (const set of live.values()) total += set.size;
  return total;
}

// Why a new session would be refused, or null.
function capacityError(agentId) {
  if (liveCount(agentId) >= MAX_PER_AGENT) {
    return `This agent already has ${MAX_PER_AGENT} chats open. Close one first.`;
  }
  if (liveCount() >= MAX_TOTAL) {
    return `${MAX_TOTAL} chats are open across the hotel. Close one first.`;
  }
  return null;
}

// Splits a byte stream into lines; calls onLine(string) for each complete one.
function lineSplitter(onLine) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.trim()) onLine(line);
    }
    if (buffer.length > MAX_LINE) buffer = '';
  };
}

// Starts `command` in the container and returns
// { send(line), close(), onLine(cb), onExit(cb), stderrTail() }.
async function openAcpSession(docker, { agentId, containerName, command, user = null, cwd = null }) {
  const container = docker.getContainer(containerName);
  const info = await container.inspect().catch(() => null);
  if (!info || !info.State.Running) throw new Error('The agent is not running');

  const exec = await container.exec({
    Cmd: command,
    AttachStdin: true, AttachStdout: true, AttachStderr: true,
    Tty: false,
    ...(user ? { User: user } : {}),
    ...(cwd ? { WorkingDir: cwd } : {})
  });
  const stream = await exec.start({ hijack: true, stdin: true });

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(stream, stdout, stderr);

  const lineHandlers = [];
  const exitHandlers = [];
  const stderrLines = [];
  let closed = false;

  stdout.on('data', lineSplitter(line => lineHandlers.forEach(cb => cb(line))));
  stderr.on('data', lineSplitter(line => {
    stderrLines.push(line);
    if (stderrLines.length > STDERR_TAIL) stderrLines.shift();
  }));

  const session = {
    send(line) {
      if (closed || stream.destroyed) return false;
      stream.write(String(line).replace(/\n/g, ' ') + '\n');
      return true;
    },
    onLine(cb) { lineHandlers.push(cb); },
    onExit(cb) { exitHandlers.push(cb); },
    stderrTail() { return stderrLines.slice(); },
    async close() {
      if (closed) return;
      closed = true;
      forget();
      // EOF on stdin is how an ACP agent is told the client has gone.
      try { stream.end(); } catch (_) {}
      // A process that ignores EOF is stopped from the host: the backend runs
      // in the host PID namespace, and exec inspect gives the host pid.
      setTimeout(async () => {
        try {
          const state = await exec.inspect();
          if (state.Running && state.Pid) process.kill(state.Pid, 'SIGTERM');
        } catch (_) { /* already gone */ }
        try { stream.destroy(); } catch (_) {}
      }, 3000).unref?.();
    }
  };

  const set = live.get(agentId) || new Set();
  set.add(session);
  live.set(agentId, set);
  function forget() {
    const current = live.get(agentId);
    if (!current) return;
    current.delete(session);
    if (!current.size) live.delete(agentId);
  }

  const ended = () => {
    if (!closed) { closed = true; forget(); }
    exitHandlers.splice(0).forEach(cb => cb());
  };
  stream.on('end', ended);
  stream.on('close', ended);
  stream.on('error', ended);

  return session;
}

module.exports = { openAcpSession, capacityError, liveCount, lineSplitter, MAX_PER_AGENT, MAX_TOTAL };

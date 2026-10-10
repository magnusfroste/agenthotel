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
// the number of live sessions is capped per agent and in total, and none is
// started while the host is short of memory.
//
// A session outlives its WebSocket for a while. Reloading the page, leaving
// the Chat page or a network blip used to end the process and the
// conversation with it. Now a closed socket detaches the session: it keeps
// running (a turn in progress finishes) for DETACH_GRACE_MS, or until its turn
// is done if that takes longer (up to DETACH_MAX_MS), and a pane that comes
// back with the session's key reattaches to it. Past that the process ends,
// and the pane restores the conversation with ACP session/load in a new one —
// the agent keeps its own transcript. An attached session idle for IDLE_MS
// with no turn running is ended the same way, so a forgotten tab stops
// holding a Hermes in memory (davida held eleven, 2026-10-10).
//
// Ending a session: stdin is closed, and the process is sent SIGTERM if it has
// not gone a few seconds later.

const crypto = require('crypto');
const fs = require('fs');
const { PassThrough } = require('stream');

const MAX_PER_AGENT = 4;
const MAX_TOTAL = 8;
const DETACH_GRACE_MS = 2 * 60 * 1000;
const DETACH_MAX_MS = 15 * 60 * 1000;
const IDLE_MS = 30 * 60 * 1000;
// A new session needs about this much free memory on the host.
const MIN_FREE_MB = 400;
const SWEEP_MS = 15 * 1000;
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

// The host's available memory in MB, or null when it cannot be read. The
// backend shares the host's /proc/meminfo.
function hostAvailableMB(read = () => fs.readFileSync('/proc/meminfo', 'utf8')) {
  try {
    const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(read());
    return m ? Math.round(parseInt(m[1], 10) / 1024) : null;
  } catch (_) { return null; }
}

// Why a new session would be refused, or null.
function capacityError(agentId, availableMB = hostAvailableMB()) {
  if (liveCount(agentId) >= MAX_PER_AGENT) {
    return `This agent already has ${MAX_PER_AGENT} chats open. Close one first.`;
  }
  if (liveCount() >= MAX_TOTAL) {
    return `${MAX_TOTAL} chats are open across the hotel. Close one first.`;
  }
  if (availableMB !== null && availableMB < MIN_FREE_MB) {
    return `The server has only ${availableMB} MB of memory free — a chat needs about ${MIN_FREE_MB} MB. Close a chat or try again shortly.`;
  }
  return null;
}

// A detached session of this agent with this key, or null.
function findDetached(agentId, key) {
  if (!key) return null;
  for (const session of live.get(agentId) || []) {
    if (session.key === key && session.isDetached()) return session;
  }
  return null;
}

// Ends detached sessions past their grace and attached ones idle too long.
function sweep(now = Date.now()) {
  for (const set of live.values()) {
    for (const session of [...set]) session.sweep(now);
  }
}
setInterval(() => sweep(), SWEEP_MS).unref?.();

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

  let lineHandler = null;
  let idleHandler = null;
  let turnDoneHandler = null;
  const exitHandlers = [];
  const stderrLines = [];
  let closed = false;
  let detachedAt = null;
  let lastActivity = Date.now();
  // The browser's session/prompt requests still running: id -> the socket
  // generation that sent it. A turn finishing after the pane reconnected is
  // answered to a request id the new page never made, so the bridge says so.
  const prompts = new Map();
  let generation = 0;

  stdout.on('data', lineSplitter(line => {
    lastActivity = Date.now();
    if (prompts.size && line.includes('"id"') && (line.includes('"result"') || line.includes('"error"'))) {
      try {
        const message = JSON.parse(line);
        if (message.method === undefined && prompts.has(message.id)) {
          const from = prompts.get(message.id);
          prompts.delete(message.id);
          if (from !== generation && turnDoneHandler) turnDoneHandler();
        }
      } catch (_) { /* not JSON: pass it on as it is */ }
    }
    if (lineHandler) lineHandler(line);
  }));
  stderr.on('data', lineSplitter(line => {
    stderrLines.push(line);
    if (stderrLines.length > STDERR_TAIL) stderrLines.shift();
  }));

  const session = {
    key: crypto.randomBytes(16).toString('hex'),
    send(line) {
      if (closed || stream.destroyed) return false;
      const text = String(line).replace(/\n/g, ' ');
      lastActivity = Date.now();
      if (text.includes('"session/prompt"')) {
        try {
          const message = JSON.parse(text);
          if (message.method === 'session/prompt' && message.id !== undefined) prompts.set(message.id, generation);
        } catch (_) {}
      }
      stream.write(text + '\n');
      return true;
    },
    // One socket at a time: attaching replaces the previous one's handlers.
    attach({ onLine, onIdle, onTurnDone } = {}) {
      generation++;
      detachedAt = null;
      lastActivity = Date.now();
      lineHandler = onLine || null;
      idleHandler = onIdle || null;
      turnDoneHandler = onTurnDone || null;
    },
    // The socket went away: keep running for a pane that comes back.
    detach() {
      if (closed) return;
      lineHandler = idleHandler = turnDoneHandler = null;
      detachedAt = Date.now();
    },
    isDetached() { return !closed && detachedAt !== null; },
    busy() { return prompts.size > 0; },
    sweep(now = Date.now()) {
      if (closed) return;
      if (detachedAt !== null) {
        const away = now - detachedAt;
        if ((away >= DETACH_GRACE_MS && !prompts.size) || away >= DETACH_MAX_MS) session.close();
        return;
      }
      if (!prompts.size && now - lastActivity >= IDLE_MS) {
        const notify = idleHandler;
        session.close();
        if (notify) notify();
      }
    },
    onLine(cb) { session.attach({ onLine: cb }); },
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

module.exports = {
  openAcpSession, capacityError, liveCount, lineSplitter, findDetached, sweep, hostAvailableMB,
  MAX_PER_AGENT, MAX_TOTAL, DETACH_GRACE_MS, DETACH_MAX_MS, IDLE_MS, MIN_FREE_MB
};

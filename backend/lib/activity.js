// What is using the server right now, per guest: the panel's Activity view.
//
// 2026-11-15: two agents worked through the night (one building games, one
// filming takes), and the only question that mattered was "who is using the
// CPU and the memory?". The Fleet showed the host's totals; a guest's own
// page showed that guest. Nothing put them side by side, and nothing at all
// covered the build containers, which during a Git App deploy are often the
// heaviest thing on the host.
//
// One sampler for the whole panel. The live view runs only while someone is
// looking: the first request starts it, and it stops by itself when nobody
// has asked for a while. Beside it, one point a minute is kept for the last
// hour, always (see createActivity). A sample is one `docker stats` one-shot
// per running container (about 0.4 s for 27 containers), and CPU is the
// difference between two of
// them, so the first answer waits for a second sample.

const KINDS = ['agent', 'tool', 'app', 'build', 'hotel', 'other'];

// What a guest is, from the template library's category: an agent, a tool
// agents use (anything installed from a template), or an app someone checked
// in through Git App, Docker App or Compose without a template.
function kindOf(agent, meta = {}) {
  const category = meta[agent.template]?.category || meta[agent.runtime]?.category || '';
  if (category === 'AI Agent') return 'agent';
  if (agent.template) return 'tool';
  return 'app';
}

// Cores in use between two one-shot samples of one container. Docker's
// system_cpu_usage counts every core, so the share times the number of
// cores is what the container used, in cores (1.5 = one and a half).
function coresBetween(prev, cur) {
  if (!prev || !cur) return null;
  const dCpu = cur.cpu - prev.cpu;
  const dSys = cur.sys - prev.sys;
  if (!(dSys > 0) || dCpu < 0) return null;
  return (dCpu / dSys) * (cur.online || 1);
}

// Docker's raw `usage` counts reclaimable page cache; subtracting
// inactive_file matches `docker stats` (same as GET /api/agents/:id/stats).
function memoryOf(stats) {
  const m = stats.memory_stats || {};
  const cache = m.stats?.inactive_file ?? m.stats?.cache ?? 0;
  return { used: Math.max((m.usage || 0) - cache, 0), limit: m.limit || 0 };
}

function cpuOf(stats) {
  const c = stats.cpu_stats || {};
  return {
    cpu: c.cpu_usage?.total_usage || 0,
    sys: c.system_cpu_usage || 0,
    online: c.online_cpus || c.cpu_usage?.percpu_usage?.length || 1
  };
}

// Whose a container is. Guests carry the panel's labels; a compose guest's
// services carry their project's; the panel's own containers share its
// compose project. A container with none of these is, while a deploy runs,
// almost always that deploy's build step (the classic builder runs each RUN
// in an unnamed container), so it is shown as the build of what is deploying.
function ownerOf(container, ctx) {
  const labels = container.Labels || {};
  const byId = labels['agenthotel.id'] && ctx.agents.get(labels['agenthotel.id']);
  const project = labels['com.docker.compose.project'];
  const agent = byId || (project && ctx.projects.get(project));
  if (agent) {
    return { key: agent.id, name: agent.name, kind: kindOf(agent, ctx.meta), agentId: agent.id };
  }
  if (project && project === ctx.panelProject) {
    return { key: 'hotel', name: 'AgentHotel', kind: 'hotel', agentId: null };
  }
  const containerName = String((container.Names || [])[0] || container.Id || '').replace(/^\//, '');
  if (ctx.building.length && !labels['agenthotel.id'] && !project) {
    const names = ctx.building.map(b => b.name).join(', ');
    return { key: 'build', name: `Building ${names}`, kind: 'build', agentId: ctx.building.length === 1 ? ctx.building[0].id : null };
  }
  return { key: `other:${containerName}`, name: containerName, kind: 'other', agentId: null };
}

function readProcStat(fs) {
  const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
  const vals = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = vals[3] + (vals[4] || 0);
  return { idle, total: vals.reduce((a, b) => a + b, 0) };
}

function readMemory(fs) {
  const text = fs.readFileSync('/proc/meminfo', 'utf8');
  const kb = key => parseInt(text.match(new RegExp(key + ':\\s+(\\d+)'))?.[1] || 0, 10) * 1024;
  const total = kb('MemTotal');
  return { total, used: total - kb('MemAvailable') };
}

function push(list, value, keep) {
  list.push(value);
  if (list.length > keep) list.splice(0, list.length - keep);
}

// One reading of everything: the host's counters and every running
// container's, each with the guest it belongs to. Two series below turn
// readings into curves, each with its own previous reading, since CPU is
// the difference between two of them.
async function readAll({ docker, context, fs }) {
  const ctx = await context();
  const list = await docker.listContainers();
  const stats = await Promise.all(list.map(c =>
    docker.getContainer(c.Id).stats({ stream: false, 'one-shot': true }).catch(() => null)));
  const containers = [];
  list.forEach((c, i) => {
    const s = stats[i];
    if (!s) return;
    containers.push({ id: c.Id, owner: ownerOf(c, ctx), cpu: cpuOf(s), mem: memoryOf(s) });
  });
  return { hostCpu: readProcStat(fs), hostMem: readMemory(fs), containers };
}

// Curves of `keep` points from readings. `keepGone`: a guest that is no
// longer running stays, with empty points, until its last point slides out
// of the window. The hour keeps it, since "what was building twenty minutes
// ago" is the question; the live view drops it at once, as it always did.
function createSeries({ cores, intervalMs, keep, keepGone = false, now }) {
  let prevHost = null;
  let prevByContainer = new Map();
  const history = new Map(); // key → { owner, cpu: [], mem: [] }
  const hostHistory = { cpu: [], mem: [] };
  let latest = null;

  function reset() {
    prevHost = null;
    prevByContainer = new Map();
    history.clear();
    hostHistory.cpu.length = 0;
    hostHistory.mem.length = 0;
    latest = null;
  }

  function add({ hostCpu, hostMem, containers }) {
    let hostCores = null;
    if (prevHost) {
      const dTotal = hostCpu.total - prevHost.total;
      hostCores = dTotal > 0 ? (1 - (hostCpu.idle - prevHost.idle) / dTotal) * cores : null;
    }
    prevHost = hostCpu;

    const groups = new Map();
    const seen = new Map();
    for (const c of containers) {
      seen.set(c.id, c.cpu);
      const used = coresBetween(prevByContainer.get(c.id), c.cpu);
      const g = groups.get(c.owner.key) || { ...c.owner, cores: null, mem: 0, limit: 0, containers: 0 };
      if (used != null) g.cores = (g.cores || 0) + used;
      g.mem += c.mem.used;
      g.limit += c.mem.limit;
      g.containers += 1;
      groups.set(c.owner.key, g);
    }
    prevByContainer = seen;

    const items = [...groups.values()];
    for (const g of items) {
      const h = history.get(g.key) || { cpu: [], mem: [] };
      h.owner = { key: g.key, name: g.name, kind: g.kind, agentId: g.agentId };
      push(h.cpu, g.cores == null ? null : Math.round(g.cores * 1000) / 1000, keep);
      push(h.mem, g.mem, keep);
      history.set(g.key, h);
      g.history = h;
    }
    for (const [key, h] of history) {
      if (groups.has(key)) continue;
      if (!keepGone) { history.delete(key); continue; }
      push(h.cpu, null, keep);
      push(h.mem, null, keep);
      if (h.cpu.every(v => v == null) && h.mem.every(v => v == null)) { history.delete(key); continue; }
      items.push({ ...h.owner, cores: null, mem: 0, limit: 0, containers: 0, gone: true, history: h });
    }

    const live = items.filter(g => !g.gone);
    const sumCores = live.reduce((a, g) => a + (g.cores || 0), 0);
    const sumMem = live.reduce((a, g) => a + g.mem, 0);
    push(hostHistory.cpu, hostCores == null ? null : Math.round(hostCores * 1000) / 1000, keep);
    push(hostHistory.mem, hostMem.used, keep);

    const byKind = Object.fromEntries(KINDS.map(k => [k, { cores: 0, mem: 0, count: 0 }]));
    for (const g of live) {
      byKind[g.kind].cores += g.cores || 0;
      byKind[g.kind].mem += g.mem;
      byKind[g.kind].count += 1;
    }

    latest = {
      at: new Date(now()).toISOString(),
      intervalMs,
      ready: hostCores != null,
      host: {
        cores,
        cpu: hostCores,
        mem: hostMem,
        history: hostHistory
      },
      // What the host uses outside every container: the kernel, Docker
      // itself, the page cache it cannot give back. Never below zero, since
      // container and host samples are a few milliseconds apart.
      system: {
        cores: hostCores == null ? null : Math.max(hostCores - sumCores, 0),
        mem: Math.max(hostMem.used - sumMem, 0)
      },
      kinds: byKind,
      items: items.sort((a, b) => (b.cores || 0) - (a.cores || 0) || b.mem - a.mem)
    };
    return latest;
  }

  return { add, reset, latest: () => latest };
}

// `docker` is a dockerode instance; `context()` returns
// { agents: Map(id → row), projects: Map(compose project → row), meta,
//   panelProject, building: [{ id, name }] } at the time of a sample.
//
// Two views of the same readings:
// - live: every `intervalMs` (3 s) for the last `keep` points (3 min), only
//   while someone looks, as before.
// - hour: one point a minute for the last hour, always, so the view can show
//   what happened before anyone opened it (2026-11-20). It is kept in memory
//   only: 60 points per guest, gone when the panel restarts, never written
//   anywhere. A point's CPU is the average over its minute.
function createActivity({ docker, context, fs = require('fs'), cores = require('os').cpus().length,
  intervalMs = 3000, keep = 60, idleMs = 30000, hourIntervalMs = 60000, hourKeep = 60, firstHourMs = 2000,
  now = () => Date.now() } = {}) {
  let timer = null;
  let lastAsked = 0;
  let sampling = null;
  const live = createSeries({ cores, intervalMs, keep, now });
  const hour = createSeries({ cores, intervalMs: hourIntervalMs, keep: hourKeep, keepGone: true, now });
  let hourTimer = null;
  let hourSince = null;

  function sampleOnce() {
    if (!sampling) sampling = readAll({ docker, context, fs }).then(r => live.add(r)).finally(() => { sampling = null; });
    return sampling;
  }

  function loop() {
    timer = setTimeout(async () => {
      if (now() - lastAsked > idleMs) { timer = null; return; }
      try { await sampleOnce(); } catch (_) { /* next tick */ }
      loop();
    }, intervalMs);
    if (timer.unref) timer.unref();
  }

  // The latest live snapshot. Starts the sampler when it is idle; the first
  // answer after a start waits for two samples so CPU is known.
  async function snapshot() {
    lastAsked = now();
    if (!timer) {
      const latest = live.latest();
      if (!latest || !latest.ready || now() - Date.parse(latest.at) > intervalMs * 2) {
        // After a pause the old curves would join across the gap as if
        // nothing happened in between; start them over instead.
        live.reset();
        await sampleOnce();
        await new Promise(r => setTimeout(r, 1000));
        await sampleOnce();
      }
      loop();
    }
    return live.latest();
  }

  async function sampleHour() {
    try { hour.add(await readAll({ docker, context, fs })); } catch (_) { /* next minute */ }
  }

  // The hour's series: one point a minute from start(), never more than an
  // hour of them. Asking for it starts nothing.
  function hourSnapshot() {
    const latest = hour.latest();
    if (latest && latest.ready) return { ...latest, since: hourSince };
    return { ready: false, since: hourSince, intervalMs: hourIntervalMs };
  }

  // The first point comes a moment after start (the panel is still setting
  // up when it calls this), the next ones a minute apart.
  function start() {
    if (hourTimer) return;
    hourSince = new Date(now()).toISOString();
    hourTimer = setTimeout(function tick() {
      sampleHour();
      hourTimer = setTimeout(tick, hourIntervalMs);
      if (hourTimer.unref) hourTimer.unref();
    }, firstHourMs);
    if (hourTimer.unref) hourTimer.unref();
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (hourTimer) clearTimeout(hourTimer);
    hourTimer = null;
  }

  return { snapshot, hourSnapshot, sample: sampleOnce, sampleHour, start, stop };
}

module.exports = { createActivity, createSeries, kindOf, coresBetween, memoryOf, ownerOf, KINDS };

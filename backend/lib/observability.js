// Host, Docker and fleet metrics for the MCP observability tools. The REST
// stats endpoint in server.js predates this module and keeps its own shape;
// new consumers should read from here.
//
// Everything here is read-only and cheap enough to call on a polling loop —
// the one exception is collectAgentStats(), which asks Docker for a stats
// sample per container and therefore costs a round trip per agent.
const fs = require('fs');

function readProcStat() {
  const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
  const vals = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = vals[3] + (vals[4] || 0);
  const total = vals.reduce((a, b) => a + b, 0);
  return { idle, total };
}

// CPU percentage needs two samples; 300ms keeps the call responsive while
// still being long enough not to be dominated by scheduler noise.
async function collectHostMetrics() {
  const t1 = readProcStat();
  await new Promise((r) => setTimeout(r, 300));
  const t2 = readProcStat();
  const idleDelta = t2.idle - t1.idle;
  const totalDelta = t2.total - t1.total;
  const cpuPercent = totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 1000) / 10 : 0;

  const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
  const kb = (key) => parseInt(meminfo.match(new RegExp(key + ':\\s+(\\d+)'))?.[1] || 0, 10) * 1024;
  const memTotal = kb('MemTotal');
  const memAvailable = kb('MemAvailable');
  const swapTotal = kb('SwapTotal');

  let disk = { total: 0, used: 0, percent: 0 };
  try {
    const { execSync } = require('child_process');
    const df = execSync('df -B1 / 2>/dev/null | tail -1').toString().trim().split(/\s+/);
    const total = parseInt(df[1], 10) || 0;
    const used = parseInt(df[2], 10) || 0;
    disk = { total, used, percent: total ? Math.round((used / total) * 1000) / 10 : 0 };
  } catch (_) {}

  let load = [0, 0, 0];
  let cores = 1;
  try {
    load = fs.readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/).slice(0, 3).map(Number);
    cores = (fs.readFileSync('/proc/cpuinfo', 'utf8').match(/^processor\s*:/gm) || []).length || 1;
  } catch (_) {}

  return {
    cpu: { percent: cpuPercent, cores, load1: load[0], load5: load[1], load15: load[2] },
    memory: {
      total: memTotal,
      available: memAvailable,
      used: memTotal - memAvailable,
      percent: memTotal ? Math.round(((memTotal - memAvailable) / memTotal) * 1000) / 10 : 0,
      swapTotal
    },
    disk
  };
}

// Docker's own disk accounting, including the build cache the panel's cleanup
// reclaims. Sizes are bytes; `reclaimable` is what a prune would free.
async function collectDockerUsage(docker) {
  const df = await docker.df();
  const sum = (rows, field) => (rows || []).reduce((a, r) => a + (r[field] || 0), 0);

  const images = df.Images || [];
  const containers = df.Containers || [];
  const volumes = df.Volumes || [];
  const buildCache = df.BuildCache || [];

  return {
    images: {
      count: images.length,
      size: sum(images, 'Size'),
      // An image with no container referencing it is reclaimable.
      reclaimable: images.filter((i) => !i.Containers || i.Containers < 1).reduce((a, i) => a + (i.Size || 0), 0)
    },
    containers: { count: containers.length, size: sum(containers, 'SizeRw') },
    volumes: { count: volumes.length, size: volumes.reduce((a, v) => a + (v.UsageData?.Size || 0), 0) },
    buildCache: {
      count: buildCache.length,
      size: sum(buildCache, 'Size'),
      reclaimable: buildCache.filter((c) => !c.InUse).reduce((a, c) => a + (c.Size || 0), 0)
    }
  };
}

// Live CPU/memory/network per agent. Docker's single-shot stats sample carries
// precpu_stats, so one call per container is enough to derive a percentage.
async function collectAgentStats(docker, db) {
  const agents = db.prepare('SELECT id, name, runtime FROM agents').all();
  const out = await Promise.all(agents.map(async (agent) => {
    const base = { id: agent.id, name: agent.name, runtime: agent.runtime };
    try {
      const container = docker.getContainer(`agenthotel-${agent.id}`);
      const info = await container.inspect();
      if (!info.State.Running) {
        return { ...base, running: false, status: info.State.Status };
      }
      const s = await container.stats({ stream: false });
      const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage || 0) - (s.precpu_stats?.cpu_usage?.total_usage || 0);
      const sysDelta = (s.cpu_stats?.system_cpu_usage || 0) - (s.precpu_stats?.system_cpu_usage || 0);
      const cpus = s.cpu_stats?.online_cpus || 1;
      const cpuPercent = sysDelta > 0 ? Math.round((cpuDelta / sysDelta) * cpus * 1000) / 10 : 0;

      // Docker counts page cache in usage; subtracting it matches what
      // `docker stats` shows and is what actually matters against the limit.
      const cache = s.memory_stats?.stats?.inactive_file ?? s.memory_stats?.stats?.cache ?? 0;
      const memUsed = Math.max((s.memory_stats?.usage || 0) - cache, 0);
      const memLimit = s.memory_stats?.limit || 0;

      const net = Object.values(s.networks || {}).reduce(
        (a, n) => ({ rx: a.rx + (n.rx_bytes || 0), tx: a.tx + (n.tx_bytes || 0) }), { rx: 0, tx: 0 }
      );

      return {
        ...base,
        running: true,
        restartCount: info.RestartCount || 0,
        startedAt: info.State.StartedAt,
        oomKilled: !!info.State.OOMKilled,
        cpuPercent,
        memory: {
          used: memUsed,
          limit: memLimit,
          percent: memLimit ? Math.round((memUsed / memLimit) * 1000) / 10 : 0
        },
        network: net
      };
    } catch (err) {
      return { ...base, running: false, error: err.message };
    }
  }));
  return out;
}

// Uptime rollup from the panel's 60s probes.
function collectUptime(db, hours = 24) {
  // Join against agents so a deleted agent's leftover probes can't surface as a
  // phantom "0% uptime" finding.
  const rows = db.prepare(`
    SELECT u.agent_id,
           COUNT(*)                AS checks,
           SUM(u.ok)               AS ok,
           AVG(u.latency_ms)       AS avg_latency,
           MAX(u.latency_ms)       AS max_latency
    FROM uptime_checks u
    JOIN agents a ON a.id = u.agent_id
    WHERE u.checked_at >= datetime('now', ?)
    GROUP BY u.agent_id
  `).all(`-${hours} hours`);

  const names = new Map(db.prepare('SELECT id, name FROM agents').all().map((a) => [a.id, a.name]));

  return rows.map((r) => {
    const failures = db.prepare(`
      SELECT checked_at, status_code FROM uptime_checks
      WHERE agent_id = ? AND ok = 0 AND checked_at >= datetime('now', ?)
      ORDER BY checked_at DESC LIMIT 5
    `).all(r.agent_id, `-${hours} hours`);

    return {
      agent_id: r.agent_id,
      name: names.get(r.agent_id) || r.agent_id,
      windowHours: hours,
      checks: r.checks,
      failed: r.checks - r.ok,
      uptimePercent: r.checks ? Math.round((r.ok / r.checks) * 10000) / 100 : null,
      avgLatencyMs: r.avg_latency == null ? null : Math.round(r.avg_latency),
      maxLatencyMs: r.max_latency ?? null,
      recentFailures: failures
    };
  });
}

// Turns the raw numbers above into a verdict an operator (or an agent acting
// as one) can act on without knowing the panel's internals. Thresholds are
// deliberately conservative: this host is small, and the panel's own guardrails
// only protect it once contention has already started.
function buildHealthReport({ host, dockerUsage, agentStats, uptime, expectedAgents }) {
  const findings = [];
  const add = (severity, area, message, hint) => findings.push({ severity, area, message, ...(hint ? { hint } : {}) });

  if (host.disk.percent >= 90) add('critical', 'disk', `Disk ${host.disk.percent}% full`, 'Run the run_cleanup tool; build cache is usually the bulk of it.');
  else if (host.disk.percent >= 80) add('warning', 'disk', `Disk ${host.disk.percent}% full`, 'Consider run_cleanup before the next image build.');

  const freeMem = host.memory.available;
  if (freeMem < 256 * 1024 * 1024) add('critical', 'memory', `Only ${(freeMem / 1024 / 1024).toFixed(0)} MB memory available`);
  else if (freeMem < 768 * 1024 * 1024) add('warning', 'memory', `Memory headroom low (${(freeMem / 1024 / 1024).toFixed(0)} MB available)`);
  if (host.memory.swapTotal === 0 && host.memory.percent > 85) {
    add('warning', 'memory', 'Memory pressure with no swap configured — the kernel will OOM-kill rather than swap.');
  }

  if (host.cpu.load5 > host.cpu.cores * 2) {
    add('warning', 'cpu', `Load ${host.cpu.load5} over ${host.cpu.cores} core(s) sustained`);
  }

  for (const a of agentStats) {
    if (!a.running) {
      add('critical', 'agent', `Agent "${a.name}" is not running${a.status ? ` (${a.status})` : ''}`, 'Inspect with get_agent_logs, then start_agent.');
      continue;
    }
    if (a.oomKilled) add('critical', 'agent', `Agent "${a.name}" was OOM-killed`, 'Raise MEMORY_LIMIT_MB or reduce its workload.');
    if (a.restartCount >= 3) add('warning', 'agent', `Agent "${a.name}" has restarted ${a.restartCount} times`);
    if (a.memory?.percent >= 90) add('warning', 'agent', `Agent "${a.name}" at ${a.memory.percent}% of its memory limit`);
  }

  for (const u of uptime) {
    if (u.uptimePercent != null && u.uptimePercent < 99 && u.checks >= 10) {
      add('warning', 'uptime', `Agent "${u.name}" at ${u.uptimePercent}% uptime over ${u.windowHours}h (${u.failed} failed probe(s))`);
    }
  }

  const cacheGB = dockerUsage.buildCache.reclaimable / 1024 / 1024 / 1024;
  if (cacheGB >= 2) add('info', 'disk', `${cacheGB.toFixed(1)} GB of reclaimable build cache`, 'run_cleanup frees it without affecting running agents.');

  if (typeof expectedAgents === 'number' && agentStats.length !== expectedAgents) {
    add('warning', 'fleet', `Panel lists ${expectedAgents} agent(s) but ${agentStats.length} were inspected`);
  }

  const rank = { critical: 3, warning: 2, info: 1 };
  findings.sort((a, b) => rank[b.severity] - rank[a.severity]);

  const status = findings.some((f) => f.severity === 'critical') ? 'critical'
    : findings.some((f) => f.severity === 'warning') ? 'degraded'
    : 'healthy';

  return { status, findings };
}

module.exports = { collectHostMetrics, collectDockerUsage, collectAgentStats, collectUptime, buildHealthReport };

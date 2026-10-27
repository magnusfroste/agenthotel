// Which agents could be updated, for a marker on the Fleet cards and in the
// sidebar. The agent page already said so one agent at a time ("A newer
// Hermes Agent is published upstream"); finding out meant opening every
// agent (2026-10-27).
//
// Two kinds of guest can tell:
// - a Git App: the commit it was built from (the deploy log) against the one
//   its ref names now (`git ls-remote`). A redeploy builds the new one.
// - a runtime built from a template (Hermes, OpenClaw): the image the panel
//   holds now against the one the agent runs (a redeploy picks it up), and
//   the upstream base image against the one the template was built on (a
//   rebuild picks that up).
// Anything else — a docker-app image, a compose stack — has no reliable
// "latest" to compare with, and shows nothing rather than a wrong marker.

const short = (sha) => String(sha || '').trim().toLowerCase().slice(0, 7);

// A Git App is behind when both commits are known and differ. An unknown on
// either side (never deployed through the log, ls-remote failed) says nothing.
function gitStatus(deployedCommit, remoteCommit) {
  const current = short(deployedCommit);
  const latest = short(remoteCommit);
  if (!current || !latest) return null;
  return { kind: 'git', current, latest, updateAvailable: current !== latest, action: 'redeploy' };
}

// A template runtime is behind when the panel already has a newer image of it
// (redeploy), or when upstream published a newer base than the template was
// built on (rebuild). The first wins: it is the cheaper step.
function runtimeStatus({ version = null, behindPanel = false, upstreamNewer = false }) {
  if (behindPanel) return { kind: 'runtime', current: version, updateAvailable: true, action: 'redeploy', reason: 'the panel has a newer build of this runtime' };
  if (upstreamNewer) return { kind: 'runtime', current: version, updateAvailable: true, action: 'rebuild', reason: 'a newer version is published upstream' };
  return { kind: 'runtime', current: version, updateAvailable: false };
}

// Runs `fn` over `items`, at most `limit` at a time.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]).catch(() => null);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const TTL_MS = 15 * 60 * 1000;
let cache = null; // { at, value }
let running = null;

// { checkedAt, agents: { [id]: status } } for every agent that can tell.
// Cached for a quarter of an hour: every page load would otherwise ask
// GitHub and the registry about every guest.
async function collect({ db, docker, runtimes, runtimeImage, containerNameFor }, { refresh = false, now = Date.now() } = {}) {
  if (!refresh && cache && now - cache.at < TTL_MS) return cache.value;
  if (running) return running;
  running = (async () => {
    const agents = db.prepare('SELECT * FROM agents').all();
    const lastCommit = db.prepare(
      "SELECT commit_sha FROM deployments WHERE agent_id = ? AND status = 'succeeded' AND commit_sha IS NOT NULL ORDER BY id DESC LIMIT 1"
    );
    const results = await mapLimit(agents, 3, async (agent) => {
      const plugin = runtimes[agent.runtime];
      if (!plugin) return null;
      let config = {};
      try { config = JSON.parse(agent.config || '{}'); } catch (_) {}

      if (typeof plugin.remoteRevision === 'function' && config.GIT_REPO) {
        const deployed = lastCommit.get(agent.id)?.commit_sha || null;
        if (!deployed) return null;
        const remote = await plugin.remoteRevision(agent.id, config).catch(() => null);
        const status = gitStatus(deployed, remote);
        return status ? [agent.id, { ...status, ref: config.GIT_REF || null }] : null;
      }

      const base = runtimeImage.baseImageFor(agent.runtime);
      if (!base || typeof plugin.prepareBuild === 'function') return null;
      const info = await docker.getContainer(containerNameFor(runtimes, agent)).inspect().catch(() => null);
      const imageId = info ? info.Image : null;
      if (!imageId) return null;
      const latest = await docker.getImage(`${agent.runtime}-agenthotel:latest`).inspect().catch(() => null);
      const upstream = await runtimeImage.upstreamStatus(docker, base).catch(() => null);
      return [agent.id, runtimeStatus({
        version: runtimeImage.versionCache.get(imageId) || null,
        behindPanel: Boolean(latest && latest.Id !== imageId),
        upstreamNewer: Boolean(upstream && upstream.newer)
      })];
    });
    const value = { checkedAt: new Date(now).toISOString(), agents: Object.fromEntries(results.filter(Boolean)) };
    cache = { at: now, value };
    return value;
  })();
  try {
    return await running;
  } finally {
    running = null;
  }
}

// After a deploy the answer for that agent is stale; drop the cache so the
// marker goes away on the next look instead of a quarter of an hour later.
function invalidate() { cache = null; }

module.exports = { gitStatus, runtimeStatus, collect, invalidate, mapLimit, TTL_MS };

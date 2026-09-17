// Which container speaks for an agent.
//
// For most runtimes it is the one the panel created: agenthotel-<id>. A
// compose guest has no such container — the stack brings up its own — so logs,
// stats, a shell and the status endpoint all asked for a name that never
// existed and answered "no such container". The runtime knows which of its
// services answers, so ask it.

function containerNameFor(runtimes, agent) {
  const fallback = `agenthotel-${agent.id}`;
  const plugin = runtimes?.[agent.runtime];
  if (!plugin?.composeManaged || typeof plugin.routeTarget !== 'function') return fallback;
  try {
    let cfg = agent.config;
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch (e) { cfg = {}; } }
    const target = plugin.routeTarget(agent.id, cfg || {});
    return target?.container || fallback;
  } catch (err) {
    // A stack that is down cannot name a container; the caller's own error
    // ("no such container", "not running") is still the honest answer.
    return fallback;
  }
}

module.exports = { containerNameFor };

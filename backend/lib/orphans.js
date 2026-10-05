// What deleted agents leave behind, and how to recognise it safely.
//
// A Git App builds an image of its own, tagged agenthotel-<agent id>:latest,
// and keeps a checkout under /data/builds/<agent id>. Deleting the agent
// removed its container, volumes and routes, but not those: a deleted
// reel-studio left a 2.5 GB image that nothing could ever use again, found by
// hand on a host at 96% disk (2026-10-03).
//
// An agent id is <runtime>-<name>-<13-digit timestamp>. Requiring that shape
// is what keeps this away from the panel's own images — agenthotel-backend
// and agenthotel-frontend share the prefix and must never match.

const AGENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*-\d{13}$/;

function isAgentId(id) {
  return AGENT_ID.test(String(id || ''));
}

// The agent id an image tag belongs to, or null if it is not a per-agent image.
function agentIdOfImageTag(tag) {
  const m = /^agenthotel-(.+):latest$/.exec(String(tag || ''));
  return m && isAgentId(m[1]) ? m[1] : null;
}

// Image tags built for agents that no longer exist.
function orphanImageTags(tags, agentIds) {
  const live = new Set(agentIds);
  return (tags || []).filter(tag => {
    const id = agentIdOfImageTag(tag);
    return id && !live.has(id);
  });
}

// Checkout directories for agents that no longer exist.
function orphanBuildDirs(dirNames, agentIds) {
  const live = new Set(agentIds);
  return (dirNames || []).filter(name => isAgentId(name) && !live.has(name));
}

// A domain change, carried into the values that were derived from the old
// domain. Templates write the public address into config at deploy —
// reel-studio's REEL_PUBLIC_BASE_URL=https://<domain> — and moving the agent
// to another hostname left it pointing at the old one: reel-studio then
// refused every MCP request with 421, since its allowed host is taken from
// that URL (2026-10-01). Only the old domain as a whole hostname is replaced,
// so reel.froste.eu does not rewrite reelstudio.froste.eu.
function withDomainChanged(config, oldDomain, newDomain) {
  if (!oldDomain || !newDomain || oldDomain === newDomain) return { config, changed: [] };
  const esc = oldDomain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const host = new RegExp(`(^|[/@=,\\s"'])${esc}(?=$|[/:?#,\\s"'])`, 'g');
  const out = { ...config };
  const changed = [];
  for (const [key, value] of Object.entries(config || {})) {
    if (typeof value !== 'string' || !value.includes(oldDomain)) continue;
    const next = value.replace(host, (m, pre) => pre + newDomain);
    if (next !== value) { out[key] = next; changed.push(key); }
  }
  return { config: out, changed };
}

module.exports = { isAgentId, agentIdOfImageTag, orphanImageTags, orphanBuildDirs, withDomainChanged };

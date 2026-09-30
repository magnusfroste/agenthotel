// Connecting an agent to a SkillHub on the same panel — the dining room.
//
// By hand this took five steps: find a free MCP_KEY_NN, write MCP_SERVERS as
// JSON, remember the Accept header, name the agent's row in SkillHub's own
// table, redeploy. The pure parts live here and are tested; server.js does the
// I/O. Nothing new is stored: which agent holds which key is read back from the
// agents' own MCP_SERVERS, so there is no second record to drift out of step.

const crypto = require('crypto');

// Marks rows the panel named, so disconnecting only clears what it wrote and
// never a name an operator chose — the Ankeborg names are theirs.
const ROLE_PREFIX = 'Connected from AgentHotel';

function parseEnv(text) {
  const env = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) env[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return env;
}

// A git-compose guest carrying SkillHub's keys. Judged by what it holds rather
// than what it is called, so a fork or a renamed deployment still counts.
function isSkillhub(agent) {
  if (agent.runtime !== 'git-compose') return false;
  let config = {};
  try { config = typeof agent.config === 'string' ? JSON.parse(agent.config || '{}') : (agent.config || {}); } catch (e) { return false; }
  const env = parseEnv(config.COMPOSE_ENV);
  return 'SERVICE_ROLE_KEY' in env && 'MCP_KEY_01' in env;
}

// The agent keys that exist, in order. A slot with an empty value is not a
// key — a SkillHub deployed before the template generated them has ten of those.
function slots(env) {
  return Object.keys(env)
    .map(k => /^MCP_KEY_(\d+)$/.exec(k))
    .filter(Boolean)
    .map(m => ({ slot: m[1], id: `agent_${m[1]}`, key: env[m[0]] }))
    .filter(s => s.key)
    .sort((a, b) => a.slot.localeCompare(b.slot));
}

function serversOf(agent) {
  let config = {};
  try { config = typeof agent.config === 'string' ? JSON.parse(agent.config || '{}') : (agent.config || {}); } catch (e) {}
  try {
    const s = JSON.parse(config.MCP_SERVERS || '{}');
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  } catch (e) { return {}; }
}

// key → the agent holding it, read from every agent's MCP_SERVERS.
function holders(agents, keySlots) {
  const byKey = new Map(keySlots.map(s => [s.key, s]));
  const out = new Map();
  for (const a of agents) {
    for (const spec of Object.values(serversOf(a))) {
      const key = spec && spec.headers && (spec.headers.apikey || spec.headers.Apikey);
      if (key && byKey.has(key)) out.set(key, a.id);
    }
  }
  return out;
}

function freeSlot(keySlots, held) {
  return keySlots.find(s => !held.has(s.key)) || null;
}

// The agent's current SkillHub connection, if any.
function connectionOf(agent, skillhubUrl, keySlots) {
  const servers = serversOf(agent);
  const base = String(skillhubUrl).replace(/\/+$/, '');
  const byKey = new Map(keySlots.map(s => [s.key, s]));
  let slot = null, caretaker = false;
  for (const spec of Object.values(servers)) {
    const url = String(spec && spec.url || '').replace(/\/+$/, '');
    if (url === base + '/skillhub') slot = byKey.get(spec.headers && spec.headers.apikey) || slot;
    if (url === base + '/mcp') caretaker = true;
  }
  return slot || caretaker ? { slot, caretaker } : null;
}

// MCP_SERVERS with the SkillHub doors set, every other server left as it was.
function withSkillhub(existingJson, skillhubUrl, key, serviceKey) {
  let servers = {};
  try { servers = JSON.parse(existingJson || '{}') || {}; } catch (e) { servers = {}; }
  const base = String(skillhubUrl).replace(/\/+$/, '');
  servers.skillhub = { url: `${base}/skillhub`, headers: { apikey: key } };
  if (serviceKey) servers.supabase_admin = { url: `${base}/mcp`, headers: { apikey: serviceKey } };
  else delete servers.supabase_admin;
  return JSON.stringify(servers);
}

// MCP_SERVERS without anything pointing at this SkillHub.
function withoutSkillhub(existingJson, skillhubUrl) {
  let servers = {};
  try { servers = JSON.parse(existingJson || '{}') || {}; } catch (e) { return existingJson; }
  const base = String(skillhubUrl).replace(/\/+$/, '');
  for (const [name, spec] of Object.entries(servers)) {
    if (String(spec && spec.url || '').startsWith(base + '/')) delete servers[name];
  }
  return Object.keys(servers).length ? JSON.stringify(servers) : '';
}

// Fill every empty MCP_KEY_NN, as the template does for a new deployment.
function withGeneratedKeys(envText) {
  let filled = 0;
  const text = String(envText || '').replace(/^(MCP_KEY_\d+)=\s*$/gm, (_, k) => {
    filled++;
    return `${k}=${crypto.randomBytes(24).toString('hex')}`;
  });
  return { text, filled };
}

// Whether the panel may write its own name into a row: only one nobody chose.
function mayName(row) {
  if (!row) return false;
  const role = String(row.role || '');
  return !row.name || !role || role.startsWith('Vacant') || role.startsWith(ROLE_PREFIX);
}

module.exports = {
  parseEnv, isSkillhub, slots, holders, freeSlot, connectionOf,
  withSkillhub, withoutSkillhub, withGeneratedKeys, mayName, ROLE_PREFIX
};

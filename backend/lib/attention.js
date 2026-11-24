// Which guests need the operator, and why, in words (2026-11-24).
//
// The sidebar used to list every guest. With 18 of them, and 32 the week the
// skolappar were here, the one that was broken was a red dot somewhere in a
// long list. Now the sidebar shows only the guests that need something, worst
// first, each with one line saying what is wrong, and the Agents & apps page
// lists everyone.
//
// What does not count:
// - A guest stopped on purpose. Fourteen skolappar were stopped on 2026-11-21
//   when they moved to Shipholm; listing them would have filled the sidebar
//   with guests nobody had to do anything about. A guest whose container
//   stopped by itself does count: its last lifecycle event is a start, not a
//   stop.
// - An update waiting. It is real, but it is not a fault, and when a new
//   Hermes comes out every Hermes guest has one at once. The panel shows
//   those as one grouped row (frontend/src/lib/attention.js).

// Worst first. 'busy' is a deploy or build in progress: shown so the operator
// sees it moving, never as a fault.
const LEVELS = { critical: 3, warning: 2, busy: 1 };

// Events that mean "someone stopped it" and events that mean "it was meant to
// run". Whichever came last decides whether a stopped guest is a fault.
const STOP_EVENTS = ['agent.stop', 'agent.transfer', 'agent.restore'];
const RUN_EVENTS = ['agent.start', 'agent.redeploy', 'agent.create', 'agent.import'];
// When a problem started, for the order within one level: the newest first,
// since an old one is one the operator has already seen.
const PROBLEM_EVENTS = ['agent.unhealthy', 'agent.down', 'agent.error', 'agent.model_error', 'agent.warning'];

function healthParts(health) {
  const [state, ...rest] = String(health || '').split(':');
  return { state: state.trim(), reason: rest.join(':').trim() };
}

// SQLite CURRENT_TIMESTAMP ("2026-11-24 09:12:03", UTC) to ms, or null.
function eventTime(ts) {
  if (!ts) return null;
  const ms = Date.parse(String(ts).replace(' ', 'T') + (String(ts).endsWith('Z') ? '' : 'Z'));
  return Number.isNaN(ms) ? null : ms;
}

// One guest's state, as the list endpoint has it, to null (nothing to do) or
// { level, text, since }. `ctx`:
//   lastLifecycle  the type of its last stop/run event, or null
//   lastProblemAt  ms of its last problem event, or null
//   uptimeDown     true when its domain has failed three probes in a row
//   modelErrors    the 24-hour summary from lib/modelErrors.js
function assess(agent, ctx = {}) {
  const { state, reason } = healthParts(agent.health);
  const since = ctx.lastProblemAt || null;

  if (['creating', 'updating', 'redeploying'].includes(agent.status) || state === 'building' || state === 'queued') {
    const what = state === 'building' || state === 'queued' ? `${state[0].toUpperCase()}${state.slice(1)}${reason ? `, ${reason}` : ''}` : 'Deploying';
    return { level: 'busy', text: what, since: null };
  }

  if (agent.status === 'stopped') {
    // No lifecycle event at all: a guest from before the event log, or one
    // whose events were trimmed. Quiet is the safer guess: Docker restarts a
    // crashed container (unless-stopped), so one that stays stopped was
    // almost always stopped by someone.
    if (!ctx.lastLifecycle || STOP_EVENTS.includes(ctx.lastLifecycle)) return null;
    return { level: 'critical', text: `Stopped by itself (${reason || 'container stopped'})`, since };
  }

  if (state === 'interrupted') {
    return { level: 'critical', text: 'Deploy was cut short — redeploy it', since };
  }
  if (agent.status === 'failed' || state === 'missing') {
    return { level: 'critical', text: reason.startsWith('build failed') ? `Build failed: ${reason.slice('build failed'.length).replace(/^:\s*/, '')}` : `No container (${reason || 'missing'})`, since };
  }
  if (state === 'restarting') {
    return { level: 'critical', text: `Keeps restarting (${reason})`, since };
  }
  if (agent.status === 'unhealthy' || state === 'unhealthy') {
    return { level: 'critical', text: `Not healthy (${reason || 'probe failed'})`, since };
  }

  if (ctx.uptimeDown) {
    return { level: 'warning', text: 'Not answering at its domain', since };
  }
  const me = ctx.modelErrors;
  if (me && me.count > 0) {
    const advice = me.last?.advice ? `: ${me.last.advice}` : '';
    return {
      level: 'warning',
      text: `${me.count === 1 ? '1 reply' : `${me.count} replies`} failed at the model${advice}`,
      since: me.last?.at || since
    };
  }
  return null;
}

// Worst first; within a level the newest problem first; then by name, so two
// polls of an unchanged fleet give the same order and rows never jump.
function compare(a, b) {
  const la = LEVELS[a.attention?.level] || 0;
  const lb = LEVELS[b.attention?.level] || 0;
  if (la !== lb) return lb - la;
  const sa = a.attention?.since || 0;
  const sb = b.attention?.since || 0;
  if (sa !== sb) return sb - sa;
  return String(a.name).localeCompare(String(b.name));
}

// The last lifecycle event and the last problem event per guest, from rows of
// { agent_id, type, ts } (newest first or not; the latest wins).
function lastEvents(rows) {
  const lifecycle = {};
  const problem = {};
  for (const r of rows) {
    const at = eventTime(r.ts);
    if (STOP_EVENTS.includes(r.type) || RUN_EVENTS.includes(r.type)) {
      if (!lifecycle[r.agent_id] || at >= lifecycle[r.agent_id].at) lifecycle[r.agent_id] = { type: r.type, at };
    }
    if (PROBLEM_EVENTS.includes(r.type)) {
      if (!problem[r.agent_id] || at > problem[r.agent_id]) problem[r.agent_id] = at;
    }
  }
  return {
    lifecycle: Object.fromEntries(Object.entries(lifecycle).map(([k, v]) => [k, v.type])),
    problem
  };
}

module.exports = { assess, compare, lastEvents, eventTime, LEVELS, STOP_EVENTS, RUN_EVENTS, PROBLEM_EVENTS };

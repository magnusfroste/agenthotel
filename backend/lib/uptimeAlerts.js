// When an uptime check becomes an alert (2026-10-28). The panel probes every
// guest's domain once a minute, and used to call a guest down on the first
// failed probe. A redeploy's few seconds of 502, a container still booting,
// one dropped request: each sent "down" and, a minute later, "back up" to the
// operator's phone. And when the host itself had trouble (a full disk on
// 2026-10-20), every guest went down in the same minute and each sent its
// own message, when there was one problem.
//
// Now a guest is down after DOWN_AFTER failed probes in a row (about three
// minutes), back up on the first good one, and guests that change state in
// the same sweep are reported together once there are GROUP_AT of them.

const DOWN_AFTER = 3;
const GROUP_AT = 3;

// One probe's result folded into a guest's state: { up, fails } where `up` is
// the last state reported (undefined until there is one). Returns the new
// state and the event to report: 'down', 'never-up' (down with nothing good
// seen since the panel started), 'up', or null.
function observe(prev, isUp, { downAfter = DOWN_AFTER } = {}) {
  const state = prev ? { ...prev } : { up: undefined, fails: 0 };
  if (isUp) {
    const event = state.up === false ? 'up' : null;
    return { state: { up: true, fails: 0 }, event };
  }
  state.fails += 1;
  if (state.fails >= downAfter && state.up !== false) {
    const event = state.up === undefined ? 'never-up' : 'down';
    return { state: { up: false, fails: state.fails }, event };
  }
  return { state, event: null };
}

// The line for one guest's event, as it goes into the event log.
function eventMessage({ name, event, statusCode }) {
  const why = statusCode ?? 'unreachable';
  if (event === 'up') return `Agent ${name} is back up`;
  if (event === 'never-up') return `Agent ${name} is down (${why}) and has not answered since the panel started`;
  return `Agent ${name} is down (${why})`;
}

// What to send for one sweep's events: one message per guest, or one for
// all of them when GROUP_AT or more changed state the same way at once.
function notifications(events, { groupAt = GROUP_AT } = {}) {
  const out = [];
  const downs = events.filter(e => e.event === 'down' || e.event === 'never-up');
  const ups = events.filter(e => e.event === 'up');
  if (downs.length >= groupAt) {
    out.push(`${downs.length} guests went down at once, which points at the host or its network rather than the guests: ${downs.map(e => e.name).join(', ')}`);
  } else {
    for (const e of downs) out.push(eventMessage(e));
  }
  if (ups.length >= groupAt) {
    out.push(`${ups.length} guests are back up: ${ups.map(e => e.name).join(', ')}`);
  } else {
    for (const e of ups) out.push(eventMessage(e));
  }
  return out;
}

module.exports = { observe, eventMessage, notifications, DOWN_AFTER, GROUP_AT };

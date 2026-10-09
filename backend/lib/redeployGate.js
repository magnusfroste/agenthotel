// One redeploy where two identical ones were asked for.
//
// On 2026-10-09 reel-studio was redeployed from the Redeploy button and over
// the API a minute apart, for the same commit (34f593e). Both built: twenty
// minutes of a saturated host, and a 2.5 GB image that existed only to be
// replaced. A redeploy asked for while an identical one (same agent, same
// request) is still to come produces nothing the first will not, so it joins
// that one instead of queueing a second:
//   - one that is queued and has not started: it reads the repository when
//     its turn comes, so it builds whatever is newest then — always joined;
//   - one that is running: joined when the commit it read is the one the
//     source names now, or when the agent has no source to read (a template,
//     an image, compose text), since it then deploys the same thing either
//     way. If the source moved on, cannot be asked, or the running one has
//     not said which commit it read, a new redeploy is queued — a join must
//     never deploy older code than was asked for.
//
// "Identical" is the key the caller computes: the agent's config, image and
// whether a rebuild was asked for. A redeploy with an edited config is a
// different redeploy and is never folded into an earlier one.

// Two abbreviations of one commit: "34f593e" and "34f593e1c0…".
function sameRevision(a, b) {
  if (!a || !b) return false;
  const x = String(a).trim().toLowerCase();
  const y = String(b).trim().toLowerCase();
  if (x.length < 7 || y.length < 7) return x === y;
  return x.startsWith(y) || y.startsWith(x);
}

function createRedeployGate({ log = console } = {}) {
  // agent id -> entries in flight: { key, started, revision, promise }
  const inFlight = new Map();

  function forget(agentId, entry) {
    const list = inFlight.get(agentId);
    if (!list) return;
    const i = list.indexOf(entry);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) inFlight.delete(agentId);
  }

  return {
    // run(entry) starts the redeploy and returns its promise. It must set
    // entry.started = true when the redeploy's turn comes, and
    // entry.revision once it knows the commit it builds.
    // remoteRevision(), optional, resolves to the commit the source names now.
    // sourceless: the agent reads no repository, so a running redeploy
    // deploys exactly what a new one would.
    //
    // → { promise, joined: null | 'queued' | 'running', revision }
    async redeploy(agentId, key, run, { remoteRevision = null, sourceless = false } = {}) {
      const same = () => (inFlight.get(agentId) || []).filter(e => e.key === key);

      const waiting = same().find(e => !e.started);
      if (waiting) return { promise: waiting.promise, joined: 'queued', revision: null };

      const running = same().find(e => e.started);
      if (running) {
        if (sourceless) return { promise: running.promise, joined: 'running', revision: null };
        let now = null;
        if (running.revision && remoteRevision) {
          try { now = await remoteRevision(); } catch (err) {
            log.warn(`[Redeploy] Could not read the source's current commit, redeploying anyway: ${err.message}`);
          }
        }
        if (sameRevision(now, running.revision)) {
          return { promise: running.promise, joined: 'running', revision: running.revision };
        }
        // Another identical request may have queued one while we asked.
        const queued = same().find(e => !e.started);
        if (queued) return { promise: queued.promise, joined: 'queued', revision: null };
      }

      const entry = { key, started: false, revision: null, promise: null };
      const list = inFlight.get(agentId) || [];
      list.push(entry);
      inFlight.set(agentId, list);
      try {
        entry.promise = Promise.resolve(run(entry));
      } catch (err) {
        entry.promise = Promise.reject(err);
      }
      const leave = () => forget(agentId, entry);
      entry.promise.then(leave, leave);
      return { promise: entry.promise, joined: null, revision: null };
    },

    entries(agentId) {
      return (inFlight.get(agentId) || []).map(e => ({ key: e.key, started: e.started, revision: e.revision }));
    }
  };
}

module.exports = { createRedeployGate, sameRevision };

// Deploys the panel is in the middle of, and what a restart does to them.
//
// An upgrade recreates the backend container, and every deploy runs inside
// it: the image build is a stream the backend holds open, the deploy queue is
// a promise chain in its memory. On 2026-10-09 an upgrade at 17:21 landed on
// step 7/18 of an OpenClaw template build. The build died with the backend, no
// image was produced, and the row was left 'creating' — which the health sweep
// exempts for 15 minutes and then judged "missing: container not found". The
// guest had to be redeployed by hand, and nothing said why it had failed.
//
// Two halves: the upgrade refuses while a deploy is running (unless forced),
// and a backend that starts finds the rows a restart cut short and says so.

// The statuses a deploy holds while it owns the row. Every deploy path — REST,
// MCP, compose, the queue — writes one of these before it starts and replaces
// it when it ends, so the table itself is the process-wide list of work in
// flight. A deploy that died without writing back is corrected by the health
// sweep after 15 minutes, and by recoverInterrupted() at the next start.
const IN_FLIGHT = ['creating', 'redeploying'];

const INTERRUPTED_REASON = 'interrupted by a panel restart — redeploy to finish';
const INTERRUPTED_HEALTH = `interrupted: ${INTERRUPTED_REASON}`;

function isInFlight(status) {
  return IN_FLIGHT.includes(status);
}

// Rows mid-deploy, with build progress where an image is being built.
// buildProgress is server.js's in-memory map (agent id → progress); a build
// whose entry has no agent row in flight still counts — it is still a build
// an upgrade would kill.
function deploysInFlight(rows, buildProgress = new Map()) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    if (!isInFlight(row.status)) continue;
    seen.add(row.id);
    out.push(describe(row.id, row.name, row.status, buildProgress.get(row.id)));
  }
  for (const [id, p] of buildProgress) {
    if (seen.has(id) || !p || p.done) continue;
    out.push(describe(id, id, 'building', p));
  }
  return out;
}

function describe(id, name, status, p) {
  const building = !!(p && !p.done);
  return {
    id,
    name: name || id,
    status,
    building,
    step: building ? p.step || 0 : null,
    total: building ? p.total || 0 : null
  };
}

// "openclaw-bot (building, step 7/18)"
function label(d) {
  const what = d.building
    ? (d.total ? `building, step ${d.step}/${d.total}` : 'building')
    : d.status === 'redeploying' ? 'redeploying' : 'deploying';
  return `${d.name} (${what})`;
}

// The 409 body the upgrade answers with while work is in flight.
function upgradeConflict(deploys) {
  const names = deploys.map(label).join(', ');
  return {
    error: `${deploys.length === 1 ? 'A deploy is' : `${deploys.length} deploys are`} running: ${names}. `
      + 'Upgrading restarts the backend and kills them part-way — wait for them to finish, '
      + 'or upgrade anyway with force: true.',
    deploys
  };
}

// What to do with each row a restart left mid-deploy. inspect(row) resolves
// to the container's State, or rejects when there is none.
//
// Not resumed: the request that started a create is gone, and resuming means
// rebuilding — twenty minutes and a fresh base-image pull nobody asked for at
// boot, right after an upgrade that is already busy. Marking it is what lets
// the operator decide, and the message says how.
//
// A redeploy builds before it swaps, so a restart during the build usually
// left the old container serving. That guest is 'running', not failed — only
// the redeploy did not happen.
async function recoverInterrupted(rows, inspect) {
  const decisions = [];
  for (const row of rows || []) {
    if (!isInFlight(row.status)) continue;
    let state = null;
    try { state = await inspect(row); } catch (e) { state = null; }
    if (state && state.Running) {
      decisions.push({
        id: row.id, name: row.name, from: row.status, status: 'running', health: null,
        message: `${row.status === 'creating' ? 'Deploy' : 'Redeploy'} of ${row.name} was ${INTERRUPTED_REASON}; the previous container is still running`
      });
    } else {
      decisions.push({
        id: row.id, name: row.name, from: row.status, status: 'failed', health: INTERRUPTED_HEALTH,
        message: `${row.status === 'creating' ? 'Deploy' : 'Redeploy'} of ${row.name} was ${INTERRUPTED_REASON}`
      });
    }
  }
  return decisions;
}

// The health text a sweep writes. A guest marked interrupted still has no
// container, and the sweep would overwrite the reason with "missing: container
// not found" a minute later — the generic text this exists to replace. Keep it
// until something real (a container) shows up.
function sweptHealth(previous, result) {
  if (result.state === 'missing' && String(previous || '').startsWith('interrupted:')) return previous;
  return `${result.state}: ${result.reason}`;
}

module.exports = {
  IN_FLIGHT, INTERRUPTED_REASON, INTERRUPTED_HEALTH,
  isInFlight, deploysInFlight, upgradeConflict, recoverInterrupted, sweptHealth
};

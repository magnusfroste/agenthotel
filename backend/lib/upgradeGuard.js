// What an upgrade would cut off. An upgrade recreates the backend container,
// and deploys, backups and agent moves all run inside that process.
//
// Moves were not on the list: an upgrade on this hotel killed an import of
// priscilla half way through its pull (2026-10-29), and an upgrade on the
// other hotel killed the pull of davida an hour later. A pull spends its
// one-time ticket and stops the agent at its old hotel, so both had to be
// started over with a new ticket.

const { upgradeConflict } = require('./deploysInFlight');

function mb(bytes) {
  return `${Math.round((bytes || 0) / 1e6)} MB`;
}

function describeMove(m) {
  if (m.kind === 'pull') {
    return `a pull from ${m.from}${m.bytes ? ` (${mb(m.bytes)}${m.total ? ` of ${mb(m.total)}` : ''})` : ''}`;
  }
  if (m.kind === 'upload') return 'an uploaded import';
  return `an export of ${m.name}${m.to ? ` to ${m.to}` : ''}`;
}

// The reason not to upgrade now, as { status, body, forceable }, or null. A
// second upgrade racing the first would fight over the same checkout, so that
// one cannot be forced; for the rest, force is the operator's call.
function upgradeBlocker({ upgradeRunning = false, deploys = [], backup = null, moves = [] }) {
  if (upgradeRunning) return { status: 409, forceable: false, body: { error: 'An upgrade is already running.' } };
  if (deploys.length) return { status: 409, forceable: true, body: upgradeConflict(deploys) };
  if (backup) {
    return {
      status: 409,
      forceable: true,
      body: { error: `A backup is running (${backup}); it pauses each guest for the seconds it takes to copy it. Upgrade when it is done, in a few minutes.` }
    };
  }
  if (moves.length) {
    return {
      status: 409,
      forceable: true,
      body: {
        error: `An agent is being moved: ${moves.map(describeMove).join(', ')}. Upgrading restarts the backend and the move dies with it; `
          + 'a pull has then spent its one-time ticket and left the agent stopped at its old hotel. '
          + 'Wait for it to finish, or upgrade anyway with force: true.',
        moves
      }
    };
  }
  return null;
}

module.exports = { upgradeBlocker, describeMove };

// Which earlier deploy a guest can be rolled back to (2026-10-28). A Git App
// deploy records the full sha it was built from; rolling back builds that
// commit again, once, and leaves GIT_REF alone, so the next redeploy follows
// the branch and the Fleet's update marker shows the guest is behind until
// then. Deploys recorded before the full sha was kept (only seven characters)
// cannot be fetched by commit and are refused with a reason.

const FULL_SHA = /^[0-9a-f]{40}$/i;

function refuse(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// The full sha to deploy, or throws an error carrying an HTTP status.
function rollbackTarget(deploy, agent, plugin) {
  if (!deploy || deploy.agent_id !== agent.id) throw refuse(404, 'No such deploy of this agent');
  if (!plugin || typeof plugin.prepareBuild !== 'function' || typeof plugin.remoteRevision !== 'function') {
    throw refuse(400, 'Only a guest built from a Git repository can be rolled back to a commit');
  }
  if (deploy.status !== 'succeeded') throw refuse(409, 'Only a deploy that succeeded can be rolled back to');
  const sha = String(deploy.commit_sha || '');
  if (!FULL_SHA.test(sha)) {
    throw refuse(409, 'This deploy recorded only a short commit, so it cannot be fetched again. Deploys from now on can be rolled back to.');
  }
  return sha.toLowerCase();
}

// Whether the Deployments tab offers it, without asking the server.
function canRollBack(deploy) {
  return Boolean(deploy && deploy.status === 'succeeded' && FULL_SHA.test(String(deploy.commit_sha || '')));
}

module.exports = { rollbackTarget, canRollBack, FULL_SHA };

// Rolling a Git App back to a commit it ran before (lib/rollback.js).
const { test } = require('node:test');
const assert = require('node:assert');
const { rollbackTarget, canRollBack } = require('../lib/rollback');

const gitApp = { prepareBuild() {}, remoteRevision() {} };
const agent = { id: 'git-app-reports-1' };
const sha = 'f3abbf1c0ffee0000000000000000000000000aa';

test('a succeeded deploy with a full sha can be rolled back to', () => {
  assert.strictEqual(rollbackTarget({ agent_id: agent.id, status: 'succeeded', commit_sha: sha.toUpperCase() }, agent, gitApp), sha);
  assert.strictEqual(canRollBack({ status: 'succeeded', commit_sha: sha }), true);
});

test('what cannot be rolled back says why, with a status', () => {
  const cases = [
    [null, 404],
    [{ agent_id: 'someone-else', status: 'succeeded', commit_sha: sha }, 404],
    [{ agent_id: agent.id, status: 'failed', commit_sha: sha }, 409],
    [{ agent_id: agent.id, status: 'succeeded', commit_sha: 'f3abbf1' }, 409],
  ];
  for (const [deploy, status] of cases) {
    assert.throws(() => rollbackTarget(deploy, agent, gitApp), e => e.status === status);
  }
  assert.throws(() => rollbackTarget({ agent_id: agent.id, status: 'succeeded', commit_sha: sha }, agent, { name: 'Hermes' }), e => e.status === 400, 'a runtime guest has no commit to go back to');
  assert.strictEqual(canRollBack({ status: 'succeeded', commit_sha: 'f3abbf1' }), false, 'older deploys kept seven characters');
});

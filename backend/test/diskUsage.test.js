// Where the disk goes, per agent (lib/diskUsage.js).
const { test } = require('node:test');
const assert = require('node:assert');
const { diskByAgent } = require('../lib/diskUsage');

const GB = 1024 ** 3;
const df = {
  LayersSize: 20 * GB,
  Images: [
    { Id: 'sha256:hermes00000001', RepoTags: ['hermes-agenthotel:latest'], Size: 5 * GB, SharedSize: 4 * GB },
    { Id: 'sha256:take0000000001', RepoTags: ['agenthotel-git-app-take:latest'], Size: 2.5 * GB, SharedSize: 2.5 * GB },
    { Id: 'sha256:cache000000001', RepoTags: ['<none>:<none>'], Size: 2.4 * GB, SharedSize: 2.4 * GB },
    { Id: 'sha256:panel000000001', RepoTags: ['agenthotel-backend:latest'], Size: 0.3 * GB, SharedSize: 0 }
  ],
  Containers: [
    { Id: 'c1', Names: ['/agenthotel-hermes-davida'], Labels: { 'agenthotel.id': 'hermes-davida' }, ImageID: 'sha256:hermes00000001', SizeRw: 0.2 * GB },
    { Id: 'c2', Names: ['/agenthotel-hermes-peter'], Labels: { 'agenthotel.id': 'hermes-peter' }, ImageID: 'sha256:hermes00000001', SizeRw: 0.1 * GB },
    { Id: 'c3', Names: ['/agenthotel-git-app-take'], Labels: {}, ImageID: 'sha256:take0000000001', SizeRw: 0 },
    { Id: 'c4', Names: ['/skillhub-db-1'], Labels: { 'com.docker.compose.project': 'agenthotel-compose-skillhub' }, ImageID: 'sha256:x', SizeRw: 0.05 * GB },
    { Id: 'c5', Names: ['/agenthotel-backend'], Labels: { 'com.docker.compose.project': 'agenthotel' }, ImageID: 'sha256:panel000000001', SizeRw: 0.01 * GB }
  ],
  Volumes: [
    { Name: 'agenthotel-hermes-davida-opt-data', UsageData: { Size: 6 * GB } },
    { Name: 'agenthotel-hermes-peter-opt-data', UsageData: { Size: 1 * GB } },
    { Name: 'agenthotel-hermes-gone-opt-data', UsageData: { Size: 3 * GB } },
    { Name: 'skillhub_db', Labels: { 'com.docker.compose.project': 'agenthotel-compose-skillhub' }, UsageData: { Size: 2 * GB } },
    { Name: 'agenthotel_agenthotel-data', Labels: { 'com.docker.compose.project': 'agenthotel' }, UsageData: { Size: 0.5 * GB } },
    { Name: 'unmeasured', UsageData: { Size: -1 } }
  ],
  BuildCache: [{ Size: 1 * GB }]
};
const agents = [
  { id: 'hermes-davida', name: 'davida', runtime: 'hermes' },
  { id: 'hermes-peter', name: 'peter', runtime: 'hermes' },
  { id: 'git-app-take', name: 'take', runtime: 'git-app' },
  { id: 'compose-skillhub', name: 'skillhub', runtime: 'git-compose' }
];

test('each agent owns its volumes and container layer, largest first', () => {
  const r = diskByAgent(df, agents, { 'compose-skillhub': 'agenthotel-compose-skillhub' });
  assert.deepStrictEqual(r.agents.map(a => a.name), ['davida', 'skillhub', 'peter', 'take']);
  const davida = r.agents[0];
  assert.strictEqual(davida.data, 6 * GB);
  assert.strictEqual(davida.container, 0.2 * GB);
  assert.strictEqual(davida.total, 6.2 * GB);
  assert.strictEqual(r.agents[1].total, 2.05 * GB, 'a compose stack is found by its project label');
});

test('an image is shown beside an agent, never summed, and marked when shared', () => {
  const r = diskByAgent(df, agents, {});
  const davida = r.agents.find(a => a.name === 'davida');
  assert.deepStrictEqual(davida.image, { tag: 'hermes-agenthotel:latest', size: 5 * GB, sharedWith: 1 });
  const take = r.agents.find(a => a.name === 'take');
  assert.strictEqual(take.image.size, 2.5 * GB, 'its own image at full size, though its cache shares every layer');
  assert.strictEqual(take.total, 0);
});

test('the panel, what nobody owns, and Docker counted once per layer', () => {
  const r = diskByAgent(df, agents, { 'compose-skillhub': 'agenthotel-compose-skillhub' });
  assert.strictEqual(r.panel.data, 0.5 * GB);
  assert.strictEqual(r.panel.containers, 0.01 * GB);
  assert.strictEqual(r.other.volumes, 3 * GB, "a deleted agent's volume is nobody's");
  assert.strictEqual(r.other.volumeCount, 2, 'an unmeasured volume counts as zero, not -1');
  assert.deepStrictEqual(r.unusedImages, { count: 1, tagged: 0 });
  assert.strictEqual(r.layersSize, 20 * GB);
  assert.strictEqual(r.buildCache, 1 * GB);
});

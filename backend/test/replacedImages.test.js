// The image a rebuild replaced, removed once nothing needs it.
const { test } = require('node:test');
const assert = require('node:assert');
const { createReplacedImages, waitUntilSettled } = require('../lib/replacedImages');

const quiet = { log() {}, warn() {} };

function fakeDocker({ containers = [], failRemove = {} } = {}) {
  const removed = [];
  return {
    removed,
    containers,
    async listContainers(opts) {
      assert.deepStrictEqual(opts, { all: true }, 'stopped containers count too');
      return this.containers;
    },
    getImage(id) {
      return {
        async remove(opts) {
          assert.ok(!opts || !opts.force, 'never forced');
          if (failRemove[id]) { const e = new Error(failRemove[id].message); e.statusCode = failRemove[id].statusCode; throw e; }
          removed.push(id);
        }
      };
    }
  };
}

const REEL = 'git-app-reel-studio-1790886075660';

test('nothing is removed before the agent that replaced it is released', async () => {
  const docker = fakeDocker();
  const images = createReplacedImages(docker, { log: quiet });
  images.retire('sha256:old', { tag: `agenthotel-${REEL}:latest`, agentId: REEL });
  assert.ok(images.holds(REEL));
  assert.deepStrictEqual(await images.sweep(), []);
  assert.deepStrictEqual(docker.removed, []);

  images.release(REEL);
  assert.deepStrictEqual(await images.sweep(), ['sha256:old']);
  assert.deepStrictEqual(docker.removed, ['sha256:old']);
  assert.ok(!images.holds(REEL), 'a removed image is forgotten');
});

test('six redeploys leave one image, not six', async () => {
  const docker = fakeDocker();
  const images = createReplacedImages(docker, { log: quiet });
  for (let i = 1; i <= 6; i++) {
    docker.containers = [{ ImageID: `sha256:build${i}` }];
    images.retire(`sha256:build${i - 1}`, { tag: `agenthotel-${REEL}:latest`, agentId: REEL });
    images.release(REEL);
    await images.sweep();
  }
  assert.deepStrictEqual(docker.removed, ['sha256:build0', 'sha256:build1', 'sha256:build2', 'sha256:build3', 'sha256:build4', 'sha256:build5']);
});

test('a template image other agents still run is kept until the last moves off it', async () => {
  // hermes A was redeployed with a rebuild; hermes B and a stopped hermes C
  // still run the old template image.
  const docker = fakeDocker({ containers: [
    { ImageID: 'sha256:new' },
    { ImageID: 'sha256:old', State: 'running' },
    { ImageID: 'sha256:old', State: 'exited' }
  ] });
  const images = createReplacedImages(docker, { log: quiet });
  images.retire('sha256:old', { tag: 'hermes-agenthotel:latest', agentId: 'hermes-a-1790000000001' });
  images.release('hermes-a-1790000000001');
  assert.deepStrictEqual(await images.sweep(), []);

  docker.containers = [{ ImageID: 'sha256:new' }, { ImageID: 'sha256:new' }, { ImageID: 'sha256:old', State: 'exited' }];
  assert.deepStrictEqual(await images.sweep(), [], 'a stopped container still holds it');

  docker.containers = [{ ImageID: 'sha256:new' }, { ImageID: 'sha256:new' }, { ImageID: 'sha256:new' }];
  assert.deepStrictEqual(await images.sweep(), ['sha256:old']);
});

test('only the releasing agent\'s images become removable', async () => {
  const docker = fakeDocker();
  const images = createReplacedImages(docker, { log: quiet });
  images.retire('sha256:reel', { tag: `agenthotel-${REEL}:latest`, agentId: REEL });
  images.retire('sha256:lobby', { tag: 'agenthotel-git-app-lobby-1788204261179:latest', agentId: 'git-app-lobby-1788204261179' });
  images.release(REEL);
  assert.deepStrictEqual(await images.sweep(), ['sha256:reel']);
  assert.deepStrictEqual(images.entries().map(e => e.imageId), ['sha256:lobby']);
});

test('a failed removal never throws, and is retried by the next sweep', async () => {
  const docker = fakeDocker({ failRemove: { 'sha256:old': { statusCode: 409, message: 'conflict: image is referenced in multiple repositories' } } });
  const warnings = [];
  const images = createReplacedImages(docker, { log: { log() {}, warn: m => warnings.push(m) } });
  images.retire('sha256:old', { tag: `agenthotel-${REEL}:latest`, agentId: REEL });
  images.release(REEL);
  assert.deepStrictEqual(await images.sweep(), []);
  assert.deepStrictEqual(await images.sweep(), []);
  assert.strictEqual(warnings.length, 1, 'logged once, not on every sweep');
  assert.strictEqual(images.entries().length, 1);

  // Nor does a Docker API that cannot list containers.
  docker.listContainers = async () => { throw new Error('socket hang up'); };
  assert.deepStrictEqual(await images.sweep(), []);
});

test('an image already gone is forgotten', async () => {
  const docker = fakeDocker({ failRemove: { 'sha256:old': { statusCode: 404, message: 'No such image' } } });
  const images = createReplacedImages(docker, { log: quiet });
  images.retire('sha256:old', { tag: `agenthotel-${REEL}:latest`, agentId: REEL });
  images.release(REEL);
  await images.sweep();
  assert.deepStrictEqual(images.entries(), []);
});

test('healthy means healthy several times in a row', async () => {
  let t = 0;
  const clock = { sleep: async ms => { t += ms; }, now: () => t };
  const answers = [true, true, false, true, true, true];
  let i = 0;
  assert.strictEqual(await waitUntilSettled(async () => answers[i++], { intervalMs: 5, settleChecks: 3, timeoutMs: 1000, ...clock }), true);
  assert.strictEqual(i, 6, 'the streak restarts after a bad answer');
});

test('a container that never settles is given up on, and a throwing check is a bad answer', async () => {
  let t = 0;
  const clock = { sleep: async ms => { t += ms; }, now: () => t };
  assert.strictEqual(await waitUntilSettled(async () => { throw new Error('exec failed'); }, { intervalMs: 5, settleChecks: 2, timeoutMs: 50, ...clock }), false);
  assert.ok(t >= 50);
});

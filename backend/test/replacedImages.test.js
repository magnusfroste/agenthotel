// The image a rebuild replaced, removed once nothing needs it.
const { test } = require('node:test');
const assert = require('node:assert');
const { createReplacedImages, waitUntilSettled } = require('../lib/replacedImages');

const quiet = { log() {}, warn() {} };

function fakeDocker({ containers = [], failRemove = {}, tags = {} } = {}) {
  const removed = [];
  return {
    removed,
    containers,
    // tag -> image id it points at
    tags,
    async listContainers(opts) {
      assert.deepStrictEqual(opts, { all: true }, 'stopped containers count too');
      return this.containers;
    },
    getImage(id) {
      const tags = this.tags;
      return {
        async inspect() {
          if (!tags[id]) { const e = new Error('No such image'); e.statusCode = 404; throw e; }
          return { Id: tags[id] };
        },
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

// 2026-10-09: reel-studio redeployed from the button and over MCP a minute
// apart, the MCP one outside the deploy queue. Both builds read the tag while
// it still pointed at the original image A; the first produced B, the second
// C. Only A was ever retired, so B stayed behind — and the sweep after the
// first deploy settled could release whatever the second had retired.
const TAG = `agenthotel-${REEL}:latest`;

test('overlapping builds of one tag retire every image they replaced', async () => {
  const docker = fakeDocker({ tags: { [TAG]: 'sha256:A' } });
  const images = createReplacedImages(docker, { log: quiet });

  // Both read "before" = A, then the first finishes with B, the second with C.
  images.rebuilt({ tag: TAG, agentId: REEL, previousImageId: 'sha256:A', builtImageId: 'sha256:B' });
  docker.tags[TAG] = 'sha256:B';
  images.rebuilt({ tag: TAG, agentId: REEL, previousImageId: 'sha256:A', builtImageId: 'sha256:C' });
  docker.tags[TAG] = 'sha256:C';

  assert.deepStrictEqual(images.entries().map(e => e.imageId).sort(), ['sha256:A', 'sha256:B']);
  docker.containers = [{ ImageID: 'sha256:C' }];
  images.release(REEL);
  assert.deepStrictEqual((await images.sweep()).sort(), ['sha256:A', 'sha256:B']);
  assert.deepStrictEqual(images.entries(), []);
});

test('whichever overlapping build finishes last, the image the tag lost is retired', async () => {
  const docker = fakeDocker();
  const images = createReplacedImages(docker, { log: quiet });
  // The second build finishes first (C), then the first retags to B.
  images.rebuilt({ tag: TAG, agentId: REEL, previousImageId: 'sha256:A', builtImageId: 'sha256:C' });
  images.rebuilt({ tag: TAG, agentId: REEL, previousImageId: 'sha256:A', builtImageId: 'sha256:B' });
  docker.tags[TAG] = 'sha256:B';
  docker.containers = [{ ImageID: 'sha256:B' }];
  images.release(REEL);
  assert.deepStrictEqual((await images.sweep()).sort(), ['sha256:A', 'sha256:C']);
});

test('back-to-back redeploys: the first deploy settling releases only what its own build replaced', async () => {
  const docker = fakeDocker();
  const images = createReplacedImages(docker, { log: quiet });

  // Deploy 1: A -> B, container on B; its sweep notes the mark.
  images.rebuilt({ tag: TAG, agentId: REEL, previousImageId: 'sha256:A', builtImageId: 'sha256:B' });
  const first = images.mark();
  // Deploy 2 builds B -> C and swaps before deploy 1's container has settled.
  images.rebuilt({ tag: TAG, agentId: REEL, previousImageId: 'sha256:B', builtImageId: 'sha256:C' });
  const second = images.mark();
  docker.tags[TAG] = 'sha256:C';
  docker.containers = [{ ImageID: 'sha256:C' }];

  assert.ok(images.holds(REEL, first));
  images.release(REEL, first);
  assert.deepStrictEqual(await images.sweep(), ['sha256:A'], 'B is deploy 2\'s rollback until its container settles');
  assert.deepStrictEqual(images.entries().map(e => [e.imageId, e.released]), [['sha256:B', false]]);

  images.release(REEL, second);
  assert.deepStrictEqual(await images.sweep(), ['sha256:B']);
  assert.ok(!images.holds(REEL));
});

test('an unchanged build replaces nothing, and an image the tag points at again is never removed', async () => {
  const docker = fakeDocker();
  const images = createReplacedImages(docker, { log: quiet });
  images.rebuilt({ tag: TAG, agentId: REEL, previousImageId: 'sha256:A', builtImageId: 'sha256:A' });
  assert.deepStrictEqual(images.entries(), []);

  // A -> B, then a build that reproduces A: A is the tag's image again.
  images.rebuilt({ tag: TAG, agentId: REEL, previousImageId: 'sha256:A', builtImageId: 'sha256:B' });
  images.rebuilt({ tag: TAG, agentId: REEL, previousImageId: 'sha256:B', builtImageId: 'sha256:A' });
  assert.deepStrictEqual(images.entries().map(e => e.imageId), ['sha256:B']);
  images.release(REEL);
  assert.deepStrictEqual(await images.sweep(), ['sha256:B']);
  assert.ok(!docker.removed.includes('sha256:A'));
});

test('an image its tag points at is not removed, whoever retagged it', async () => {
  // Retired by the panel, then tagged again by a build outside it.
  const docker = fakeDocker({ tags: { [TAG]: 'sha256:A' } });
  const images = createReplacedImages(docker, { log: quiet });
  images.retire('sha256:A', { tag: TAG, agentId: REEL });
  images.release(REEL);
  assert.deepStrictEqual(await images.sweep(), []);
  assert.deepStrictEqual(docker.removed, []);
  assert.deepStrictEqual(images.entries(), [], 'it is current, not replaced');
});

test('a second retirement of the same image keeps the first', async () => {
  const docker = fakeDocker();
  const images = createReplacedImages(docker, { log: quiet });
  images.retire('sha256:A', { tag: TAG, agentId: REEL });
  const first = images.mark();
  images.retire('sha256:A', { tag: TAG, agentId: REEL });
  assert.strictEqual(images.mark(), first);
  assert.strictEqual(images.entries().length, 1);
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

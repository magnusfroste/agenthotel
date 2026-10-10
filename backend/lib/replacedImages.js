// The image a rebuild replaced, removed once nothing needs it.
//
// A rebuild retags an image: agenthotel-<id>:latest for a Git App, which
// rebuilds on every redeploy, and <runtime>-agenthotel:latest for a template
// rebuilt on request. The image the tag pointed to before becomes dangling,
// and nothing removed it but the manual prune. Six redeploys of reel-studio
// (~2.5 GB each) filled panel.froste.eu's 38 GB disk to 37 MB free; the prune
// then reclaimed 12 GB (2026-10-09).
//
// Two conditions guard the removal, and both must hold:
//   - the agent whose build replaced it has a new container up and healthy.
//     Before that the old image is the only thing that ever worked, so it is
//     kept — a deploy that never settles keeps it until one does;
//   - no container, running or stopped, still uses it. A template image is
//     shared by every agent of its runtime, so a rebuild for one hermes leaves
//     the others on the old image. It is held until the last of them has been
//     redeployed onto the new one, and removed by that deploy's sweep.
//
// Overlapping and back-to-back rebuilds of one tag (2026-10-09: reel-studio
// redeployed from the button and over MCP a minute apart, the MCP path outside
// the deploy queue). Both builds read "what the tag points at" before either
// retagged it, so both retired the original image and the first build's own
// image was never retired at all — 2.5 GB left dangling per overlap. Two rules
// close that:
//   - rebuilt() retires both the image the tag pointed at before the build and
//     the last image this panel built under that tag, so an image is retired
//     no matter which build read the tag when;
//   - every retirement carries a sequence number, and a deploy releases only
//     what was retired up to its own build (mark()). An earlier deploy that
//     settles healthy no longer releases the image a later, still unproven
//     build replaced.
// An image that is the tag's current target again (an unchanged build
// reproduces an old id) is never removed: Docker removes a singly tagged image
// by id without complaint, and that would delete the image the agent runs.
//
// The list lives in memory. A panel restart forgets it, and the manual prune
// (POST /api/docker/prune) still reclaims whatever it held.

function imagesInUse(containers) {
  return new Set((containers || []).map(c => c.ImageID).filter(Boolean));
}

function createReplacedImages(docker, { log = console } = {}) {
  // image id -> { tag, agentId, seq, released, heldLogged }
  const replaced = new Map();
  // tag -> the image id this panel's last build of it produced
  const lastBuilt = new Map();
  let seq = 0;

  const within = (entry, agentId, upTo) => entry.agentId === agentId && entry.seq <= upTo;

  const api = {
    // A build moved `tag` off imageId. Retiring an image twice keeps the first
    // retirement: it is the same image, replaced no later than then.
    retire(imageId, { tag, agentId }) {
      if (!imageId || replaced.has(imageId)) return;
      replaced.set(imageId, { tag, agentId, seq: ++seq, released: false, heldLogged: false });
    },

    // A build of `tag` for agentId produced builtImageId; previousImageId is
    // what the tag pointed at when that build started.
    rebuilt({ tag, agentId, previousImageId, builtImageId }) {
      if (!builtImageId) return;
      for (const old of [previousImageId, lastBuilt.get(tag)]) {
        if (old && old !== builtImageId) api.retire(old, { tag, agentId });
      }
      // The tag points here now, whatever an earlier build retired.
      replaced.delete(builtImageId);
      lastBuilt.set(tag, builtImageId);
    },

    // The newest retirement so far; a deploy notes it once its build is done.
    mark() {
      return seq;
    },

    holds(agentId, upTo = Infinity) {
      for (const entry of replaced.values()) if (within(entry, agentId, upTo)) return true;
      return false;
    },

    // The agent's new container is healthy, or the agent is gone: what its
    // builds up to `upTo` replaced may go once no container uses it.
    release(agentId, upTo = Infinity) {
      for (const entry of replaced.values()) if (within(entry, agentId, upTo)) entry.released = true;
    },

    // Removes every released image no container uses; returns their ids.
    // Never throws — a deploy must not fail over a cleanup.
    async sweep() {
      const ready = [...replaced].filter(([, e]) => e.released);
      if (!ready.length) return [];
      let inUse;
      try {
        inUse = imagesInUse(await docker.listContainers({ all: true }));
      } catch (err) {
        log.warn(`[Images] Could not list containers, keeping replaced images: ${err.message}`);
        return [];
      }
      const removed = [];
      for (const [imageId, entry] of ready) {
        const short = imageId.replace(/^sha256:/, '').slice(0, 12);
        if (await isTagged(imageId, entry.tag)) {
          replaced.delete(imageId);
          continue;
        }
        if (inUse.has(imageId)) {
          if (!entry.heldLogged) {
            log.log(`[Images] Keeping ${short}, the image ${entry.tag} replaced: a container still uses it`);
            entry.heldLogged = true;
          }
          continue;
        }
        try {
          // Never forced: Docker refuses an image a container uses, or one
          // that still carries another tag, and either refusal is right.
          await docker.getImage(imageId).remove();
          replaced.delete(imageId);
          removed.push(imageId);
          log.log(`[Images] Removed ${short}, the image ${entry.tag} replaced`);
        } catch (err) {
          if (err.statusCode === 404) { replaced.delete(imageId); continue; }
          if (!entry.heldLogged) {
            log.warn(`[Images] Could not remove ${short}, the image ${entry.tag} replaced: ${err.message}`);
            entry.heldLogged = true;
          }
        }
      }
      return removed;
    },

    entries() {
      return [...replaced].map(([imageId, e]) => ({ imageId, tag: e.tag, agentId: e.agentId, released: e.released }));
    }
  };

  // Whether `tag` points at imageId right now — then it is no longer replaced.
  async function isTagged(imageId, tag) {
    if (lastBuilt.get(tag) === imageId) return true;
    try {
      return (await docker.getImage(tag).inspect()).Id === imageId;
    } catch (e) {
      return false;
    }
  }

  return api;
}

// Resolves true once `check` has answered true `settleChecks` times in a row,
// false if that has not happened within `timeoutMs`. A container that dies
// shortly after it starts reads as running for a moment, so one good answer
// is not enough.
async function waitUntilSettled(check, {
  intervalMs = 5000, settleChecks = 6, timeoutMs = 15 * 60 * 1000,
  sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now
} = {}) {
  const deadline = now() + timeoutMs;
  let streak = 0;
  for (;;) {
    let ok = false;
    try { ok = await check(); } catch (e) { ok = false; }
    streak = ok ? streak + 1 : 0;
    if (streak >= settleChecks) return true;
    if (now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

module.exports = { createReplacedImages, waitUntilSettled, imagesInUse };

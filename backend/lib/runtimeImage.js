// How current an agent's runtime is.
//
// A runtime's image is built once from templates/<runtime>/Dockerfile and then
// reused, which is why a second agent starts in a second. It also meant
// agenthotel.froste.eu ran a month-old Hermes on every agent and nothing in the
// panel said so; the model picker simply showed fewer models than elsewhere
// (2026-10-03). Three questions, answered here:
//
//   - which version is this agent running?   (asked of the container, cached)
//   - is it the panel's current build?        (its image vs <runtime>-agenthotel:latest)
//   - is there a newer one upstream?          (the base image's registry digest)

const fs = require('fs');
const path = require('path');

// The image a Dockerfile builds from, with ARG defaults substituted:
// openclaw's says FROM ${OPENCLAW_IMAGE}.
function baseImageOf(dockerfile) {
  const args = {};
  for (const raw of String(dockerfile || '').split('\n')) {
    const line = raw.trim();
    const arg = /^ARG\s+([A-Za-z_][A-Za-z0-9_]*)=(\S+)/i.exec(line);
    if (arg) { args[arg[1]] = arg[2].replace(/^["']|["']$/g, ''); continue; }
    const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(line);
    if (from) {
      const image = from[1].replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, k) => (k in args ? args[k] : m));
      return image.includes('$') ? null : image;
    }
  }
  return null;
}

function baseImageFor(runtime, templatesDir = '/templates') {
  try {
    return baseImageOf(fs.readFileSync(path.join(templatesDir, runtime, 'Dockerfile'), 'utf8'));
  } catch (e) {
    return null;
  }
}

// The digest part of a RepoDigest: "name@sha256:…" → "sha256:…".
function digestsOf(repoDigests) {
  return (repoDigests || []).map(d => String(d).split('@')[1]).filter(Boolean);
}

// Newer upstream, given what was pulled and what the registry says now. An
// unknown on either side is not "newer": the panel must not nag on a registry
// hiccup or a base image it never pulled.
function upstreamIsNewer(localDigests, remoteDigest) {
  if (!remoteDigest || !localDigests || !localDigests.length) return false;
  return !localDigests.includes(remoteDigest);
}

// Registry answers are cached: Docker Hub rate-limits anonymous manifest
// requests, and a newer Hermes is not news by the minute.
const UPSTREAM_TTL_MS = 6 * 60 * 60 * 1000;
const upstreamCache = new Map(); // base image → { at, value }

async function upstreamStatus(docker, baseImage, now = Date.now()) {
  const hit = upstreamCache.get(baseImage);
  if (hit && now - hit.at < UPSTREAM_TTL_MS) return hit.value;

  let local = [];
  let pulledAt = null;
  try {
    const info = await docker.getImage(baseImage).inspect();
    local = digestsOf(info.RepoDigests);
    pulledAt = info.Created || null;
  } catch (e) { /* never pulled here */ }

  let remote = null;
  let error = null;
  try {
    const dist = await docker.getImage(baseImage).distribution();
    remote = dist && dist.Descriptor && dist.Descriptor.digest || null;
  } catch (e) {
    error = e.message;
  }
  const value = { baseImage, newer: upstreamIsNewer(local, remote), baseCreated: pulledAt, checkedAt: new Date(now).toISOString(), error };
  // A failed lookup is cached briefly, so a registry outage is retried soon.
  upstreamCache.set(baseImage, { at: error ? now - UPSTREAM_TTL_MS + 10 * 60 * 1000 : now, value });
  return value;
}

// The version a runtime reports, per image: an image does not change its
// version, so one exec per build is enough.
const versionCache = new Map(); // image id → version string

function firstLine(output) {
  return String(output || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n').map(l => l.trim()).find(Boolean) || null;
}

module.exports = {
  baseImageOf, baseImageFor, digestsOf, upstreamIsNewer, upstreamStatus, firstLine,
  versionCache, upstreamCache, UPSTREAM_TTL_MS
};

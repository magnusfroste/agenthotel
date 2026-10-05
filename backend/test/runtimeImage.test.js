// How current an agent's runtime is.
const { test } = require('node:test');
const assert = require('node:assert');
const { baseImageOf, digestsOf, upstreamIsNewer, upstreamStatus, firstLine, upstreamCache } = require('../lib/runtimeImage');

test('the base image is the first FROM, with ARG defaults filled in', () => {
  assert.strictEqual(baseImageOf('FROM nousresearch/hermes-agent:latest\nRUN true'), 'nousresearch/hermes-agent:latest');
  assert.strictEqual(baseImageOf('ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:latest\nFROM ${OPENCLAW_IMAGE}'), 'ghcr.io/openclaw/openclaw:latest');
  assert.strictEqual(baseImageOf('FROM --platform=linux/amd64 python:3.11-slim AS base'), 'python:3.11-slim');
  assert.strictEqual(baseImageOf('FROM $UNSET'), null, 'an unresolved ARG is not an image');
  assert.strictEqual(baseImageOf(''), null);
});

test('newer upstream means the registry digest is not one we pulled', () => {
  const local = digestsOf(['nousresearch/hermes-agent@sha256:aaa', 'mirror/hermes@sha256:bbb']);
  assert.deepStrictEqual(local, ['sha256:aaa', 'sha256:bbb']);
  assert.strictEqual(upstreamIsNewer(local, 'sha256:aaa'), false);
  assert.strictEqual(upstreamIsNewer(local, 'sha256:ccc'), true);
});

test('not knowing is never "newer" — no nagging on a registry hiccup or a never-pulled base', () => {
  assert.strictEqual(upstreamIsNewer(['sha256:aaa'], null), false);
  assert.strictEqual(upstreamIsNewer([], 'sha256:ccc'), false);
});

test('the registry is asked once per six hours per image', async () => {
  upstreamCache.clear();
  let calls = 0;
  const docker = { getImage: () => ({
    inspect: async () => ({ RepoDigests: ['x@sha256:old'], Created: '2026-09-24T00:00:00Z' }),
    distribution: async () => { calls++; return { Descriptor: { digest: 'sha256:new' } }; }
  }) };
  const t0 = Date.parse('2026-10-05T00:00:00Z');
  assert.strictEqual((await upstreamStatus(docker, 'x:latest', t0)).newer, true);
  await upstreamStatus(docker, 'x:latest', t0 + 60 * 60 * 1000);
  assert.strictEqual(calls, 1, 'within the hour: cached');
  await upstreamStatus(docker, 'x:latest', t0 + 7 * 60 * 60 * 1000);
  assert.strictEqual(calls, 2, 'after six hours: asked again');
});

test('a failed registry lookup is retried within minutes, not hours', async () => {
  upstreamCache.clear();
  let calls = 0;
  const docker = { getImage: () => ({
    inspect: async () => ({ RepoDigests: ['x@sha256:old'] }),
    distribution: async () => { calls++; throw new Error('toomanyrequests'); }
  }) };
  const t0 = Date.parse('2026-10-05T00:00:00Z');
  const first = await upstreamStatus(docker, 'y:latest', t0);
  assert.strictEqual(first.newer, false);
  assert.match(first.error, /toomanyrequests/);
  await upstreamStatus(docker, 'y:latest', t0 + 5 * 60 * 1000);
  assert.strictEqual(calls, 1);
  await upstreamStatus(docker, 'y:latest', t0 + 11 * 60 * 1000);
  assert.strictEqual(calls, 2);
});

test('the version is the first real line, without terminal colours', () => {
  assert.strictEqual(firstLine('\n\x1b[1mHermes Agent v0.21.5 (2026.9.24)\x1b[0m\nmore'), 'Hermes Agent v0.21.5 (2026.9.24)');
  assert.strictEqual(firstLine(''), null);
});

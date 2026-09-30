// Turning a template into a deployable agent. Until recently this path was dead
// end to end: the library listed templates and deploying one answered
// "Unknown runtime".
const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeDeploy, materializeDeploy } = require('../lib/templates');

test('a git-compose template keeps the repository, not just the compose file', () => {
  // A compose file that mounts its own repo's files cannot be carried as text.
  const deploy = normalizeDeploy({
    runtime: 'git-compose', repo: 'https://example.com/repo', ref: 'main',
    composeFile: 'docker-compose.yml', routeService: 'kong', routePort: 8000,
  });
  assert.strictEqual(deploy.runtime, 'git-compose');
  const { runtime, config } = materializeDeploy(deploy, {});
  assert.strictEqual(runtime, 'git-compose');
  assert.strictEqual(config.GIT_REPO, 'https://example.com/repo');
  assert.strictEqual(config.ROUTE_SERVICE, 'kong');
  assert.strictEqual(config.ROUTE_PORT, '8000');
});

test('a deploy block for an unknown runtime is refused', () => {
  assert.strictEqual(normalizeDeploy({ runtime: 'something-else', image: 'x' }), null);
  assert.strictEqual(normalizeDeploy({ runtime: 'git-compose' }), null, 'a repo is required');
  assert.strictEqual(normalizeDeploy({ runtime: 'docker-app' }), null, 'an image is required');
});

test('a docker-app template carries image and port as columns, not only config', () => {
  // They were only in config once, and the container was created from an empty
  // image: "no command specified", which says nothing about the cause.
  const filled = materializeDeploy(normalizeDeploy({ runtime: 'docker-app', image: 'caddy:2', port: 80 }), {});
  assert.strictEqual(filled.image, 'caddy:2');
  assert.strictEqual(filled.port, 80);
});

test('declared secrets are generated and substituted into the env file', () => {
  const deploy = normalizeDeploy({
    runtime: 'git-compose', repo: 'r',
    envFile: 'PASS=${PASS}\nSITE=https://${DOMAIN}\n',
    secrets: [{ key: 'PASS', generate: 'password', length: 20 }],
  });
  const { config } = materializeDeploy(deploy, { DOMAIN: 'example.com' });
  assert.match(config.COMPOSE_ENV, /^PASS=[A-Za-z0-9]{20}$/m);
  assert.match(config.COMPOSE_ENV, /^SITE=https:\/\/example\.com$/m);
});

test('a field left untouched means its default, not an unfilled placeholder', () => {
  const deploy = normalizeDeploy({
    runtime: 'git-compose', repo: 'r',
    envFile: 'MODEL=${EMBEDDING_MODEL}\n',
    env: [{ key: 'EMBEDDING_MODEL', default: 'text-embedding-3-small' }],
  });
  const { config } = materializeDeploy(deploy, {});
  assert.strictEqual(config.COMPOSE_ENV.trim(), 'MODEL=text-embedding-3-small');
});

test('what the panel knows about a deployment is substituted, not configured', () => {
  // DOMAIN and AGENT_NAME fill the env file; they are not the agent's own env.
  const { config } = materializeDeploy(
    normalizeDeploy({ runtime: 'docker-app', image: 'x', port: 80 }),
    { DOMAIN: 'a.example.com', AGENT_NAME: 'bob' });
  assert.strictEqual(config.AGENT_NAME, undefined);
  assert.strictEqual(config.DOMAIN, undefined);
});

test('a git-app template builds from the repository, with its env as config keys', () => {
  // One Dockerfile, no image published — how most MCP tools ship.
  const deploy = normalizeDeploy({
    runtime: 'git-app', repo: 'https://example.com/tool', port: 8000, healthcheck: '/health',
    envFile: 'TOOL_TOKEN=${TOOL_TOKEN}\nPUBLIC_URL=https://${DOMAIN}\n# a comment\n',
    secrets: [{ key: 'TOOL_TOKEN', generate: 'hex', bytes: 32 }],
    env: [{ key: 'VOICE', default: 'edge' }],
  });
  assert.strictEqual(deploy.runtime, 'git-app');
  const { runtime, port, config } = materializeDeploy(deploy, { DOMAIN: 'tool.example.com', AGENT_NAME: 'tool' });
  assert.strictEqual(runtime, 'git-app');
  assert.strictEqual(port, 8000, 'the port is a column, as for docker-app');
  assert.strictEqual(config.GIT_REPO, 'https://example.com/tool');
  assert.strictEqual(config.GIT_REF, 'main');
  assert.strictEqual(config.HEALTHCHECK_PATH, '/health');
  assert.match(config.TOOL_TOKEN, /^[0-9a-f]{64}$/, 'generated, and a key of its own so Credentials finds it');
  assert.strictEqual(config.PUBLIC_URL, 'https://tool.example.com');
  assert.strictEqual(config.VOICE, 'edge', 'a form field the env file did not mention still reaches the container');
  assert.strictEqual(config.DOMAIN, undefined, 'what the panel knows is substituted, not configured');
  assert.strictEqual(config.AGENT_NAME, undefined);
});

test('a git-app template needs a repository', () => {
  assert.strictEqual(normalizeDeploy({ runtime: 'git-app' }), null);
});

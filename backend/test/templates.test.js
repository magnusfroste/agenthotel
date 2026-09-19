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

// Which template a guest came from (lib/agentTemplate.js): shown as "Take"
// instead of "git-app" — and never a guess when two templates could fit.
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { normalizeRepo, imageName, matchTemplate, backfill } = require('../lib/agentTemplate');

const templates = [
  { id: 'reel-studio', deploy: { runtime: 'git-app', repo: 'https://github.com/magnusfroste/agenttake' } },
  { id: 'agentreports', deploy: { runtime: 'git-app', repo: 'https://github.com/magnusfroste/agentreports' } },
  { id: 'n8n', deploy: { runtime: 'docker-app', image: 'docker.n8n.io/n8nio/n8n:latest' } },
];

test('a repository is the same however it is spelled', () => {
  assert.strictEqual(normalizeRepo('http://GitHub.com/x/Repo.git/'), 'https://github.com/x/repo');
  assert.strictEqual(imageName('docker.n8n.io/n8nio/n8n:1.80.0'), 'docker.n8n.io/n8nio/n8n');
  assert.strictEqual(imageName('localhost:5000/app'), 'localhost:5000/app', 'a registry port is not a tag');
});

test('a guest matches the template whose repository or image it runs', () => {
  assert.strictEqual(matchTemplate({ runtime: 'git-app' }, { GIT_REPO: 'https://github.com/magnusfroste/agenttake.git' }, templates), 'reel-studio');
  assert.strictEqual(matchTemplate({ runtime: 'docker-app', image: 'docker.n8n.io/n8nio/n8n:1.80.0' }, {}, templates), 'n8n');
  assert.strictEqual(matchTemplate({ runtime: 'git-app' }, { GIT_REPO: 'https://github.com/someone/else' }, templates), null);
  assert.strictEqual(matchTemplate({ runtime: 'docker-app' }, { GIT_REPO: 'https://github.com/magnusfroste/agenttake' }, templates), null, 'the runtime has to agree');
  const twins = [...templates, { id: 'take-dev', deploy: { runtime: 'git-app', repo: 'https://github.com/magnusfroste/agenttake' } }];
  assert.strictEqual(matchTemplate({ runtime: 'git-app' }, { GIT_REPO: 'https://github.com/magnusfroste/agenttake' }, twins), null, 'two candidates: no guess');
});

test('backfill fills only guests without a template, and leaves the rest', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE agents (id TEXT, runtime TEXT, image TEXT, config TEXT, template TEXT)');
  const add = db.prepare('INSERT INTO agents VALUES (?,?,?,?,?)');
  add.run('take', 'git-app', '', JSON.stringify({ GIT_REPO: 'https://github.com/magnusfroste/agenttake' }), null);
  add.run('reports', 'git-app', '', JSON.stringify({ GIT_REPO: 'https://github.com/magnusfroste/agentreports' }), 'something-else');
  add.run('hermes', 'hermes', 'hermes-agenthotel:latest', '{}', null);
  assert.strictEqual(backfill(db, templates), 1);
  const t = Object.fromEntries(db.prepare('SELECT id, template FROM agents').all().map(r => [r.id, r.template]));
  assert.deepStrictEqual(t, { take: 'reel-studio', reports: 'something-else', hermes: null });
});

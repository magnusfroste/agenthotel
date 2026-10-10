// MCP deploys go through the panel's deploy queue and its one redeploy.
//
// 2026-10-09: a redeploy over MCP ran outside the queue, beside the Redeploy
// button's build of the same agent and commit; the image between the two
// builds was never removed.
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { createMcpServer } = require('../mcp');
const runtimes = { 'git-app': require('../plugins/git-app') };

const REEL = 'git-app-reel-studio-1790886075660';

function setup() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, runtime TEXT, domain TEXT, image TEXT, port INTEGER,
      config TEXT, status TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE events (type TEXT, agent_id TEXT, message TEXT);
    CREATE TABLE providers (name TEXT, type TEXT, apiKey TEXT, baseUrl TEXT, models TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  `);
  db.prepare('INSERT INTO agents (id, name, runtime, domain, image, port, config, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(REEL, 'reel-studio', 'git-app', 'reel.example.com', '', 8000, JSON.stringify({ GIT_REPO: 'https://github.com/x/reel-studio' }), 'running');
  const container = { stop: async () => {}, remove: async () => {} };
  const docker = { getContainer: () => container };
  return { db, docker };
}

async function call(server, name, args) {
  let body;
  const res = { json: b => { body = b; return res; }, status: () => res, send: () => res };
  await server.handleMcpRequest({ body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } }, res);
  return JSON.parse(body.result.content[0].text);
}

test('redeploy_agent is the panel\'s redeploy, not a copy outside the queue', async () => {
  const { db, docker } = setup();
  const calls = [];
  const server = createMcpServer(db, docker, runtimes, async () => { throw new Error('deployAgent called directly'); }, async () => {}, {
    ensureAgentImage: async () => { throw new Error('built outside the shared redeploy'); },
    redeployAgent: async (id, opts) => { calls.push([id, opts]); },
    enqueueDeploy: async work => work()
  });
  const out = await call(server, 'redeploy_agent', { agent_id: REEL, rebuild: true });
  assert.deepStrictEqual(out, { success: true, agent_id: REEL, status: 'running' });
  assert.deepStrictEqual(calls, [[REEL, { rebuildImage: true }]]);
});

test('redeploy_agent reports the shared redeploy\'s failure', async () => {
  const { db, docker } = setup();
  const server = createMcpServer(db, docker, runtimes, async () => {}, async () => {}, {
    redeployAgent: async () => { throw new Error('Build failed, the agent was left running: boom'); }
  });
  const out = await call(server, 'redeploy_agent', { agent_id: REEL });
  assert.match(out.error, /boom/);
});

test('set_agent_env builds and swaps inside the deploy queue', async () => {
  const { db, docker } = setup();
  let queued = false;
  const seen = [];
  const server = createMcpServer(db, docker, runtimes,
    async () => { seen.push(['deploy', queued]); },
    async () => {}, {
      ensureAgentImage: async () => { seen.push(['build', queued]); },
      enqueueDeploy: async (work, agentId) => {
        assert.strictEqual(agentId, REEL);
        queued = true;
        try { return await work(); } finally { queued = false; }
      }
    });
  const out = await call(server, 'set_agent_env', { agent_id: REEL, env: { FOO: 'bar' } });
  assert.strictEqual(out.success, true);
  assert.deepStrictEqual(seen, [['build', true], ['deploy', true]]);
});

test('set_agent_env: a failed build leaves the agent running and is reported', async () => {
  const { db, docker } = setup();
  const server = createMcpServer(db, docker, runtimes, async () => { throw new Error('must not deploy'); }, async () => {}, {
    ensureAgentImage: async () => { throw new Error('boom'); },
    enqueueDeploy: async work => work()
  });
  const out = await call(server, 'set_agent_env', { agent_id: REEL, env: { FOO: 'bar' } });
  assert.match(out.error, /Build failed, the agent was left running: boom/);
  assert.strictEqual(db.prepare('SELECT status FROM agents WHERE id = ?').get(REEL).status, 'running');
});

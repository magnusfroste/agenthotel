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
  assert.deepStrictEqual(calls, [[REEL, { rebuildImage: true, trigger: 'MCP' }]]);
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

test('get_deploy_log hands an agent the latest deploy and its log, masked', async () => {
  const { db, docker } = setup();
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const deployLog = require('../lib/deployLog').createDeployLog(db, fs.mkdtempSync(path.join(os.tmpdir(), 'mcpdl-')));
  const id = deployLog.queued(REEL, { kind: 'redeploy', trigger: 'MCP', config: { GIT_TOKEN: 'ghp_secretvalue1' } });
  await assert.rejects(deployLog.run(id, REEL, async () => {
    deployLog.line('cloning with ghp_secretvalue1');
    throw new Error('Image build did not produce agenthotel-x');
  }));
  const server = createMcpServer(db, docker, runtimes, async () => {}, async () => {}, { deployLog });
  const out = await call(server, 'get_deploy_log', { agent_id: REEL });
  assert.strictEqual(out.deployment.id, id);
  assert.strictEqual(out.deployment.status, 'failed');
  assert.strictEqual(out.deployment.trigger, 'MCP');
  assert.match(out.log, /Image build did not produce/);
  assert.doesNotMatch(out.log, /ghp_secretvalue1/);
  const other = await call(server, 'get_deploy_log', { agent_id: 'someone-else', deployment_id: id });
  assert.ok(other.note || other.error);
});

test('create_transfer needs the hotel address; import_from_hotel checks the link first', async () => {
  const { db, docker } = setup();
  const issued = [];
  const server = createMcpServer(db, docker, runtimes, async () => {}, async () => {}, {
    issueTransfer: async (id, opts) => { issued.push([id, opts]); return { url: `${opts.base}/api/transfer/${'a'.repeat(64)}` }; },
    startImportFrom: (url) => { if (!/\/api\/transfer\/[0-9a-f]{64}$/.test(url)) throw new Error('Not an AgentHotel transfer URL'); return { id: 'job1', status: 'downloading' }; },
    importJobs: new Map([['job1', { id: 'job1', status: 'done', agent: { name: 'reel-studio' } }]])
  });
  const noDomain = await call(server, 'create_transfer', { agent_id: REEL });
  assert.match(noDomain.error, /panel domain/);
  db.prepare("INSERT INTO settings (key, value) VALUES ('panel_domain', 'hotel-a.example.com')").run();
  const t = await call(server, 'create_transfer', { agent_id: REEL, include_data: false });
  assert.strictEqual(t.url, `https://hotel-a.example.com/api/transfer/${'a'.repeat(64)}`);
  assert.deepStrictEqual(issued[0][1], { includeData: false, stopOnPull: true, base: 'https://hotel-a.example.com' });
  assert.match((await call(server, 'import_from_hotel', { url: 'https://evil.example.com/x' })).error, /transfer URL/);
  assert.strictEqual((await call(server, 'import_from_hotel', { url: t.url })).job_id, 'job1');
  assert.strictEqual((await call(server, 'get_import_status', { job_id: 'job1' })).status, 'done');
});

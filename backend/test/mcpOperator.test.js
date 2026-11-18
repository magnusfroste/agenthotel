// An agent runs the hotel over MCP: what it needs to check a guest in, give
// it a name that works, and move it without starting over.
//
// 2026-11-14: Hermes was handed the panel's MCP endpoint to publish a game.
// It took four creates and twenty minutes: the name had no DNS record and
// nothing said so, PORT in config was ignored, a failed create held the domain
// and the next one got "UNIQUE constraint failed", every fix was delete and
// create, the create call outlived the client's timeout, and none of it was in
// the event log.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Database = require('better-sqlite3');
// The library this repository ships, read before lib/templates.js looks.
process.env.TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');
const { createMcpServer } = require('../mcp');
const { createDomainCheck, isCloudflare, parentOf } = require('../lib/domainCheck');

const runtimes = {
  'git-app': require('../plugins/git-app'),
  'docker-app': require('../plugins/docker-app'),
  hermes: { name: 'Hermes', defaultImage: 'hermes:latest', defaultPort: 9119, configFields: [], buildConfig: ({ config }) => ({ ...config }) },
  stack: {
    name: 'Stack', composeManaged: true, defaultImage: 'compose', defaultPort: 80, configFields: [],
    buildConfig: ({ config }) => ({ ...config }),
    deploy: async () => {}, stop: async () => {}, remove: async () => {}
  }
};

const GAME = 'git-app-geogeniet-1794698980057';

// name -> addresses; a name that is not listed does not exist.
function fakeDns(records, { failing = [] } = {}) {
  const answer = (family) => async (name) => {
    if (failing.includes(name)) throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
    const all = records[name] || (name.split('.').length > 2 && records['*.' + name.split('.').slice(1).join('.')]) || [];
    const mine = all.filter(a => (family === 6) === a.includes(':'));
    if (!mine.length) throw Object.assign(new Error('not found'), { code: all.length ? 'ENODATA' : 'ENOTFOUND' });
    return mine;
  };
  return { resolve4: answer(4), resolve6: answer(6) };
}

const HOTEL = '203.0.113.10';
const CF = '188.114.96.5';

function setup({ records = {}, failing = [], http = async () => ({ status: 200 }), extras = {}, deployAgent = null } = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT UNIQUE, runtime TEXT, domain TEXT UNIQUE, image TEXT, port INTEGER,
      config TEXT, status TEXT, template TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE events (type TEXT, agent_id TEXT, message TEXT);
    CREATE TABLE providers (name TEXT, type TEXT, apiKey TEXT, baseUrl TEXT, models TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO settings VALUES ('panel_domain', 'panel.example.org');
  `);
  db.prepare('INSERT INTO agents (id, name, runtime, domain, image, port, config, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(GAME, 'geogeniet', 'git-app', 'geogeniet.games.example', '', 8080,
      JSON.stringify({ GIT_REPO: 'https://github.com/x/geogeniet', PORT: '8080', PUBLIC_URL: 'https://geogeniet.games.example/' }), 'running');
  const deploys = [];
  const routesRemoved = [];
  const container = { stop: async () => {}, remove: async () => {} };
  // Docker's runtimes as this host had them on 2026-11-18, gVisor registered.
  const docker = { getContainer: () => container, info: async () => ({ Runtimes: { runc: {}, runsc: {} }, DefaultRuntime: 'runc' }) };
  const server = createMcpServer(db, docker, runtimes,
    deployAgent || (async (...a) => { deploys.push(a); }),
    async (agent) => { routesRemoved.push(agent.domain); },
    {
      domainCheck: createDomainCheck({
        resolver: fakeDns({ 'panel.example.org': [HOTEL], ...records }, { failing }),
        request: http
      }),
      ...extras
    });
  const events = () => db.prepare('SELECT type, agent_id, message FROM events').all();
  const row = (id) => db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  return { db, server, deploys, routesRemoved, events, row };
}

async function rpc(server, method, params) {
  let body, status = 200;
  const res = { json: b => { body = b; return res; }, status: s => { status = s; return res; }, send: () => res };
  await server.handleMcpRequest({ body: { jsonrpc: '2.0', id: 1, method, params } }, res);
  return { body, status };
}

async function call(server, name, args) {
  const { body } = await rpc(server, 'tools/call', { name, arguments: args });
  const out = JSON.parse(body.result.content[0].text);
  Object.defineProperty(out, 'isError', { value: !!body.result.isError });
  return out;
}

// ---- the protocol -----------------------------------------------------------

test('tools/list is an array of named tools, which is what an MCP client reads', async () => {
  const { server } = setup();
  const { body } = await rpc(server, 'tools/list');
  assert.ok(Array.isArray(body.result.tools));
  const names = body.result.tools.map(t => t.name);
  for (const name of ['create_agent', 'update_agent', 'check_domain', 'list_domains', 'redeploy_agent']) assert.ok(names.includes(name), name);
  for (const tool of body.result.tools) {
    assert.strictEqual(typeof tool.description, 'string');
    assert.strictEqual(tool.inputSchema.type, 'object');
  }
});

test('a ping is answered and a notification gets no reply', async () => {
  const { server } = setup();
  assert.deepStrictEqual((await rpc(server, 'ping')).body.result, {});
  const note = await rpc(server, 'notifications/initialized');
  assert.strictEqual(note.status, 202);
  assert.strictEqual(note.body, undefined);
});

test('a wrong argument name is answered with the names the tool takes', async () => {
  const { server } = setup();
  const out = await call(server, 'get_template', { id: 'git-app' });
  assert.ok(out.isError);
  assert.match(out.error, /Missing: template_id/);
  assert.match(out.error, /Not an argument of this tool: id/);

  // PORT beside port used to be dropped without a word.
  const create = await call(server, 'create_agent', { name: 'spel', runtime: 'git-app', PORT: 8080 });
  assert.match(create.error, /Not an argument of this tool: PORT/);
  assert.match(create.error, /port \(optional\)/);

  assert.match((await call(server, 'no_such_tool', {})).error, /Unknown tool/);
});

// ---- create_agent -----------------------------------------------------------

test('create_agent routes to the PORT in config, records the create and says where it ended up', async () => {
  const { server, deploys, events, row } = setup({ records: { 'ordjakten.games.example': [CF] } });
  const out = await call(server, 'create_agent', {
    name: 'ordjakten', runtime: 'git-app', domain: 'ordjakten.games.example',
    config: { GIT_REPO: 'https://github.com/x/ordjakten', GIT_REF: 'main', PORT: 8080 }
  });
  assert.strictEqual(out.success, true);
  assert.strictEqual(out.status, 'running');
  assert.strictEqual(out.port, 8080);
  assert.strictEqual(out.warning, undefined);
  assert.strictEqual(out.notes, undefined);

  assert.strictEqual(deploys.length, 1);
  const [id, name, runtime, domain, , port, config] = deploys[0];
  assert.deepStrictEqual([id, name, runtime, domain, port], [out.agent_id, 'ordjakten', 'git-app', 'ordjakten.games.example', 8080]);
  assert.strictEqual(config.PORT, '8080');
  assert.strictEqual(row(id).port, 8080);
  assert.strictEqual(row(id).status, 'running');
  assert.deepStrictEqual(events().map(e => [e.type, e.message]), [['agent.create', 'Created agent ordjakten over MCP']]);
});

test('create_agent: an explicit port wins, and a defaulted one is said out loud', async () => {
  const { server, deploys } = setup();
  const given = await call(server, 'create_agent', { name: 'a', runtime: 'git-app', port: 3000, config: { GIT_REPO: 'https://github.com/x/a', PORT: 8080 } });
  assert.strictEqual(given.port, 3000);
  assert.strictEqual(deploys[0][5], 3000);
  assert.strictEqual(deploys[0][6].PORT, '3000');

  const defaulted = await call(server, 'create_agent', { name: 'b', runtime: 'git-app', config: { GIT_REPO: 'https://github.com/x/b' } });
  assert.strictEqual(defaulted.port, 8000);
  assert.match(defaulted.notes[0], /No port given: traffic goes to 8000/);

  // A runtime with no PORT field listens where its image does: nothing to say.
  const agent = await call(server, 'create_agent', { name: 'c', runtime: 'hermes' });
  assert.strictEqual(agent.port, 9119);
  assert.strictEqual(agent.notes, undefined);

  assert.match((await call(server, 'create_agent', { name: 'd', runtime: 'git-app', port: 70000 })).error, /Invalid port/);
});

test('create_agent takes a template id as the runtime, as get_template says', async () => {
  const { server, deploys, row } = setup({ records: { 'flow.games.example': [CF] } });
  const out = await call(server, 'create_agent', { name: 'flow', runtime: 'n8n', domain: 'flow.games.example' });
  assert.strictEqual(out.success, true, JSON.stringify(out));
  const [id, , runtime, , image, port, config] = deploys[0];
  assert.strictEqual(runtime, 'docker-app');
  assert.strictEqual(image, 'docker.n8n.io/n8nio/n8n:latest');
  assert.strictEqual(port, 5678);
  assert.match(JSON.stringify(config), /https:\/\/flow\.games\.example\//);
  assert.strictEqual(row(id).template, 'n8n');
  assert.strictEqual(row(id).runtime, 'docker-app');

  const unknown = await call(server, 'create_agent', { name: 'x', runtime: 'no-such-thing' });
  assert.match(unknown.error, /Unknown runtime: no-such-thing\. list_runtimes and list_templates/);
});

test('create_agent refuses a bad name, and a name or domain that is held, by saying who holds it', async () => {
  const { server, deploys } = setup();
  assert.match((await call(server, 'create_agent', { name: 'Geo Geniet', runtime: 'git-app' })).error, /Invalid name/);
  assert.match((await call(server, 'create_agent', { name: 'x', runtime: 'git-app', config: 'PORT=8080' })).error, /config must be an object/);

  const sameDomain = await call(server, 'create_agent', { name: 'geo2', runtime: 'git-app', domain: 'geogeniet.games.example' });
  assert.ok(sameDomain.isError);
  assert.match(sameDomain.error, new RegExp(`geogeniet\\.games\\.example is held by the agent geogeniet \\(${GAME}, running\\)`));
  assert.match(sameDomain.error, /redeploy_agent retries it, update_agent changes its domain or port, delete_agent frees/);

  const sameName = await call(server, 'create_agent', { name: 'geogeniet', runtime: 'git-app', domain: 'other.games.example' });
  assert.match(sameName.error, /The name geogeniet is held by the agent geogeniet/);

  assert.match((await call(server, 'create_agent', { name: 'p', runtime: 'git-app', domain: 'panel.example.org' })).error, /the panel's own address/);
  assert.strictEqual(deploys.length, 0);
});

test('create_agent: a failed create keeps its guest and says what to do with it', async () => {
  let fails = true;
  const { server, events, row } = setup({
    deployAgent: async () => { if (fails) throw new Error('Build failed: npm ci exited 1'); }
  });
  const out = await call(server, 'create_agent', { name: 'trasig', runtime: 'git-app', domain: 'trasig.games.example', config: { GIT_REPO: 'https://github.com/x/t' } });
  assert.ok(out.isError);
  assert.match(out.error, /npm ci exited 1/);
  assert.strictEqual(out.status, 'failed');
  assert.match(out.next, /is kept and holds its name and trasig\.games\.example/);
  assert.match(out.next, /get_deploy_log/);
  assert.strictEqual(row(out.agent_id).status, 'failed');
  assert.deepStrictEqual(events().map(e => e.type), ['agent.error']);

  // The second attempt is told about the first, not about a table constraint.
  const again = await call(server, 'create_agent', { name: 'trasig2', runtime: 'git-app', domain: 'trasig.games.example' });
  assert.match(again.error, /held by the agent trasig \(.*, failed\)/);
  assert.doesNotMatch(again.error, /UNIQUE/);
});

test('create_agent warns when the name has no DNS record, and deploys all the same', async () => {
  const { server, deploys } = setup();
  const out = await call(server, 'create_agent', { name: 'nytt', runtime: 'git-app', domain: 'nytt.hotel.example', config: { GIT_REPO: 'https://github.com/x/n', PORT: 8080 } });
  assert.strictEqual(out.success, true);
  assert.match(out.warning, /nytt\.hotel\.example has no DNS record yet/);
  assert.strictEqual(deploys.length, 1);
});

test('create_agent answers before a long deploy ends, and the deploy still finishes', async () => {
  let finish;
  const building = new Promise(resolve => { finish = resolve; });
  const { server, events, row } = setup({ deployAgent: () => building });
  const out = await call(server, 'create_agent', { name: 'stort', runtime: 'git-app', config: { GIT_REPO: 'https://github.com/x/s', PORT: 8080 }, wait_seconds: 0 });
  assert.strictEqual(out.done, false);
  assert.strictEqual(out.status, 'creating');
  assert.match(out.next, /get_deploy_log/);
  assert.strictEqual(row(out.agent_id).status, 'creating');
  assert.deepStrictEqual(events(), []);

  finish();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(row(out.agent_id).status, 'running');
  assert.deepStrictEqual(events().map(e => e.type), ['agent.create']);
});

test('create_agent gives a guest that runs its own containers its route', async () => {
  const seen = [];
  runtimes.stack.deploy = async (id, name) => { seen.push(['deploy', name]); };
  const { server, deploys } = setup({
    records: { 'stack.games.example': [CF] },
    extras: { attachComposeRoute: async (agent, plugin, config, domain) => { seen.push(['route', agent.id, domain]); } }
  });
  const out = await call(server, 'create_agent', { name: 'stack', runtime: 'stack', domain: 'stack.games.example' });
  assert.strictEqual(out.success, true);
  assert.deepStrictEqual(seen, [['deploy', 'stack'], ['route', out.agent_id, 'stack.games.example']]);
  assert.strictEqual(deploys.length, 0);
});

// ---- update_agent -----------------------------------------------------------

function withRedeploy(options = {}) {
  const redeploys = [];
  const state = {};
  const ctx = setup({
    ...options,
    extras: {
      redeployAgent: async (id, opts) => {
        // The panel's redeploy reads the row when it starts.
        redeploys.push({ id, opts, row: state.row(id), routesRemovedBefore: [...state.routesRemoved] });
        if (options.redeployError) throw new Error(options.redeployError);
      },
      ...(options.extras || {})
    }
  });
  Object.assign(state, ctx);
  return { ...ctx, redeploys };
}

test('update_agent moves a guest to another name without a new guest', async () => {
  const { server, redeploys, routesRemoved, events, row } = withRedeploy({ records: { 'geo.games.example': [CF] } });
  const out = await call(server, 'update_agent', { agent_id: GAME, domain: 'geo.games.example' });
  assert.deepStrictEqual({ ...out }, { success: true, agent_id: GAME, status: 'running', changed: true, domain: 'geo.games.example', port: 8080 });

  // Redeployed once, from a row that already has the new name, with the old
  // name's route still in place: it serves until the new one does.
  assert.strictEqual(redeploys.length, 1);
  assert.deepStrictEqual(redeploys[0].opts, { trigger: 'MCP', kind: 'update' });
  assert.strictEqual(redeploys[0].row.domain, 'geo.games.example');
  assert.deepStrictEqual(redeploys[0].routesRemovedBefore, []);
  assert.deepStrictEqual(routesRemoved, ['geogeniet.games.example']);

  // What was written from the old name follows it.
  assert.strictEqual(JSON.parse(row(GAME).config).PUBLIC_URL, 'https://geo.games.example/');
  assert.deepStrictEqual(events().map(e => [e.type, e.message]),
    [['agent.update', 'Updated agent geogeniet over MCP: geogeniet.games.example → geo.games.example']]);
});

test('update_agent changes the port in the column and in the PORT field', async () => {
  const { server, redeploys, routesRemoved, row } = withRedeploy();
  const out = await call(server, 'update_agent', { agent_id: GAME, port: 3000 });
  assert.strictEqual(out.success, true);
  assert.strictEqual(redeploys[0].row.port, 3000);
  assert.strictEqual(JSON.parse(row(GAME).config).PORT, '3000');
  assert.strictEqual(row(GAME).domain, 'geogeniet.games.example');
  assert.deepStrictEqual(routesRemoved, []);
});

test('update_agent: a failed build leaves the guest where it was, in the row too', async () => {
  const before = withRedeploy().row(GAME);
  const { server, routesRemoved, row, events } = withRedeploy({
    records: { 'geo.games.example': [CF] },
    redeployError: 'Build failed, the agent was left running: npm ci exited 1'
  });
  const out = await call(server, 'update_agent', { agent_id: GAME, domain: 'geo.games.example', port: 3000 });
  assert.ok(out.isError);
  assert.strictEqual(out.changed, false);
  assert.strictEqual(out.domain, 'geogeniet.games.example');
  assert.strictEqual(row(GAME).domain, before.domain);
  assert.strictEqual(row(GAME).port, before.port);
  assert.strictEqual(row(GAME).config, before.config);
  assert.deepStrictEqual(routesRemoved, []);
  assert.deepStrictEqual(events(), []);
});

test('update_agent: a deploy that fails after the guest was taken down keeps the new values and says so', async () => {
  const { server, row } = withRedeploy({ records: { 'geo.games.example': [CF] }, redeployError: 'container exited 1' });
  const out = await call(server, 'update_agent', { agent_id: GAME, domain: 'geo.games.example' });
  assert.ok(out.isError);
  assert.strictEqual(out.changed, true);
  assert.match(out.next, /redeploy_agent retries/);
  assert.strictEqual(row(GAME).domain, 'geo.games.example');
});

test('update_agent moves a guest under gVisor, and back to the hotel default', async () => {
  const { server, redeploys, row, events } = withRedeploy();
  const out = await call(server, 'update_agent', { agent_id: GAME, container_runtime: 'runsc' });
  assert.strictEqual(out.success, true);
  assert.strictEqual(out.container_runtime, 'runsc');
  // The redeploy reads a row that already names the runtime.
  assert.strictEqual(JSON.parse(redeploys[0].row.config).CONTAINER_RUNTIME, 'runsc');
  assert.strictEqual(row(GAME).domain, 'geogeniet.games.example');
  assert.deepStrictEqual(events().map(e => e.message), ['Updated agent geogeniet over MCP: runtime hotel default → runsc']);

  const back = await call(server, 'update_agent', { agent_id: GAME, container_runtime: '' });
  assert.strictEqual(back.changed, true);
  assert.ok(!('CONTAINER_RUNTIME' in JSON.parse(row(GAME).config)), 'the hotel default is no key at all');

  const same = await call(server, 'update_agent', { agent_id: GAME, container_runtime: '' });
  assert.strictEqual(same.changed, false);
  assert.strictEqual(redeploys.length, 2);
});

test('update_agent refuses a runtime Docker does not have, and leaves the guest alone', async () => {
  const { server, redeploys, row } = withRedeploy();
  const before = row(GAME).config;
  const out = await call(server, 'update_agent', { agent_id: GAME, container_runtime: 'kata' });
  assert.ok(out.isError);
  assert.match(out.error, /no runtime "kata" \(registered: runc, runsc\)/);
  assert.strictEqual(redeploys.length, 0);
  assert.strictEqual(row(GAME).config, before);
});

// 2026-11-18: update_agent named system_status as the place to find the
// runtimes, and system_status did not list them, so an agent had to guess.
test('system_status lists the runtimes a guest can run under, and which one each guest is set to', async () => {
  const { db, server } = setup();
  db.prepare("INSERT INTO agents (id, name, runtime, domain, port, config, status) VALUES ('hermes-porter-1', 'porter', 'hermes', 'porter.example.org', 9119, ?, 'running')")
    .run(JSON.stringify({ CONTAINER_RUNTIME: 'runsc', OPENAI_API_KEY: 'sk-example-not-a-key' }));

  const out = await call(server, 'system_status', {});
  assert.deepStrictEqual(out.container_runtimes.available.map(r => [r.name, r.isDockerDefault, r.isolation.kind]),
    [['runc', true, 'container'], ['runsc', false, 'gvisor']]);
  assert.strictEqual(out.container_runtimes.hotel_default, 'runc');
  assert.strictEqual(out.container_runtimes.hotel_default_source, 'docker');
  const by = Object.fromEntries(out.agents.map(a => [a.name, [a.container_runtime, a.container_runtime_source]]));
  assert.deepStrictEqual(by, { geogeniet: ['runc', 'docker'], porter: ['runsc', 'guest'] });
  assert.ok(!JSON.stringify(out).includes('sk-example'), 'a guest\'s config stays out of the answer');

  db.prepare("INSERT INTO settings VALUES ('default_container_runtime', 'runsc')").run();
  const later = await call(server, 'system_status', {});
  assert.strictEqual(later.container_runtimes.hotel_default, 'runsc');
  assert.strictEqual(later.container_runtimes.hotel_default_source, 'setting');
  assert.deepStrictEqual(later.agents.find(a => a.name === 'geogeniet').container_runtime, 'runsc');
});

test('update_agent refuses what it cannot do, before it touches anything', async () => {
  const { db, server, redeploys } = withRedeploy();
  db.prepare("INSERT INTO agents (id, name, runtime, domain, port, config, status) VALUES ('hermes-porter-1', 'porter', 'hermes', 'porter.example.org', 9119, '{}', 'running')").run();
  db.prepare("INSERT INTO agents (id, name, runtime, domain, port, config, status) VALUES ('stack-s-1', 's', 'stack', 's.example.org', 80, '{}', 'running')").run();

  assert.match((await call(server, 'update_agent', { agent_id: 'nobody' })).error, /Agent not found/);
  assert.match((await call(server, 'update_agent', { agent_id: GAME })).error, /Nothing to change/);
  assert.match((await call(server, 'update_agent', { agent_id: GAME, domain: 'porter.example.org' })).error, /held by the agent porter/);
  assert.match((await call(server, 'update_agent', { agent_id: GAME, domain: 'Geo.games.example' })).error, /capital letters/);
  assert.match((await call(server, 'update_agent', { agent_id: GAME, port: 0 })).error, /Invalid port/);
  assert.match((await call(server, 'update_agent', { agent_id: 'stack-s-1', domain: 't.example.org' })).error, /runs its own containers/);

  const same = await call(server, 'update_agent', { agent_id: GAME, domain: 'geogeniet.games.example', port: 8080 });
  assert.strictEqual(same.changed, false);

  db.prepare("UPDATE agents SET status = 'redeploying' WHERE id = ?").run(GAME);
  assert.match((await call(server, 'update_agent', { agent_id: GAME, port: 3000 })).error, /A deploy of geogeniet is going/);
  assert.strictEqual(redeploys.length, 0);
});

// ---- the redeploy tools no longer hold the call -------------------------------

test('redeploy_agent answers before a long redeploy ends', async () => {
  let finish;
  const going = new Promise(resolve => { finish = resolve; });
  const { server } = setup({ extras: { redeployAgent: () => going } });
  const out = await call(server, 'redeploy_agent', { agent_id: GAME, wait_seconds: 0 });
  assert.deepStrictEqual({ ...out }, {
    agent_id: GAME, status: 'redeploying', done: false,
    next: 'Still deploying, and it goes on without this call. get_deploy_log shows progress; get_agent says running when it ends'
  });
  finish();
});

test('set_agent_env stores the values and answers before a long redeploy ends', async () => {
  let finish;
  const going = new Promise(resolve => { finish = resolve; });
  const { server, row } = setup({ extras: { ensureAgentImage: () => going } });
  const out = await call(server, 'set_agent_env', { agent_id: GAME, env: { LEVEL: '3' }, wait_seconds: 0 });
  assert.strictEqual(out.done, false);
  assert.deepStrictEqual(out.set, ['LEVEL']);
  assert.strictEqual(JSON.parse(row(GAME).config).LEVEL, '3');
  finish();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(row(GAME).status, 'running');
});

// ---- names --------------------------------------------------------------------

test('check_domain: a name with no record is not ready, and says what it needs', async () => {
  const { server } = setup();
  const out = await call(server, 'check_domain', { domain: 'geogeniet.hotel.example' });
  assert.strictEqual(out.valid, true);
  assert.strictEqual(out.ready, false);
  assert.strictEqual(out.held_by, null);
  assert.strictEqual(out.dns.state, 'no-record');
  assert.deepStrictEqual(out.parent, { zone: 'hotel.example', wildcard: false });
  assert.match(out.verdict, new RegExp(`needs an A record to ${HOTEL.replace(/\./g, '\\.')}`));
});

test('check_domain: under a wildcard a free name resolves already', async () => {
  const { server } = setup({ records: { '*.games.example': [CF], '*.direct.example': [HOTEL] } });
  const proxied = await call(server, 'check_domain', { domain: 'ordjakten.games.example' });
  assert.strictEqual(proxied.dns.state, 'proxied');
  assert.strictEqual(proxied.parent.wildcard, true);
  assert.strictEqual(proxied.ready, null);
  assert.match(proxied.verdict, /Free, and resolves through Cloudflare/);

  const direct = await call(server, 'check_domain', { domain: 'spel.direct.example' });
  assert.strictEqual(direct.dns.state, 'here');
  assert.strictEqual(direct.ready, true);
});

test('check_domain: a held name is asked what it answers from outside', async () => {
  const asked = [];
  let status = 200;
  const { server } = setup({
    records: { 'geogeniet.games.example': [CF] },
    http: async (name, address) => { asked.push([name, address]); return { status }; }
  });
  const up = await call(server, 'check_domain', { domain: 'geogeniet.games.example' });
  assert.deepStrictEqual(up.held_by, { agent_id: GAME, name: 'geogeniet', status: 'running' });
  assert.strictEqual(up.ready, true);
  assert.deepStrictEqual(up.answers, { status: 200 });
  assert.deepStrictEqual(asked, [['geogeniet.games.example', CF]]);

  status = 502;
  const down = await call(server, 'check_domain', { domain: 'geogeniet.games.example' });
  assert.strictEqual(down.ready, false);
  assert.match(down.verdict, /answers HTTP 502/);
  assert.match(down.verdict, /update_agent with the port/);
});

test('check_domain: a name that points elsewhere, a mistyped one, and DNS not answering', async () => {
  const { server } = setup({ records: { 'www.other.example': ['198.51.100.7'] }, failing: ['slow.other.example'] });
  const elsewhere = await call(server, 'check_domain', { domain: 'www.other.example' });
  assert.strictEqual(elsewhere.dns.state, 'elsewhere');
  assert.strictEqual(elsewhere.ready, false);

  const bad = await call(server, 'check_domain', { domain: 'take_01.example.org' });
  assert.strictEqual(bad.valid, false);
  assert.match(bad.verdict, /underscore/);

  const unknown = await call(server, 'check_domain', { domain: 'slow.other.example' });
  assert.strictEqual(unknown.dns.state, 'unknown');
  assert.strictEqual(unknown.ready, null);

  assert.match((await call(server, 'check_domain', { domain: 'panel.example.org' })).verdict, /panel's own address/);
});

test('check_domain: a hotel whose panel is behind Cloudflare is compared by the address it knows', async () => {
  const { server } = setup({
    records: { 'panel.example.org': [CF], 'spel.direct.example': [HOTEL], 'www.other.example': ['198.51.100.7'] },
    extras: { serverAddress: async () => HOTEL }
  });
  assert.strictEqual((await call(server, 'check_domain', { domain: 'spel.direct.example' })).dns.state, 'here');
  assert.strictEqual((await call(server, 'check_domain', { domain: 'www.other.example' })).dns.state, 'elsewhere');
  const none = await call(server, 'check_domain', { domain: 'nytt.direct.example' });
  assert.match(none.verdict, new RegExp(`needs an A record to ${HOTEL.replace(/\\./g, '\\.')} `));
  assert.strictEqual((await call(server, 'list_domains', {})).address, HOTEL);

  // An address that cannot be told is no reason to fail the check.
  const blind = setup({ records: { 'panel.example.org': [CF], 'spel.direct.example': [HOTEL] }, extras: { serverAddress: async () => { throw new Error('offline'); } } });
  assert.strictEqual((await call(blind.server, 'check_domain', { domain: 'spel.direct.example' })).dns.state, 'resolves');
});

test('list_domains groups the guests by zone and says where a new name needs no DNS change', async () => {
  const { db, server } = setup({ records: { '*.games.example': [CF] } });
  db.prepare("INSERT INTO agents (id, name, runtime, domain, port, config, status) VALUES ('hermes-porter-1', 'porter', 'hermes', 'porter.example.org', 9119, '{}', 'running')").run();
  db.prepare("INSERT INTO agents (id, name, runtime, domain, port, config, status) VALUES ('hermes-nodomain-1', 'nodomain', 'hermes', NULL, 9119, '{}', 'running')").run();
  const out = await call(server, 'list_domains', {});
  assert.strictEqual(out.panel, 'panel.example.org');
  assert.deepStrictEqual(out.zones.map(z => [z.zone, z.wildcard, z.guests.map(g => g.name)]), [
    ['games.example', true, ['geogeniet']],
    ['example.org', false, ['porter']]
  ]);
  assert.match(out.zones[0].new_names, /no DNS change needed/);
  assert.match(out.zones[1].new_names, /need a DNS record/);
});

test('delete_agent leaves a trace in the event log', async () => {
  const { server, events, row } = setup({ extras: { removeAgentVolumes: async () => {} } });
  const out = await call(server, 'delete_agent', { agent_id: GAME });
  assert.strictEqual(out.success, true);
  assert.strictEqual(row(GAME), undefined);
  assert.deepStrictEqual(events().map(e => [e.type, e.agent_id, e.message]), [['agent.delete', GAME, 'Deleted agent geogeniet over MCP']]);
});

// ---- lib/domainCheck ----------------------------------------------------------

test('domainCheck: Cloudflare addresses and parent zones', () => {
  assert.strictEqual(isCloudflare('188.114.96.5'), true);
  assert.strictEqual(isCloudflare('104.21.3.4'), true);
  assert.strictEqual(isCloudflare('2606:4700:3030::1'), true);
  assert.strictEqual(isCloudflare('203.0.113.10'), false);
  assert.strictEqual(isCloudflare('not an address'), false);
  assert.strictEqual(parentOf('geogeniet.games.example'), 'games.example');
  assert.strictEqual(parentOf('a.lobby.example.org'), 'lobby.example.org');
  assert.strictEqual(parentOf('games.example'), null);
});

test('domainCheck: a hotel behind Cloudflare itself cannot be compared with', async () => {
  const check = createDomainCheck({ resolver: fakeDns({ 'panel.example.org': [CF], 'spel.example.org': ['198.51.100.7'] }) });
  const out = await check.check('spel.example.org', { hotel: ['panel.example.org'] });
  assert.strictEqual(out.state, 'resolves');
  assert.deepStrictEqual(out.hotelAddresses, []);
});

test('domainCheck: a wildcard is seen by asking for a name nobody made', async () => {
  const asked = [];
  const dns = fakeDns({ '*.games.example': [CF] }, { failing: [] });
  const resolver = { resolve4: n => { asked.push(n); return dns.resolve4(n); }, resolve6: n => dns.resolve6(n) };
  const check = createDomainCheck({ resolver });
  assert.strictEqual(await check.hasWildcard('games.example'), true);
  assert.strictEqual(await check.hasWildcard('hotel.example'), false);
  assert.match(asked[0], /^ah-check-[0-9a-f]{10}\.games\.example$/);
  assert.notStrictEqual(asked[0].split('.')[0], asked[1].split('.')[0]);
});

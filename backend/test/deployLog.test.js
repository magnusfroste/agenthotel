// The deploy log: one row per deploy and its full log, kept after the deploy
// and across a restart (lib/deployLog.js).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createDeployLog, note, KEEP_PER_AGENT } = require('../lib/deployLog');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploylog-'));
  const db = new Database(':memory:');
  db.exec("CREATE TABLE agents (id TEXT, name TEXT); INSERT INTO agents VALUES ('a1', 'davida')");
  return { db, dir, log: createDeployLog(db, dir) };
}

test('a deploy is queued, runs, succeeds and keeps its log', async () => {
  const { log } = fresh();
  const id = log.queued('a1', { kind: 'redeploy', trigger: 'panel' });
  assert.strictEqual(log.get(id).status, 'queued');
  assert.strictEqual(log.get(id).agent_name, 'davida');
  const result = await log.run(id, 'a1', async () => {
    log.line('Building image: hermes-agenthotel:latest');
    return 42;
  });
  assert.strictEqual(result, 42);
  const row = log.get(id);
  assert.strictEqual(row.status, 'succeeded');
  assert.ok(row.finished_at >= row.started_at);
  const { text, done } = log.read(id);
  assert.ok(done);
  assert.match(text, /redeploy of davida queued \(panel\)/);
  assert.match(text, /Building image/);
  assert.match(text, /Deploy finished/);
});

test('a failed deploy records its error and rethrows it', async () => {
  const { log } = fresh();
  const id = log.queued('a1');
  await assert.rejects(log.run(id, 'a1', async () => { throw new Error('No such image'); }), /No such image/);
  assert.strictEqual(log.get(id).status, 'failed');
  assert.strictEqual(log.get(id).error, 'No such image');
  assert.match(log.read(id).text, /Deploy failed: No such image/);
});

test('console output inside a deploy lands in its log, outside it does not', async () => {
  const { log } = fresh();
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    log.teeConsole();
    const id = log.queued('a1');
    console.log('before the deploy');
    await log.run(id, 'a1', async () => {
      console.log('Using existing image: x');
      await new Promise(r => setTimeout(r, 5));
      console.warn('slow start');
      note('Container agenthotel-a1 Started');
    });
    const { text } = log.read(id);
    assert.match(text, /Using existing image: x/);
    assert.match(text, /WARN: slow start/);
    assert.match(text, /Container agenthotel-a1 Started/);
    assert.doesNotMatch(text, /before the deploy/);
  } finally {
    Object.assign(console, saved);
  }
});

test('build output that arrives outside the context is attributed by agent id', async () => {
  const { log } = fresh();
  const id = log.queued('a1');
  let release;
  const gate = new Promise(r => { release = r; });
  const running = log.run(id, 'a1', () => gate);
  log.line('Step 3/18 : RUN npm install', 'a1');
  log.line('for someone else', 'a2');
  release();
  await running;
  assert.match(log.read(id).text, /Step 3\/18/);
  assert.doesNotMatch(log.read(id).text, /someone else/);
});

test('secret config values are masked in the log', async () => {
  const { log } = fresh();
  const id = log.queued('a1', { config: { OPENAI_API_KEY: 'sk-live-abcdef123', HERMES_MODEL: 'gpt-5.6-luna' } });
  await log.run(id, 'a1', async () => log.line('export OPENAI_API_KEY=sk-live-abcdef123 model gpt-5.6-luna'));
  const { text } = log.read(id);
  assert.doesNotMatch(text, /sk-live-abcdef123/);
  assert.match(text, /OPENAI_API_KEY=•+ model gpt-5\.6-luna/);
});

test('a viewer follows the log from an offset', async () => {
  const { log } = fresh();
  const id = log.queued('a1');
  let release;
  const running = log.run(id, 'a1', () => new Promise(r => { release = r; }));
  const first = log.read(id, 0);
  assert.strictEqual(first.done, false);
  log.line('Step 1/2', 'a1');
  const second = log.read(id, first.offset);
  assert.match(second.text, /Step 1\/2/);
  assert.doesNotMatch(second.text, /queued/);
  release();
  await running;
  assert.strictEqual(log.read(id, second.offset).done, true);
});

test('a deploy a restart cut off is marked interrupted', () => {
  const { db, dir } = fresh();
  const first = createDeployLog(db, dir);
  const id = first.queued('a1');
  db.prepare("UPDATE deployments SET status = 'running' WHERE id = ?").run(id);
  const after = createDeployLog(db, dir);
  assert.strictEqual(after.interruptStale(), 1);
  assert.strictEqual(after.get(id).status, 'interrupted');
  assert.match(after.read(id).text, /Interrupted by a panel restart/);
});

test('only the latest deploys per agent are kept, logs included', async () => {
  const { log } = fresh();
  const ids = [];
  for (let i = 0; i < KEEP_PER_AGENT + 3; i++) {
    const id = log.queued('a1');
    ids.push(id);
    await log.run(id, 'a1', async () => {});
  }
  assert.strictEqual(log.list('a1', 100).length, KEEP_PER_AGENT);
  assert.strictEqual(log.get(ids[0]), null);
  await new Promise(r => setTimeout(r, 20));
  assert.ok(!fs.existsSync(log.file(ids[0])));
  assert.ok(fs.existsSync(log.file(ids[ids.length - 1])));
});

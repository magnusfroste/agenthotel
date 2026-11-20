// The Fleet's Activity view: who uses the CPU and the memory right now.
//
// 2026-11-15: two agents worked all night on one server and the panel could
// show the host's totals or one guest at a time, never who was heavy. Build
// containers, often the heaviest, were not shown anywhere.
const { test } = require('node:test');
const assert = require('node:assert');
const { createActivity, createSeries, kindOf, coresBetween, memoryOf, ownerOf } = require('../lib/activity');

const META = {
  hermes: { category: 'AI Agent' },
  'git-app': { category: 'Docker App' },
  compose: { category: 'Docker Compose' },
  'reel-studio': { category: 'MCP Tool' },
  lobby: { category: 'Web' }
};

test('a guest is an agent, a tool from the library, or an app checked in without a template', () => {
  assert.strictEqual(kindOf({ runtime: 'hermes', template: null }, META), 'agent');
  assert.strictEqual(kindOf({ runtime: 'git-app', template: 'reel-studio' }, META), 'tool');
  assert.strictEqual(kindOf({ runtime: 'git-app', template: 'lobby' }, META), 'tool');
  assert.strictEqual(kindOf({ runtime: 'git-app', template: null }, META), 'app');
  assert.strictEqual(kindOf({ runtime: 'compose', template: null }, META), 'app');
});

test('CPU is in cores, from the difference between two one-shot samples', () => {
  // 0.5 s of CPU while the 8-core host counted 8 s: half a core.
  assert.strictEqual(coresBetween({ cpu: 0, sys: 0 }, { cpu: 5e8, sys: 8e9, online: 8 }), 0.5);
  assert.strictEqual(coresBetween(null, { cpu: 1, sys: 1, online: 8 }), null);
  // A restarted container's counter starts over: no number rather than a negative one.
  assert.strictEqual(coresBetween({ cpu: 9e9, sys: 0 }, { cpu: 1e8, sys: 8e9, online: 8 }), null);
});

test('memory leaves out the page cache the kernel can take back, like docker stats', () => {
  assert.deepStrictEqual(
    memoryOf({ memory_stats: { usage: 300, limit: 1000, stats: { inactive_file: 100 } } }),
    { used: 200, limit: 1000 });
});

test('containers are attributed to their guest, the panel, or the build in progress', () => {
  const ctx = {
    agents: new Map([['hermes-a-1', { id: 'hermes-a-1', name: 'concierge', runtime: 'hermes' }]]),
    projects: new Map([['agenthotel-compose-b-2', { id: 'compose-b-2', name: 'shop', runtime: 'compose' }]]),
    meta: META,
    panelProject: 'agenthotel',
    building: []
  };
  assert.strictEqual(ownerOf({ Labels: { 'agenthotel.id': 'hermes-a-1' } }, ctx).name, 'concierge');
  assert.strictEqual(ownerOf({ Labels: { 'com.docker.compose.project': 'agenthotel-compose-b-2' } }, ctx).kind, 'app');
  assert.strictEqual(ownerOf({ Labels: { 'com.docker.compose.project': 'agenthotel' } }, ctx).kind, 'hotel');
  assert.strictEqual(ownerOf({ Names: ['/quirky_name'], Labels: {} }, ctx).kind, 'other');

  const during = { ...ctx, building: [{ id: 'git-app-c-3', name: 'puzzle' }] };
  const build = ownerOf({ Names: ['/quirky_name'], Labels: {} }, during);
  assert.strictEqual(build.kind, 'build');
  assert.strictEqual(build.name, 'Building puzzle');
  assert.strictEqual(build.agentId, 'git-app-c-3');
});

function fakeHost() {
  // /proc/stat: user nice system idle iowait ...; two cores' worth of ticks.
  let ticks = 0;
  return {
    advance(busy, idle) { ticks += 1; this.busy += busy; this.idle += idle; },
    busy: 0, idle: 0,
    readFileSync(file) {
      if (file === '/proc/stat') return `cpu  ${this.busy} 0 0 ${this.idle} 0 0 0 0\n`;
      if (file === '/proc/meminfo') return 'MemTotal: 1000 kB\nMemAvailable: 400 kB\n';
      throw new Error('unexpected ' + file + ticks);
    }
  };
}

function fakeDocker(containers) {
  return {
    listContainers: async () => containers.map(c => ({ Id: c.id, Names: [`/${c.id}`], Labels: c.labels })),
    getContainer: id => ({
      stats: async opts => {
        assert.deepStrictEqual(opts, { stream: false, 'one-shot': true });
        const c = containers.find(x => x.id === id);
        c.cpu += c.perSample;
        c.sys += 4e9;
        return {
          cpu_stats: { cpu_usage: { total_usage: c.cpu }, system_cpu_usage: c.sys, online_cpus: 2 },
          memory_stats: { usage: c.mem, limit: 2000 }
        };
      }
    })
  };
}

test('a snapshot sums a guest, ranks by CPU, and says what is left for the system', async () => {
  const host = fakeHost();
  const containers = [
    { id: 'a', labels: { 'agenthotel.id': 'hermes-a-1' }, cpu: 0, sys: 0, perSample: 2e9, mem: 300 * 1024 },
    { id: 'b', labels: { 'agenthotel.id': 'git-app-g-2' }, cpu: 0, sys: 0, perSample: 2e8, mem: 10 * 1024 }
  ];
  const docker = fakeDocker(containers);
  const origStat = host.readFileSync.bind(host);
  let n = 0;
  host.readFileSync = (f) => { if (f === '/proc/stat') { n += 1; host.busy += 150; host.idle += 50; } return origStat(f); };
  const activity = createActivity({
    docker, fs: host, cores: 2, intervalMs: 50, idleMs: 200,
    context: async () => ({
      agents: new Map([
        ['hermes-a-1', { id: 'hermes-a-1', name: 'concierge', runtime: 'hermes' }],
        ['git-app-g-2', { id: 'git-app-g-2', name: 'puzzle', runtime: 'git-app' }]
      ]),
      projects: new Map(), meta: META, panelProject: 'agenthotel', building: []
    })
  });
  const snap = await activity.snapshot();
  activity.stop();
  assert.ok(snap.ready);
  assert.deepStrictEqual(snap.items.map(i => i.name), ['concierge', 'puzzle']);
  // 2e9 of 4e9 system ns on 2 cores = 1 core.
  assert.strictEqual(snap.items[0].cores, 1);
  assert.strictEqual(snap.items[0].kind, 'agent');
  assert.strictEqual(snap.items[1].kind, 'app');
  // The host was 75 % busy on 2 cores = 1.5 cores; the guests used 1.1.
  assert.strictEqual(snap.host.cpu, 1.5);
  assert.ok(Math.abs(snap.system.cores - 0.4) < 1e-9);
  assert.strictEqual(snap.system.mem, 600 * 1024 - 310 * 1024);
  assert.strictEqual(snap.kinds.agent.count, 1);
  assert.strictEqual(snap.items[0].history.cpu.length, 2);
  assert.ok(n >= 2);
});

test('the sampler stops by itself when nobody looks', async () => {
  const host = fakeHost();
  const containers = [{ id: 'a', labels: {}, cpu: 0, sys: 0, perSample: 1e8, mem: 1 }];
  let calls = 0;
  const docker = fakeDocker(containers);
  const list = docker.listContainers;
  docker.listContainers = async () => { calls += 1; return list(); };
  const activity = createActivity({
    docker, fs: host, cores: 2, intervalMs: 20, idleMs: 60,
    context: async () => ({ agents: new Map(), projects: new Map(), meta: META, panelProject: null, building: [] })
  });
  await activity.snapshot();
  await new Promise(r => setTimeout(r, 250));
  const after = calls;
  await new Promise(r => setTimeout(r, 150));
  assert.strictEqual(calls, after, 'no samples once nobody has asked for a while');
  activity.stop();
});

// 2026-11-20: opening the view showed nothing until it had sampled for a
// while; the question is usually "what happened in the last minutes".
function reading(containers, hostBusy, hostIdle) {
  return {
    hostCpu: { idle: hostIdle, total: hostBusy + hostIdle },
    hostMem: { total: 1000, used: 600 },
    containers: containers.map(([id, name, cpu, sys, mem]) => ({
      id, owner: { key: id, name, kind: 'app', agentId: id }, cpu: { cpu, sys, online: 2 }, mem: { used: mem, limit: 0 }
    }))
  };
}

test('the hour keeps a fixed window: the oldest point slides out as a new one comes', () => {
  const s = createSeries({ cores: 2, intervalMs: 60000, keep: 3, keepGone: true, now: () => 0 });
  for (let i = 0; i <= 5; i++) s.add(reading([['a', 'shop', i * 1e9, i * 4e9, 100 + i]], i * 10, i * 10));
  const snap = s.latest();
  assert.strictEqual(snap.host.history.mem.length, 3);
  assert.deepStrictEqual(snap.items[0].history.mem, [103, 104, 105]);
  // A point's CPU is the average since the one before: 1e9 of 4e9 on 2 cores.
  assert.deepStrictEqual(snap.items[0].history.cpu, [0.5, 0.5, 0.5]);
});

test('a guest that stopped stays in the hour until its last point slides out', () => {
  const s = createSeries({ cores: 2, intervalMs: 60000, keep: 3, keepGone: true, now: () => 0 });
  s.add(reading([['a', 'shop', 0, 0, 10], ['b', 'Building quiz', 0, 0, 50]], 0, 0));
  s.add(reading([['a', 'shop', 1e9, 4e9, 10], ['b', 'Building quiz', 2e9, 4e9, 50]], 10, 10));
  s.add(reading([['a', 'shop', 2e9, 8e9, 10]], 20, 20));
  let b = s.latest().items.find(i => i.key === 'b');
  assert.ok(b && b.gone, 'the build is still shown after it ended');
  assert.strictEqual(b.name, 'Building quiz');
  assert.deepStrictEqual(b.history.mem, [50, 50, null]);
  // Gone guests count in no total.
  assert.strictEqual(s.latest().kinds.app.count, 1);
  s.add(reading([['a', 'shop', 3e9, 12e9, 10]], 30, 30));
  s.add(reading([['a', 'shop', 4e9, 16e9, 10]], 40, 40));
  b = s.latest().items.find(i => i.key === 'b');
  assert.strictEqual(b, undefined, 'gone once all its points have slid out');
});

test('the live view drops a stopped guest at once, as before', () => {
  const s = createSeries({ cores: 2, intervalMs: 3000, keep: 60, now: () => 0 });
  s.add(reading([['a', 'shop', 0, 0, 10], ['b', 'quiz', 0, 0, 50]], 0, 0));
  s.add(reading([['a', 'shop', 1e9, 4e9, 10]], 10, 10));
  assert.deepStrictEqual(s.latest().items.map(i => i.key), ['a']);
});

test('the hour fills by itself, and asking for it starts no live sampling', async () => {
  const host = fakeHost();
  const containers = [{ id: 'a', labels: {}, cpu: 0, sys: 0, perSample: 1e8, mem: 1 }];
  let calls = 0;
  const docker = fakeDocker(containers);
  const list = docker.listContainers;
  docker.listContainers = async () => { calls += 1; return list(); };
  const origStat = host.readFileSync.bind(host);
  host.readFileSync = (f) => { if (f === '/proc/stat') { host.busy += 10; host.idle += 30; } return origStat(f); };
  const activity = createActivity({
    docker, fs: host, cores: 2, intervalMs: 20, idleMs: 60, hourIntervalMs: 30, hourKeep: 4, firstHourMs: 0,
    context: async () => ({ agents: new Map(), projects: new Map(), meta: META, panelProject: null, building: [] })
  });
  assert.strictEqual(activity.hourSnapshot().ready, false);
  activity.start();
  // Well past the four points the window holds.
  await new Promise(r => setTimeout(r, 600));
  const snap = activity.hourSnapshot();
  activity.stop();
  assert.ok(snap.ready);
  assert.ok(snap.since);
  assert.strictEqual(snap.intervalMs, 30);
  assert.strictEqual(snap.host.history.mem.length, 4, 'never more than the window');
  const after = calls;
  activity.hourSnapshot();
  await new Promise(r => setTimeout(r, 80));
  assert.strictEqual(calls, after, 'stopped, and reading the hour sampled nothing');
});

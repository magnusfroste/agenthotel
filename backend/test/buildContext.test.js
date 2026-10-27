// A Git App build cannot race git's own cleanup of the checkout.
const { test, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const tar = require('tar-fs');
const { packContext, isExcluded } = require('../lib/buildContext');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-context-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A checkout as the builds directory holds it: a tree and its .git.
function checkoutIn(dir) {
  fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM scratch\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'console.log(1)\n');
  fs.mkdirSync(path.join(dir, '.git', 'objects', 'be'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'objects', 'be', '415036ae470c4c3b6729e73ab8e99682f78124'), 'x');
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  // Not the repository's .git: a file whose name merely starts the same.
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
}

// Packs and unpacks, so the test sees what the daemon would get.
function roundTrip(stream, into) {
  return new Promise((resolve, reject) => {
    stream.on('error', reject);
    stream.pipe(tar.extract(into)).on('finish', resolve).on('error', reject);
  });
}

test('an excluded path and everything below it, and nothing else', () => {
  const git = path.resolve('/data/builds/a/.git');
  assert.strictEqual(isExcluded('/data/builds/a/.git', [git]), true);
  assert.strictEqual(isExcluded('/data/builds/a/.git/objects/be/41', [git]), true);
  assert.strictEqual(isExcluded('/data/builds/a/.gitignore', [git]), false);
  assert.strictEqual(isExcluded('/data/builds/a/src/.git', [git]), false);
  assert.strictEqual(isExcluded('/data/builds/a/Dockerfile', []), false);
});

test("the build context leaves the repository's .git out", async (t) => {
  const repo = tmpDir(t), out = tmpDir(t);
  checkoutIn(repo);
  await roundTrip(packContext(repo, { exclude: [path.join(repo, '.git')] }), out);
  assert.ok(!fs.existsSync(path.join(out, '.git')), '.git is not in the context');
  assert.ok(fs.existsSync(path.join(out, 'Dockerfile')));
  assert.ok(fs.existsSync(path.join(out, 'src', 'app.js')));
  assert.ok(fs.existsSync(path.join(out, '.gitignore')), 'a file named .git<something> is kept');
});

test('without an exclude list everything is packed, as before', async (t) => {
  const repo = tmpDir(t), out = tmpDir(t);
  checkoutIn(repo);
  await roundTrip(packContext(repo), out);
  assert.ok(fs.existsSync(path.join(out, '.git', 'HEAD')));
});

// What gc does to a deploy: a loose object listed a moment ago is gone when
// the packer stats it. Deployment 54 of agent-take failed exactly so.
test('a loose object pruned mid-pack no longer fails the build', async (t) => {
  const repo = tmpDir(t);
  checkoutIn(repo);
  const realLstat = fs.lstat;
  mock.method(fs, 'lstat', (p, ...rest) => {
    const cb = rest[rest.length - 1];
    if (String(p).includes(`${path.sep}.git${path.sep}objects${path.sep}be${path.sep}`)) {
      const e = new Error(`ENOENT: no such file or directory, lstat '${p}'`);
      e.code = 'ENOENT';
      return process.nextTick(cb, e);
    }
    return realLstat(p, ...rest);
  });
  t.after(() => mock.restoreAll());

  await assert.rejects(roundTrip(packContext(repo), tmpDir(t)), /ENOENT.*\.git\/objects\/be/,
    'packing .git races gc');
  await roundTrip(packContext(repo, { exclude: [path.join(repo, '.git')] }), tmpDir(t));
});

// Loads a runtime with git replaced by a recorder, in a scratch builds root.
function withFakeGit(t, modulePath) {
  const root = tmpDir(t);
  const calls = [];
  mock.method(childProcess, 'execFileSync', (cmd, args, opts) => {
    assert.strictEqual(cmd, 'git');
    calls.push(args);
    const sub = args[args.findIndex(a => !a.startsWith('-') && !a.includes('='))];
    if (sub === 'init') fs.mkdirSync(path.join(opts.cwd, '.git'), { recursive: true });
    if (sub === 'reset') fs.writeFileSync(path.join(opts.cwd, 'Dockerfile'), 'FROM scratch\n');
    if (sub === 'rev-parse') return Buffer.from(args.includes('--short') ? 'abc1234\n' : 'abc1234def\n');
    if (sub === 'log') return Buffer.from('abc1234\0subject\x002026-10-27T11:19:00Z\n');
    return Buffer.from('');
  });
  const prev = process.env.AGENTHOTEL_BUILD_ROOT;
  process.env.AGENTHOTEL_BUILD_ROOT = root;
  // Both destructure execFileSync and read the root when loaded.
  for (const m of ['../lib/gitCheckout', '../plugins/git-app']) delete require.cache[require.resolve(m)];
  const mod = require(modulePath);
  t.after(() => {
    mock.restoreAll();
    if (prev === undefined) delete process.env.AGENTHOTEL_BUILD_ROOT; else process.env.AGENTHOTEL_BUILD_ROOT = prev;
    for (const m of ['../lib/gitCheckout', '../plugins/git-app']) delete require.cache[require.resolve(m)];
  });
  return { mod, calls, root };
}

const NO_DETACH = ['-c', 'gc.autoDetach=false', '-c', 'maintenance.autoDetach=false'];

test('Git App runs every git command with gc in the foreground, and keeps .git out of the build', (t) => {
  const { mod, calls, root } = withFakeGit(t, '../plugins/git-app');
  const config = { GIT_REPO: 'https://github.com/magnusfroste/agenttake', GIT_REF: 'main' };
  const prepared = mod.prepareBuild('git-app-take-1', config);
  assert.ok(calls.some(a => a.includes('fetch')), 'it fetched');
  for (const args of calls) assert.deepStrictEqual(args.slice(0, 4), NO_DETACH, `git ${args.join(' ')}`);
  assert.deepStrictEqual(prepared.exclude, [path.join(root, 'git-app-take-1', '.git')]);
  assert.strictEqual(prepared.buildArgs.GIT_SHA, 'abc1234def', 'the image still gets the commit');
});

test('Git Compose checkouts run git the same way', (t) => {
  const { mod, calls } = withFakeGit(t, '../lib/gitCheckout');
  mod.checkout('git-compose-hub-1', { GIT_REPO: 'https://github.com/example/hub', GIT_REF: 'main' });
  assert.ok(calls.some(a => a.includes('fetch')), 'it fetched');
  for (const args of calls) assert.deepStrictEqual(args.slice(0, 4), NO_DETACH, `git ${args.join(' ')}`);
});

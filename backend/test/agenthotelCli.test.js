// The host's `agenthotel` command (bin/agenthotel). An upgrade moves the
// checkout before it builds, so a build that failed left HEAD at origin/main
// while the old panel kept running, and the next `agenthotel upgrade` answered
// "already up to date" (2026-11-17). These run the real script against a real
// git origin and clone, with `docker` replaced by a stub that remembers what
// was built and what runs.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.join(__dirname, '..', '..', 'bin', 'agenthotel');

// State files in $STATE: running (the commit the backend container was built
// from; absent = no container), built, build-fails, busy (the blocker's
// sentence), calls (every docker invocation).
const DOCKER_STUB = `#!/bin/sh
echo "$*" >> "$STATE/calls"
if [ "$1" = inspect ]; then
  echo "PATH=/usr/local/bin:/usr/bin"
  echo "GIT_COMMIT=$(cat "$STATE/running")"
  exit 0
fi
case "$1 $2" in
  "compose ps")
    case "$*" in
      *--quiet*) [ -f "$STATE/running" ] && echo c0ffee ;;
      *) echo backend; echo frontend ;;
    esac ;;
  "compose exec")
    case "$*" in
      *blockers*) if [ -f "$STATE/busy" ]; then cat "$STATE/busy"; exit 2; fi ;;
    esac ;;
  "compose build")
    if [ -f "$STATE/build-fails" ]; then echo "gyp ERR! connect ETIMEDOUT nodejs.org" >&2; exit 1; fi
    for a; do case "$a" in GIT_COMMIT=*) echo "\${a#GIT_COMMIT=}" > "$STATE/built" ;; esac; done ;;
  "compose up")
    [ -f "$STATE/built" ] && cp "$STATE/built" "$STATE/running" ;;
esac
exit 0
`;

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1'
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' }).trim();
}

function commit(cwd, name) {
  fs.writeFileSync(path.join(cwd, name), name);
  git(cwd, 'add', name);
  git(cwd, 'commit', '-q', '-m', name);
  return git(cwd, 'rev-parse', '--short', 'HEAD');
}

// An installation at commit A whose panel runs A, and an origin that may be
// ahead of it.
function hotel() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthotel-cli-'));
  const origin = path.join(root, 'origin.git');
  const upstream = path.join(root, 'upstream');
  const dir = path.join(root, 'install');
  const state = path.join(root, 'state');
  const bin = path.join(root, 'bin');
  for (const d of [state, bin]) fs.mkdirSync(d);

  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'init', '-q', '-b', 'main', upstream);
  git(upstream, 'remote', 'add', 'origin', origin);
  const a = commit(upstream, 'a');
  git(upstream, 'push', '-q', 'origin', 'main');
  git(root, 'clone', '-q', origin, dir);
  fs.writeFileSync(path.join(state, 'running'), a + '\n');

  fs.writeFileSync(path.join(bin, 'docker'), DOCKER_STUB, { mode: 0o755 });
  // The script updates the copy of itself that `command -v agenthotel` finds,
  // so it runs from a copy in the stub directory, first on PATH: a host with
  // the real command installed must never have it replaced by a test.
  const cli = path.join(bin, 'agenthotel');
  fs.copyFileSync(SCRIPT, cli);
  fs.chmodSync(cli, 0o755);

  const run = (...args) => {
    const r = spawnSync(cli, args, {
      encoding: 'utf8',
      env: {
        ...process.env, ...GIT_ENV,
        PATH: `${bin}:${process.env.PATH}`,
        AGENTHOTEL_DIR: dir,
        AGENTHOTEL_BACKUPS: path.join(root, 'backups'),
        STATE: state
      }
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const read = (f) => (fs.existsSync(path.join(state, f)) ? fs.readFileSync(path.join(state, f), 'utf8') : '');
  const set = (f, v) => fs.writeFileSync(path.join(state, f), v);
  const unset = (f) => fs.rmSync(path.join(state, f), { force: true });
  const ahead = () => { const c = commit(upstream, `c${Date.now()}${Math.random()}`); git(upstream, 'push', '-q', 'origin', 'main'); return c; };
  const head = () => git(dir, 'rev-parse', '--short', 'HEAD');
  const full = (c) => git(dir, 'rev-parse', c);
  return { a, run, read, set, unset, ahead, head, full, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('an upgrade whose build failed is finished by the next run, not called up to date', (t) => {
  const h = hotel();
  t.after(h.cleanup);
  const b = h.ahead();

  h.set('build-fails', '');
  const failed = h.run('upgrade');
  assert.strictEqual(failed.code, 1);
  assert.strictEqual(h.head(), b, 'the checkout moved before the build, as before');
  assert.match(failed.err, new RegExp(`the build of ${b} failed`));
  assert.match(failed.err, new RegExp(`still runs ${h.a}`));
  assert.match(failed.err, /agenthotel upgrade +# try again/);
  assert.doesNotMatch(failed.err, /--now/, 'a retry must not be told to skip the blockers check');
  assert.doesNotMatch(h.read('calls'), /compose up/);

  h.unset('build-fails');
  const resumed = h.run('upgrade');
  assert.strictEqual(resumed.code, 0, resumed.err);
  assert.doesNotMatch(resumed.out, /already up to date/);
  assert.match(resumed.out, new RegExp(`the checkout is at ${b}, but the panel runs ${h.a}`));
  assert.match(resumed.out, /database backed up to/);
  assert.match(resumed.out, new RegExp(`upgraded to ${b}`));
  assert.strictEqual(h.read('running').trim(), b);
  const calls = h.read('calls');
  assert.match(calls, new RegExp(`compose build --build-arg GIT_COMMIT=${b} backend frontend`));
  assert.match(calls, /compose up -d/);
});

test('a panel that runs the checkout is up to date, whatever the hash length', (t) => {
  const h = hotel();
  t.after(h.cleanup);
  // Built when the short hash had another length than it has now.
  h.set('running', h.full('HEAD').slice(0, 10) + '\n');
  const r = h.run('upgrade');
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`already up to date \\(${h.a}\\)`));
  assert.doesNotMatch(h.read('calls'), /compose (build|up|cp)/);
});

test('finishing an upgrade still waits for a deploy in flight', (t) => {
  const h = hotel();
  t.after(h.cleanup);
  h.ahead();
  h.set('build-fails', '');
  h.run('upgrade');
  h.unset('build-fails');

  h.set('busy', 'An import of guest-one is running; wait for it, or upgrade anyway with force: true.');
  const r = h.run('upgrade');
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /not now\. An import of guest-one is running/);
  assert.match(r.err, /or run it anyway with --now/);
  assert.strictEqual(h.read('running').trim(), h.a, 'the old panel is left running');
  assert.strictEqual(h.read('calls').match(/compose build/g).length, 1, 'only the first, failed build');
});

test('a panel built without GIT_COMMIT, or with no container, is not up to date', (t) => {
  for (const running of ['unknown', null]) {
    const h = hotel();
    t.after(h.cleanup);
    if (running) h.set('running', running + '\n'); else h.unset('running');
    const r = h.run('upgrade');
    assert.strictEqual(r.code, 0, r.err);
    assert.match(r.out, /finishing the upgrade/);
    assert.strictEqual(h.read('running').trim(), h.a);
  }
});

test('check and version show the checkout and what the panel runs', (t) => {
  const h = hotel();
  t.after(h.cleanup);
  let r = h.run('check');
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`checkout +${h.a}`));
  assert.match(r.out, new RegExp(`panel runs +${h.a}`));
  assert.match(r.out, /^up to date$/m);

  const b = h.ahead();
  h.set('build-fails', '');
  h.run('upgrade');

  r = h.run('check');
  assert.match(r.out, new RegExp(`checkout +${b}`));
  assert.match(r.out, new RegExp(`panel runs +${h.a}`));
  assert.match(r.out, /does not run it/);
  assert.match(r.out, /run: agenthotel upgrade/);

  r = h.run('version');
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`checkout +${b} +c`));
  assert.match(r.out, new RegExp(`panel runs +${h.a}`));
  assert.match(r.out, /services +backend frontend/);
  assert.match(r.out, /does not run the checkout/);
});

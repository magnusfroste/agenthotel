// The installer's port check, which has been wrong twice in opposite
// directions: first "cannot tell" passed as free, then a free port aborted the
// install outright because `set -e` saw a bare call return non-zero. It runs on
// exactly one occasion — a fresh host — so nothing here is noticed by anyone
// already running the panel.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'preflight-ports.sh');

// Runs check_ports the way install.sh does: under `set -e`, so a bare
// non-zero return would abort before the echo ever runs.
function run(ports, { tools = 'ss' } = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  // Stub whichever tool the script should find. "busy" ports are the ones the
  // stub reports as listening.
  if (tools === 'ss') {
    fs.writeFileSync(path.join(bin, 'ss'), '#!/bin/sh\ncase "$*" in *:4433*) echo "LISTEN 0 128 *:4433 *:*";; esac\nexit 0\n', { mode: 0o755 });
  } else if (tools === 'lsof') {
    fs.writeFileSync(path.join(bin, 'lsof'), '#!/bin/sh\ncase "$*" in *:4433*) exit 0;; esac\nexit 1\n', { mode: 0o755 });
  }
  const script = `set -e\n. ${SCRIPT}\ncheck_ports ${ports.join(' ')}\necho REACHED_THE_END\n`;
  try {
    // With no tool stubbed, the PATH holds only the empty stub directory —
    // otherwise the host's own ss is found and the case cannot be tested.
    const PATH = tools === 'none' ? bin : `${bin}:/usr/bin:/bin`;
    // /bin/sh by absolute path: with only the stub directory on PATH, node
    // would not find the shell itself and the failure would look like the
    // script's.
    const out = execFileSync('/bin/sh', ['-c', script], {
      env: { PATH }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    });
    return { ok: true, out };
  } catch (err) {
    return { ok: false, out: String(err.stdout || ''), err: String(err.stderr || '') };
  }
}

test('free ports let the install continue', () => {
  // The regression: under `set -e` this aborted with no output at all.
  const r = run([8081, 8082]);
  assert.ok(r.ok, `aborted on free ports: ${r.err}`);
  assert.match(r.out, /REACHED_THE_END/);
});

test('a port in use stops the install, and says which', () => {
  const r = run([8081, 4433]);
  assert.strictEqual(r.ok, false);
  assert.match(r.err, /already running on port 4433/);
  assert.doesNotMatch(r.out, /REACHED_THE_END/);
});

test('the same holds when only lsof is available', () => {
  assert.ok(run([8081], { tools: 'lsof' }).ok, 'free port with lsof');
  assert.strictEqual(run([4433], { tools: 'lsof' }).ok, false, 'busy port with lsof');
});

test('"cannot tell" is not "free"', () => {
  // Guessing here is how a broken install starts: Caddy fails later, far from
  // the cause.
  const r = run([8081], { tools: 'none' });
  assert.strictEqual(r.ok, false);
  assert.match(r.err, /cannot check whether port 8081 is free/);
});

// Every copy of a guest's volumes is checked against what it was copied from
// (lib/volumeCensus.js). The census itself runs in busybox; these pin the
// scripts it runs and how its output is read and compared.
const { test } = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const c = require('../lib/volumeCensus');

test('a census line is read, also from a TTY and among other output', () => {
  assert.deepStrictEqual(c.parse('12 3456\r'), { files: 12, bytes: 3456 });
  assert.strictEqual(c.parse('tar: removing leading /'), null);
  assert.deepStrictEqual(c.lastCensus('tar: something\r\n3 10\r\n7 99\r\n'), { files: 7, bytes: 99 });
  assert.strictEqual(c.lastCensus(''), null);
});

test('a copy that differs is an error that says what is missing', () => {
  c.assertSame('v', { files: 3, bytes: 10 }, { files: 3, bytes: 10 }, 'x');
  assert.throws(() => c.assertSame('agenthotel-magnus-opt-data', { files: 412, bytes: 1181116006 }, { files: 1, bytes: 52428800 }, 'after unpacking it here'),
    /volume agenthotel-magnus-opt-data is incomplete after unpacking it here: expected 412 file\(s\), 1126\.4 MB, found 1 file\(s\), 50\.0 MB/);
  assert.throws(() => c.assertSame('v', { files: 1, bytes: 1 }, null, 'x'), /found nothing readable/);
});

test('a path with a quote cannot break out of the script', () => {
  assert.match(c.directoryScript("/vol/it's"), /cd '\/vol\/it'\\''s'/);
});

// The scripts themselves, where a shell with find, stat, tar and awk exists
// (the CI runner and the backend image both have them).
test('the directory and its archive give the same census, hard links counted once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-'));
  const vol = path.join(dir, 'vol');
  fs.mkdirSync(path.join(vol, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(vol, 'state.db'), 'x'.repeat(1000));
  fs.writeFileSync(path.join(vol, 'sub', 'notes.md'), 'hello\n');
  fs.linkSync(path.join(vol, 'state.db'), path.join(vol, 'sub', 'state-link.db'));
  const archive = path.join(dir, 'a.tar.gz');
  try {
    execSync(`tar czf ${archive} -C ${vol} .`);
    const run = script => c.lastCensus(execSync(script, { shell: '/bin/sh' }).toString());
    const source = run(c.directoryScript(vol));
    assert.deepStrictEqual(source, { files: 3, bytes: 1006 });
    assert.deepStrictEqual(run(c.archiveScript(archive, { gzip: true })), source);
  } catch (err) {
    if (/not found|ENOENT/.test(String(err.message))) return; // no shell tools here
    throw err;
  }
});

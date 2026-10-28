// An export's volume archive must never travel over the helper container's
// output. It did, attached with a TTY, and the pty rewrote the bytes: a 1.1 GB
// Hermes volume arrived at the other hotel as one cache file and no sessions.
// These pin the shape that keeps it safe: tar writes the file itself, into
// the panel's data volume, and a failed tar leaves nothing behind.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tarVolumeToFile, STAGING } = require('../lib/volumeTar');

const self = { image: 'agenthotel-backend', dataMountSource: 'agenthotel_agenthotel-data' };

// Stands in for dockerode: records the call, and plays tar by writing the
// archive where /staging points on the panel's side.
function fakeDocker(dataDir, exitCode = 0) {
  const calls = [];
  return {
    calls,
    async run(image, cmd, stream, opts) {
      calls.push({ image, cmd, opts });
      const target = cmd[2].replace(/^\/staging/, dataDir);
      fs.writeFileSync(target, 'archive');
      stream.end?.();
      return [{ StatusCode: exitCode }];
    }
  };
}

test('tar writes the archive into the data volume, not to its output', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voltar-'));
  const docker = fakeDocker(dataDir);
  const file = await tarVolumeToFile(docker, self, 'agenthotel-x-opt-data', dataDir);

  const { cmd, opts } = docker.calls[0];
  assert.strictEqual(cmd[0], 'tar');
  assert.strictEqual(cmd[1], 'cf');
  assert.notStrictEqual(cmd[2], '-', 'the archive must not go to stdout');
  assert.match(cmd[2], new RegExp(`^/staging/${STAGING}/vol-.*\\.tar$`));
  assert.deepStrictEqual(cmd.slice(3), ['-C', '/vol', '.']);
  assert.deepStrictEqual(opts.HostConfig.Binds, ['agenthotel-x-opt-data:/vol:ro', 'agenthotel_agenthotel-data:/staging']);
  assert.strictEqual(file, path.join(dataDir, STAGING, path.basename(cmd[2])));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'archive');
});

test('a failed tar throws and leaves no partial archive', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voltar-'));
  const docker = fakeDocker(dataDir, 2);
  await assert.rejects(tarVolumeToFile(docker, self, 'agenthotel-x-data', dataDir), /exit code 2/);
  assert.deepStrictEqual(fs.readdirSync(path.join(dataDir, STAGING)), []);
});

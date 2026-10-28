// Tar an agent's volume to a file, for an export or a transfer.
//
// The tar used to come back over the helper container's stdout, attached with
// Tty: true "for a clean stream". A TTY is not binary-safe: the pty turns
// every LF into CRLF, so the archive grew by about half and its headers broke
// after the first file. busybox tar on the importing hotel stopped there, now
// and then with exit 0, and the import reported "3 volume(s) restored" while a
// Hermes agent's 1.1 GB /opt/data arrived as one cache file and no state.db:
// 28 sessions gone from the copy (found moving "magnus", 2026-10-28).
//
// Now the helper writes the archive straight into the panel's data volume,
// mounted at /staging, as the nightly backups do. No stream carries it, so
// nothing can rewrite it, and a volume of any size costs no memory.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PassThrough } = require('stream');

const STAGING = 'exports-tmp';

async function tarVolumeToFile(docker, { image, dataMountSource }, volumeName, dataDir = '/data') {
  const dir = path.join(dataDir, STAGING);
  // The archive holds the agent's .env and keys.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `vol-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tar`;
  const file = path.join(dir, name);
  const [result] = await docker.run(image, ['tar', 'cf', `/staging/${STAGING}/${name}`, '-C', '/vol', '.'], new PassThrough(), {
    Tty: true,
    HostConfig: { Binds: [`${volumeName}:/vol:ro`, `${dataMountSource}:/staging`], AutoRemove: true }
  });
  if (result.StatusCode !== 0) {
    fs.rmSync(file, { force: true });
    throw new Error(`tar of volume ${volumeName} failed with exit code ${result.StatusCode}`);
  }
  return file;
}

module.exports = { tarVolumeToFile, STAGING };

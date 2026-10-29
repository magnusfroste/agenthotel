// Extracts one tar entry from a service-export zip into a mounted volume.
// Runs inside a temporary helper container based on the backend image, with
// the panel's data volume mounted at /staging and the target agent volume at
// /vol. Usage: node restore-volume.js <zipPath> <entryName> <targetDir>
// The tar is streamed from the zip into tar, so volumes of any size fit.
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { openExportZip } = require('./exportZip');

const [, , zipPath, entryName, targetDir] = process.argv;
if (!zipPath || !entryName || !targetDir) {
  console.error('usage: restore-volume.js <zipPath> <entryName> <targetDir>');
  process.exit(1);
}

(async () => {
  const zip = await openExportZip(zipPath);
  const entry = await zip.openStream(entryName);
  const tar = spawn('tar', ['xf', '-', '-C', targetDir], { stdio: ['pipe', 'inherit', 'inherit'] });
  const exited = new Promise((resolve, reject) => {
    tar.on('error', (err) => reject(new Error(`tar failed to start: ${err.message}`)));
    tar.on('exit', (code) => resolve(code ?? 1));
  });
  await pipeline(entry, tar.stdin);
  process.exit(await exited);
})().catch((err) => { console.error(err.message); process.exit(1); });

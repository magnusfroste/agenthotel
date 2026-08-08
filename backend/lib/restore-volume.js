// Extracts one tar entry from a service-export zip into a mounted volume.
// Runs inside a temporary helper container based on the backend image, with
// the panel's data volume mounted at /staging and the target agent volume at
// /vol. Usage: node restore-volume.js <zipPath> <entryName> <targetDir>
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');

const [, , zipPath, entryName, targetDir] = process.argv;
if (!zipPath || !entryName || !targetDir) {
  console.error('usage: restore-volume.js <zipPath> <entryName> <targetDir>');
  process.exit(1);
}

const zip = new AdmZip(zipPath);
const entry = zip.getEntry(entryName);
if (!entry) {
  console.error(`entry not found in zip: ${entryName}`);
  process.exit(1);
}

// readFile buffers the tar — acceptable for typical agent volumes (MBs);
// documented limitation for multi-GB volumes.
const tarData = zip.readFile(entry);
const tar = spawn('tar', ['xf', '-', '-C', targetDir], { stdio: ['pipe', 'inherit', 'inherit'] });
tar.on('error', (err) => { console.error('tar failed to start:', err.message); process.exit(1); });
tar.on('exit', (code) => process.exit(code ?? 1));
tar.stdin.end(tarData);

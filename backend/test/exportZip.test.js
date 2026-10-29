// The importer reads export zips as streams (lib/exportZip.js): adm-zip
// refused a 3.2 GB export because it read the whole file into one Buffer.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const archiver = require('archiver');
const { openExportZip } = require('../lib/exportZip');

async function makeZip(entries) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'exportzip-')), 'export.zip');
  const archive = archiver('zip', { zlib: { level: 1 } });
  const done = new Promise((resolve, reject) => {
    archive.on('error', reject);
    archive.pipe(fs.createWriteStream(file)).on('close', resolve);
  });
  for (const [name, data] of Object.entries(entries)) archive.append(data, { name });
  await archive.finalize();
  await done;
  return file;
}

test('an export zip lists its entries and reads them back', async () => {
  const tarBytes = Buffer.alloc(300_000, 7);
  const file = await makeZip({
    'agent.json': JSON.stringify({ app: 'agenthotel-agent', agent: { name: 'x' } }),
    'volumes/agenthotel-x-data.tar': tarBytes
  });
  const zip = await openExportZip(file);
  try {
    assert.deepStrictEqual(zip.names.sort(), ['agent.json', 'volumes/agenthotel-x-data.tar']);
    assert.strictEqual(JSON.parse(await zip.readText('agent.json')).app, 'agenthotel-agent');
    assert.strictEqual(await zip.readText('volumes/census.json'), null);
    const chunks = [];
    for await (const c of await zip.openStream('volumes/agenthotel-x-data.tar')) chunks.push(c);
    assert.ok(Buffer.concat(chunks).equals(tarBytes));
    await assert.rejects(zip.openStream('nope.tar'), /entry not found in zip: nope.tar/);
  } finally {
    zip.close();
  }
});

test('a file that is not a zip is refused', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'exportzip-')), 'not.zip');
  fs.writeFileSync(file, 'hello');
  await assert.rejects(openExportZip(file));
});

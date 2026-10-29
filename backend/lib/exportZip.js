// Reads a service-export zip without holding it in memory. adm-zip reads the
// whole file into one Buffer, and Node refuses a file over 2 GiB: a 3.2 GB
// export from agenthotel.froste.eu failed with "File size (3241345902) is
// greater than 2 GiB" (2026-10-29). Entries are read from disk as streams.
const yauzl = require('yauzl');

// Opens the zip and lists its entries. Returns { names, readText(name),
// openStream(name), close() }; readText resolves null for a missing entry.
function openExportZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err) return reject(err);
      const entries = new Map();
      zip.on('entry', (entry) => { entries.set(entry.fileName, entry); zip.readEntry(); });
      zip.on('error', reject);
      zip.on('end', () => {
        const openStream = (name) => new Promise((res, rej) => {
          const entry = entries.get(name);
          if (!entry) return rej(new Error(`entry not found in zip: ${name}`));
          zip.openReadStream(entry, (e, stream) => (e ? rej(e) : res(stream)));
        });
        resolve({
          names: [...entries.keys()],
          openStream,
          async readText(name) {
            if (!entries.has(name)) return null;
            const chunks = [];
            for await (const chunk of await openStream(name)) chunks.push(chunk);
            return Buffer.concat(chunks).toString('utf8');
          },
          close() { zip.close(); }
        });
      });
      zip.readEntry();
    });
  });
}

module.exports = { openExportZip };

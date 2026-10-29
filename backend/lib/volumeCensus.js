// A volume's census: how many files it holds and how many bytes they add up
// to. Every copy of a guest's volumes is checked against it (2026-10-29).
//
// Moving the Hermes agent "magnus" between hotels reported "3 volume(s)
// restored" while its 1.1 GB /opt/data arrived as one cache file and no
// state.db (lib/volumeTar.js has the cause). Nothing compared what left with
// what arrived, so a broken copy looked like a good one. Now the census is
// taken of the volume as it is copied, of the archive's own listing, and of
// the volume after it is unpacked, and a copy whose numbers differ is an
// error, not a success.
//
// The census runs in a helper container (busybox find, stat, tar and awk);
// what here builds and reads its output is pure and tested.

// Shell that prints "<files> <bytes>" for a directory. A file with several
// hard links is one file's bytes, as tar stores it once.
function directoryScript(dir) {
  return `cd ${quote(dir)} && find . -type f -exec stat -c '%i %s' {} + | awk '!seen[$1]++ {s+=$2} {n++} END {print n+0, s+0}'`;
}

// Shell that prints "<files> <bytes>" from an archive's listing: regular
// files carry their size; a hard link ('h') is a file whose bytes are stored
// with its first name.
function archiveScript(archive, { gzip = false } = {}) {
  return `tar t${gzip ? 'z' : ''}vf ${quote(archive)} | awk '$1 ~ /^-/ {n++; s+=$3} $1 ~ /^h/ {n++} END {print n+0, s+0}'`;
}

function quote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// "<files> <bytes>" (a TTY may add \r) → { files, bytes }, or null.
function parse(line) {
  const m = String(line || '').trim().match(/^(\d+)\s+(\d+)$/);
  return m ? { files: Number(m[1]), bytes: Number(m[2]) } : null;
}

// The last census line in a helper's output, which may carry other text.
function lastCensus(output) {
  const lines = String(output || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const c = parse(lines[i]);
    if (c) return c;
  }
  return null;
}

const same = (a, b) => Boolean(a && b && a.files === b.files && a.bytes === b.bytes);

function describe(c) {
  if (!c) return 'nothing readable';
  const mb = c.bytes / 1048576;
  return `${c.files} file(s), ${mb >= 1 ? `${mb.toFixed(1)} MB` : `${c.bytes} bytes`}`;
}

// Throws when a copy does not match what it was copied from.
function assertSame(volume, expected, got, where) {
  if (same(expected, got)) return;
  throw new Error(`The copy of volume ${volume} is incomplete ${where}: expected ${describe(expected)}, found ${describe(got)}.`);
}

module.exports = { directoryScript, archiveScript, parse, lastCensus, same, describe, assertSame };

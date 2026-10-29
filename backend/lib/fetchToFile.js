// Download a URL to a file, streamed, reporting progress — how a hotel pulls
// an agent another hotel has ticketed for it (lib/transfers.js). Streamed to
// disk so a gigabyte of agent memory never sits in the panel's heap.

const fs = require('fs');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

// Resolves to the number of bytes written. Rejects on an HTTP error (with the
// other hotel's own message when it sent JSON), a stall longer than
// idleTimeoutMs, or more than maxBytes.
async function fetchToFile(url, file, { fetch = require('node-fetch'), onProgress = () => {}, maxBytes = 50 * 1024 ** 3, idleTimeoutMs = 120000 } = {}) {
  const controller = new AbortController();
  let idle = setTimeout(() => controller.abort(), idleTimeoutMs);
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(), idleTimeoutMs); };
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/zip' } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = text.slice(0, 300);
      try { message = JSON.parse(text).error || message; } catch (_) { /* not JSON */ }
      const err = new Error(`The other hotel answered ${res.status}: ${message || res.statusText}`);
      err.status = res.status;
      throw err;
    }
    const total = parseInt(res.headers.get('content-length'), 10) || null;
    let bytes = 0;
    const counter = new Transform({
      transform(chunk, _enc, done) {
        bytes += chunk.length;
        touch();
        if (bytes > maxBytes) return done(new Error(`The transfer is larger than ${Math.round(maxBytes / 1024 ** 3)} GB`));
        onProgress(bytes, total);
        done(null, chunk);
      }
    });
    await pipeline(res.body, counter, fs.createWriteStream(file));
    return bytes;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`The transfer stalled for ${Math.round(idleTimeoutMs / 1000)} s and was stopped`);
    // node-fetch writes "failed, reason: <message>", and a failed connect to
    // every address of a name has an empty message: the code is all there is.
    if (err.code && !err.message.includes(err.code)) err.message = `${err.message.replace(/\s+$/, '')} ${err.code}`;
    throw err;
  } finally {
    clearTimeout(idle);
  }
}

module.exports = { fetchToFile };

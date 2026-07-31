// Demux docker's multiplexed stream format (used when a container/exec runs
// without a TTY). Each frame has an 8-byte header:
// [stream-type, 0, 0, 0, length(4 bytes BE)] followed by the payload.
// Returns a Buffer with the headers stripped; falls back to the raw buffer
// when the data doesn't look multiplexed.
function demuxDockerBuffer(raw) {
  try {
    if (raw.length > 7 && raw[1] === 0 && raw[2] === 0 && raw[3] === 0) {
      const out = [];
      let i = 0;
      while (i + 8 <= raw.length) {
        const len = raw.readUInt32BE(i + 4);
        if (i + 8 + len > raw.length) break;
        out.push(raw.slice(i + 8, i + 8 + len));
        i += 8 + len;
      }
      return Buffer.concat(out);
    }
  } catch (_) { /* fall back to raw */ }
  return raw;
}

module.exports = { demuxDockerBuffer };

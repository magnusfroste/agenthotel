// Moving an agent between hotels: one-time tickets (lib/transfers.js) and the
// streamed pull (lib/fetchToFile.js).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Database = require('better-sqlite3');
const transfers = require('../lib/transfers');
const { fetchToFile } = require('../lib/fetchToFile');

function fresh() {
  const db = new Database(':memory:');
  transfers.init(db);
  return db;
}

test('a ticket is spent by its first pull, and only the hash is stored', () => {
  const db = fresh();
  const { token, expiresAt } = transfers.issue(db, 'hermes-x-1', { includeData: true, stopOnPull: true, now: 1000 });
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.strictEqual(expiresAt, 1000 + transfers.TTL_MS);
  const row = db.prepare('SELECT * FROM transfers').get();
  assert.notStrictEqual(row.token_hash, token);
  assert.strictEqual(row.token_hash, transfers.hash(token));

  const first = transfers.claim(db, token, { by: '203.0.113.7', now: 2000 });
  assert.strictEqual(first.ticket.agent_id, 'hermes-x-1');
  assert.strictEqual(first.ticket.include_data, 1);
  assert.deepStrictEqual(transfers.claim(db, token, { now: 3000 }), { error: 'used' });
});

test('an expired, unknown or malformed ticket is refused', () => {
  const db = fresh();
  const { token } = transfers.issue(db, 'a', { ttlMs: 1000, now: 0 });
  assert.deepStrictEqual(transfers.claim(db, token, { now: 5000 }), { error: 'expired' });
  assert.deepStrictEqual(transfers.claim(db, 'f'.repeat(64)), { error: 'unknown' });
  assert.deepStrictEqual(transfers.claim(db, '../../etc/passwd'), { error: 'unknown' });
});

test('a transfer URL is built on the hotel address and checked before it is fetched', () => {
  const token = 'a'.repeat(64);
  const url = transfers.ticketUrl('https://hotel.example.com/', token);
  assert.strictEqual(url, `https://hotel.example.com/api/transfer/${token}`);
  assert.strictEqual(transfers.parseTicketUrl(` ${url} `), url);
  assert.throws(() => transfers.parseTicketUrl('file:///etc/passwd'), /http or https/);
  assert.throws(() => transfers.parseTicketUrl('https://hotel.example.com/api/agents'), /transfer URL/);
  assert.throws(() => transfers.parseTicketUrl(`https://u:p@hotel.example.com/api/transfer/${token}`), /credentials/);
  assert.throws(() => transfers.parseTicketUrl('not a url'), /Not a URL/);
});

function serve(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('a pull streams to disk with progress, and says why the other hotel refused', async () => {
  const body = Buffer.alloc(300 * 1024, 7);
  const { server, base } = await serve((req, res) => {
    if (req.url === '/ok') { res.writeHead(200, { 'Content-Length': body.length }); return res.end(body); }
    res.writeHead(410, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'This transfer ticket was already used — issue a new one' }));
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-'));
  try {
    const seen = [];
    const bytes = await fetchToFile(`${base}/ok`, path.join(dir, 'a.zip'), { onProgress: (b, t) => seen.push([b, t]) });
    assert.strictEqual(bytes, body.length);
    assert.strictEqual(fs.statSync(path.join(dir, 'a.zip')).size, body.length);
    assert.deepStrictEqual(seen[seen.length - 1], [body.length, body.length]);
    await assert.rejects(fetchToFile(`${base}/gone`, path.join(dir, 'b.zip')), /410: This transfer ticket was already used/);
    await assert.rejects(fetchToFile(`${base}/ok`, path.join(dir, 'c.zip'), { maxBytes: 1024 }), /larger than/);
  } finally {
    server.close();
  }
});

test('a pull that stalls is stopped', async () => {
  const { server, base } = await serve((req, res) => { res.writeHead(200); res.write('x'); /* and never more */ });
  try {
    await assert.rejects(
      fetchToFile(`${base}/`, path.join(os.tmpdir(), `stall-${process.pid}.zip`), { idleTimeoutMs: 300 }),
      /stalled/
    );
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

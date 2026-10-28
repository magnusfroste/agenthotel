// caddySet against a stand-in for Caddy's admin API, with Caddy's own rules for
// each method (checked against Caddy 2.11): POST to an array appends, PATCH
// needs the key to exist, PUT needs it not to. The panel POSTed the client
// address headers into an existing array, and Caddy refused the result on
// every boot — logged, never noticed, since caddy.json already held the value.
process.env.CADDY_ADMIN_SOCKET = '/nonexistent/admin.sock';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { caddySet } = require('../lib/caddyAdmin');

function fakeCaddy(config) {
  const methods = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      methods.push(req.method);
      const key = req.url.split('/').pop();
      const value = JSON.parse(body);
      const exists = key in config;
      if (req.method === 'PATCH' && !exists) { res.writeHead(404); return res.end(); }
      if (req.method === 'PUT' && exists) { res.writeHead(409); return res.end(); }
      if (req.method === 'POST' && Array.isArray(config[key])) config[key].push(value);
      else config[key] = value;
      res.writeHead(200);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ server, methods, url: `http://127.0.0.1:${server.address().port}/config/srv0` });
  }));
}

test('an existing array is replaced, not appended to', async () => {
  const config = { client_ip_headers: ['X-Forwarded-For'] };
  const caddy = await fakeCaddy(config);
  try {
    const res = await caddySet(`${caddy.url}/client_ip_headers`, ['X-Forwarded-For']);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(config.client_ip_headers, ['X-Forwarded-For']);
    assert.deepStrictEqual(caddy.methods, ['PATCH']);
  } finally { caddy.server.close(); }
});

test('a missing key is created', async () => {
  const config = {};
  const caddy = await fakeCaddy(config);
  try {
    const res = await caddySet(`${caddy.url}/trusted_proxies_strict`, 1);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(config.trusted_proxies_strict, 1);
    assert.deepStrictEqual(caddy.methods, ['PATCH', 'PUT']);
  } finally { caddy.server.close(); }
});

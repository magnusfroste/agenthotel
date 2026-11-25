// Whether a name reaches this hotel, asked before the deploy instead of found
// out after it.
//
// 2026-11-14: an agent running the hotel over MCP built a guest four times for
// a name that had no DNS record, and once for a mistyped zone. Both names were
// accepted, routed and reported "running, healthy"; nothing in the panel knew
// that nobody could reach them. A guest cannot check for itself either: it
// cannot fetch the hotel's public address from inside.
//
// Public DNS is asked directly, not the server's own resolver. The resolver
// remembers that a name did not exist: a record added a minute ago resolved
// everywhere except on the hotel for a quarter of an hour.

const dns = require('dns');
const https = require('https');
const net = require('net');
const crypto = require('crypto');

const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8'];

// Cloudflare's published edge ranges (cloudflare.com/ips). A proxied record
// resolves to one of these whatever its origin is, so DNS alone cannot say
// where such a name ends up.
const CLOUDFLARE = new net.BlockList();
for (const [prefix, bits] of [
  ['173.245.48.0', 20], ['103.21.244.0', 22], ['103.22.200.0', 22], ['103.31.4.0', 22],
  ['141.101.64.0', 18], ['108.162.192.0', 18], ['190.93.240.0', 20], ['188.114.96.0', 20],
  ['197.234.240.0', 22], ['198.41.128.0', 17], ['162.158.0.0', 15], ['104.16.0.0', 13],
  ['104.24.0.0', 14], ['172.64.0.0', 13], ['131.0.72.0', 22]
]) CLOUDFLARE.addSubnet(prefix, bits, 'ipv4');
for (const [prefix, bits] of [
  ['2400:cb00::', 32], ['2606:4700::', 32], ['2803:f800::', 32], ['2405:b500::', 32],
  ['2405:8100::', 32], ['2a06:98c0::', 29], ['2c0f:f248::', 32]
]) CLOUDFLARE.addSubnet(prefix, bits, 'ipv6');

function isCloudflare(address) {
  const family = net.isIPv6(address) ? 'ipv6' : net.isIPv4(address) ? 'ipv4' : null;
  return family ? CLOUDFLARE.check(address, family) : false;
}

// The name one level up: where a sibling of this guest would live.
function parentOf(domain) {
  const labels = String(domain || '').split('.');
  return labels.length > 2 ? labels.slice(1).join('.') : null;
}

const NO_SUCH_NAME = new Set(['ENOTFOUND', 'ENODATA']);

// `resolver` needs resolve4 and resolve6 (dns.promises.Resolver); `request`
// is the HTTPS probe. Both are injected in tests, which run without a network.
function createDomainCheck({ servers = PUBLIC_RESOLVERS, timeoutMs = 3000, resolver = null, request = null } = {}) {
  let made = resolver;
  const resolverNow = () => {
    if (!made) {
      made = new dns.promises.Resolver({ timeout: timeoutMs, tries: 1 });
      made.setServers(servers);
    }
    return made;
  };

  // { addresses, missing, error }: `missing` is DNS saying the name has no
  // address; `error` is DNS not answering, which says nothing about the name.
  async function lookup(name) {
    const out = { addresses: [], missing: false, error: null };
    const r = resolverNow();
    const answers = await Promise.allSettled([r.resolve4(name), r.resolve6(name)]);
    for (const a of answers) if (a.status === 'fulfilled') out.addresses.push(...a.value);
    if (out.addresses.length) return out;
    const codes = answers.map(a => (a.reason && a.reason.code) || 'unknown');
    if (codes.every(c => NO_SUCH_NAME.has(c))) out.missing = true;
    else out.error = codes.find(c => !NO_SUCH_NAME.has(c));
    return out;
  }

  // Where the name points, compared with the hotel: the names it answers on
  // itself (the panel's domain) and any address it is known to have. States:
  //   no-record  nothing to reach; a deploy would be unreachable
  //   here       shares an address with the hotel
  //   proxied    behind Cloudflare; the origin is not visible in DNS
  //   elsewhere  resolves, to addresses that are not the hotel's
  //   resolves   resolves, and the hotel's own address is not known to compare
  //   unknown    DNS did not answer
  async function check(name, { hotel = [], addresses = [] } = {}) {
    const [mine, ...theirs] = await Promise.all([lookup(name), ...hotel.filter(Boolean).map(lookup)]);
    const hotelDirect = [...new Set([...addresses.filter(Boolean), ...theirs.flatMap(t => t.addresses)])].filter(a => !isCloudflare(a));
    let state;
    if (mine.error) state = 'unknown';
    else if (mine.missing) state = 'no-record';
    else if (mine.addresses.some(isCloudflare)) state = 'proxied';
    else if (!hotelDirect.length) state = 'resolves';
    else state = mine.addresses.some(a => hotelDirect.includes(a)) ? 'here' : 'elsewhere';
    return { state, addresses: mine.addresses, hotelAddresses: hotelDirect, error: mine.error };
  }

  // A name nobody would create resolves only when the zone has a wildcard
  // record, and then every new name under it works without a DNS change.
  // true, false, or null when DNS did not answer.
  async function hasWildcard(parent) {
    if (!parent) return false;
    const found = await lookup(`ah-check-${crypto.randomBytes(5).toString('hex')}.${parent}`);
    if (found.error) return null;
    return found.addresses.length > 0;
  }

  // Whether the name is a zone of its own: it has NS records. Behind
  // Cloudflare's proxy that decides whether one level below it is covered by
  // the free certificate: guest.example.com is, guest.hotel.example.com is not
  // unless hotel.example.com is a zone. true, false, or null when DNS did not
  // answer.
  async function isZone(name) {
    const r = resolverNow();
    if (typeof r.resolveNs !== 'function') return null;
    try {
      return (await r.resolveNs(name)).length > 0;
    } catch (err) {
      return NO_SUCH_NAME.has(err && err.code) ? false : null;
    }
  }

  // What the name answers from outside, through the address public DNS gives:
  // { status } or { error }. The uptime probe asks the server's own resolver,
  // which is the one that lags behind a new record.
  function answers(name, address) {
    if (request) return request(name, address);
    return new Promise(resolve => {
      const family = net.isIPv6(address) ? 6 : 4;
      const req = https.request({
        host: name, servername: name, path: '/', method: 'GET', timeout: 8000,
        headers: { 'user-agent': 'AgentHotel/1.0 (domain check)' },
        lookup: (host, opts, cb) => (opts && opts.all ? cb(null, [{ address, family }]) : cb(null, address, family))
      }, res => { res.resume(); resolve({ status: res.statusCode }); });
      req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
      req.on('error', err => resolve({ error: err.code || err.message }));
      req.end();
    });
  }

  return { lookup, check, hasWildcard, isZone, answers };
}

module.exports = { createDomainCheck, isCloudflare, parentOf, PUBLIC_RESOLVERS };

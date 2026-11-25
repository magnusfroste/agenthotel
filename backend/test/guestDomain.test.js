// The hotel's domain for guests: a name typed on the form becomes a domain
// under it, and the Domains page says whether its wildcard record points here.
const { test } = require('node:test');
const assert = require('node:assert');
const g = require('../lib/guestDomain');

test('the setting is stored the way DNS writes it, without the wildcard', () => {
  assert.strictEqual(g.normalizeGuestDomain(' *.Hotel.Example.com. '), 'hotel.example.com');
  assert.strictEqual(g.normalizeGuestDomain(''), '');
  assert.strictEqual(g.normalizeGuestDomain(null), '');
  assert.strictEqual(g.guestDomainProblem(''), null);
  assert.strictEqual(g.guestDomainProblem('*.hotel.example.com'), null);
  assert.match(g.guestDomainProblem('https://hotel.example.com'), /address, not a domain/);
  assert.match(g.guestDomainProblem('hotel'), /needs a dot/);
});

test('a guest name becomes one label under the guest domain', () => {
  assert.strictEqual(g.suggestDomain('zeroclaw', 'hotel.example.com'), 'zeroclaw.hotel.example.com');
  assert.strictEqual(g.suggestDomain('My Agent_2', 'hotel.example.com'), 'my-agent-2.hotel.example.com');
  assert.strictEqual(g.suggestDomain('--x--', '*.hotel.example.com'), 'x.hotel.example.com');
  assert.strictEqual(g.nameLabel('a'.repeat(70)).length, 63);
  assert.strictEqual(g.suggestDomain('åäö', 'hotel.example.com'), '');
  assert.strictEqual(g.suggestDomain('zeroclaw', ''), '');
});

function fakeCheck(state, extra = {}, zone = false) {
  const asked = [];
  return {
    asked,
    isZone: async () => zone,
    check: async (name, opts) => { asked.push({ name, opts }); return { state, addresses: ['192.0.2.10'], hotelAddresses: ['192.0.2.10'], error: null, ...extra }; }
  };
}

test('the wildcard check asks for a name nobody would create under the domain', async () => {
  const dc = fakeCheck('here');
  const out = await g.checkGuestDomain('*.hotel.example.com', dc, { hotel: ['panel.example.com'], addresses: ['192.0.2.10'] });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.domain, 'hotel.example.com');
  assert.match(dc.asked[0].name, /^ah-check-[0-9a-f]{10}\.hotel\.example\.com$/);
  assert.deepStrictEqual(dc.asked[0].opts.hotel, ['panel.example.com']);
});

test('the wildcard check says what is wrong', async () => {
  const missing = await g.checkGuestDomain('hotel.example.com', fakeCheck('no-record', { addresses: [] }));
  assert.strictEqual(missing.ok, false);
  assert.match(missing.verdict, /Add \*\.hotel\.example\.com as an A record to 192\.0\.2\.10/);
  const proxied = await g.checkGuestDomain('hotel.example.com', fakeCheck('proxied'));
  assert.strictEqual(proxied.ok, null);
  assert.match(proxied.verdict, /DNS only/);
  const unset = await g.checkGuestDomain('', fakeCheck('here'));
  assert.strictEqual(unset.state, 'unset');
});

test('a proxied wildcard is fine when the guest domain is the zone itself', async () => {
  const apex = await g.checkGuestDomain('example.com', fakeCheck('proxied', {}, true));
  assert.strictEqual(apex.ok, true);
  assert.match(apex.verdict, /zone itself/);
  const deeper = await g.checkGuestDomain('hotel.example.com', fakeCheck('proxied', {}, false));
  assert.strictEqual(deeper.ok, null);
  assert.match(deeper.verdict, /DNS only/);
  const unknown = await g.checkGuestDomain('hotel.example.com', fakeCheck('proxied', {}, null));
  assert.strictEqual(unknown.ok, null);
});

test('a name with NS records is a zone; one without is not; no answer is unknown', async () => {
  const { createDomainCheck } = require('../lib/domainCheck');
  const fail = code => Object.assign(new Error(code), { code });
  const dc = createDomainCheck({ resolver: { resolveNs: async name => {
    if (name === 'example.com') return ['ns1.example.net'];
    if (name === 'hotel.example.com') throw fail('ENODATA');
    throw fail('ETIMEOUT');
  } } });
  assert.strictEqual(await dc.isZone('example.com'), true);
  assert.strictEqual(await dc.isZone('hotel.example.com'), false);
  assert.strictEqual(await dc.isZone('slow.example.org'), null);
});

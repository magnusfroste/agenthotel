// The secrets a template declares. These are the values that make a stack work
// or fail silently, and none of it is visible until a deploy is running.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { normalizeSecrets, generateSecrets, renderEnvFile } = require('../lib/templateSecrets');

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

test('a supabase JWT verifies against the secret generated beside it', () => {
  const secrets = normalizeSecrets([
    { key: 'ANON_KEY', generate: 'supabase-jwt', role: 'anon', signedWith: 'JWT_SECRET' },
    { key: 'JWT_SECRET', generate: 'hex', bytes: 32 },
  ]);
  const values = generateSecrets(secrets);
  const [header, payload, signature] = values.ANON_KEY.split('.');
  const expected = b64url(crypto.createHmac('sha256', values.JWT_SECRET).update(`${header}.${payload}`).digest());
  assert.strictEqual(signature, expected, 'signed with something other than JWT_SECRET');
  assert.strictEqual(JSON.parse(Buffer.from(payload, 'base64url')).role, 'anon');
});

test('a JWT is signed even when its secret is declared after it', () => {
  // Declaration order is the template author's business, not a constraint.
  const values = generateSecrets(normalizeSecrets([
    { key: 'SERVICE_ROLE_KEY', generate: 'supabase-jwt', role: 'service_role', signedWith: 'JWT_SECRET' },
    { key: 'JWT_SECRET', generate: 'password', length: 48 },
  ]));
  assert.ok(values.SERVICE_ROLE_KEY.split('.').length === 3);
});

test('a JWT with nothing to sign it is an error, not a broken stack', () => {
  assert.throws(
    () => generateSecrets(normalizeSecrets([{ key: 'ANON_KEY', generate: 'supabase-jwt', signedWith: 'MISSING' }])),
    /has no value/);
});

test('two deployments never share a secret', () => {
  const decl = normalizeSecrets([{ key: 'POSTGRES_PASSWORD', generate: 'password', length: 32 }]);
  assert.notStrictEqual(generateSecrets(decl).POSTGRES_PASSWORD, generateSecrets(decl).POSTGRES_PASSWORD);
});

test('what the operator supplied wins over generation', () => {
  const values = generateSecrets(normalizeSecrets([{ key: 'DASHBOARD_PASSWORD', generate: 'password' }]),
    { DASHBOARD_PASSWORD: 'chosen-by-hand' });
  assert.strictEqual(values.DASHBOARD_PASSWORD, 'chosen-by-hand');
});

test('generated passwords stay alphanumeric', () => {
  // Punctuation in a .env has broken more stacks than it has added entropy.
  const v = generateSecrets(normalizeSecrets([{ key: 'P', generate: 'password', length: 40 }]));
  assert.match(v.P, /^[A-Za-z0-9]{40}$/);
});

test('an unfilled placeholder stays visible rather than becoming empty', () => {
  const out = renderEnvFile('A=${KNOWN}\nB=${UNKNOWN}\n', { KNOWN: 'x' });
  assert.strictEqual(out, 'A=x\nB=${UNKNOWN}\n');
});

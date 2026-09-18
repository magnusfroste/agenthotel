// Secrets a template declares rather than ships.
//
// A stack like self-hosted Supabase cannot be deployed from placeholders: its
// anon and service-role keys are JWTs *signed with* the JWT secret in the same
// file, so a wrong triplet gives a stack that starts cleanly and then refuses
// every request. The template says which values are secret and how to make
// them; the panel makes them at deploy time. That keeps templates data — no
// template ever carries a real credential, and two deploys never share one.

const crypto = require('crypto');

const GENERATORS = ['hex', 'base64', 'password', 'supabase-jwt'];

// Ten years: these are infrastructure keys, rotated by redeploying, not by
// waiting for an expiry that would take the stack down unattended.
const JWT_LIFETIME_SECONDS = 10 * 365 * 24 * 60 * 60;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signHs256(payload, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const signature = b64url(crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${signature}`;
}

// Alphanumeric only. A generated password ends up in a .env that is read by
// shell, compose interpolation and a dozen clients; punctuation in it has
// broken more stacks than it has added entropy.
function password(length) {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length)) {
      if (byte < 256 - (256 % alphabet.length)) out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

function normalizeSecrets(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(s => s && typeof s === 'object' && typeof s.key === 'string' && s.key.trim())
    .map(s => ({
      key: s.key.trim(),
      generate: GENERATORS.includes(s.generate) ? s.generate : 'hex',
      bytes: Math.min(Math.max(parseInt(s.bytes) || 32, 8), 128),
      length: Math.min(Math.max(parseInt(s.length) || 24, 8), 128),
      role: typeof s.role === 'string' ? s.role.trim() : '',
      issuer: typeof s.issuer === 'string' ? s.issuer.trim() : 'supabase',
      signedWith: typeof s.signedWith === 'string' ? s.signedWith.trim() : ''
    }));
}

// Values the operator typed win: a deploy form that offers a field must be
// able to set it, and regenerating over the top would be silent data loss.
function generateSecrets(secrets, provided = {}) {
  const values = { ...provided };
  const jwts = [];

  for (const secret of secrets) {
    if (values[secret.key]) continue;
    if (secret.generate === 'supabase-jwt') { jwts.push(secret); continue; }
    values[secret.key] = secret.generate === 'base64' ? crypto.randomBytes(secret.bytes).toString('base64')
      : secret.generate === 'password' ? password(secret.length)
        : crypto.randomBytes(secret.bytes).toString('hex');
  }

  // Signed last, so the secret they are signed with exists whatever order the
  // template listed them in.
  for (const secret of jwts) {
    const signingKey = values[secret.signedWith];
    if (!signingKey) throw new Error(`${secret.key} is signed with ${secret.signedWith || '(nothing)'}, which has no value`);
    const iat = Math.floor(Date.now() / 1000);
    values[secret.key] = signHs256({
      role: secret.role || 'anon',
      iss: secret.issuer || 'supabase',
      iat,
      exp: iat + JWT_LIFETIME_SECONDS
    }, signingKey);
  }
  return values;
}

// ${KEY} in the template's env file becomes the generated or supplied value.
// A placeholder with no value is left exactly as written: a visible ${THING}
// in the environment editor is a far better failure than an empty string that
// looks deliberate.
function renderEnvFile(envFile, values) {
  if (typeof envFile !== 'string') return '';
  return envFile.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key) =>
    values[key] === undefined ? match : String(values[key]));
}

module.exports = { normalizeSecrets, generateSecrets, renderEnvFile, GENERATORS };

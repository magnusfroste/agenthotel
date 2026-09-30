// What a guest may have mounted from its host. The panel is root on the host;
// a guest with the Docker socket is too.
const { test } = require('node:test');
const assert = require('node:assert');
const { hostPathRefusal, assertSafeVolumes } = require('../lib/volumes');

test('the docker socket is refused, wherever it is', () => {
  assert.ok(hostPathRefusal('/var/run/docker.sock'));
  assert.ok(hostPathRefusal('/run/docker.sock'));
  assert.ok(hostPathRefusal('/srv/tmp/docker.sock'), 'a socket moved elsewhere is still a socket');
});

test("the host's control surfaces and the panel's own state are refused", () => {
  for (const p of ['/', '/etc', '/etc/shadow', '/proc/1', '/root/.ssh', '/var/lib/docker/volumes',
                   '/var/lib/agenthotel/checkouts', '/opt/agenthotel', '/usr/bin'])
    assert.ok(hostPathRefusal(p), `${p} must be refused`);
});

test('.. cannot walk back into a refused path', () => {
  assert.ok(hostPathRefusal('/srv/../etc'));
  assert.ok(hostPathRefusal('/srv/app/../../var/run/docker.sock'));
  assert.ok(hostPathRefusal('//etc'), 'a doubled slash is still /etc');
});

test('ordinary directories an app legitimately needs are allowed', () => {
  // The reason this field exists: a media library, a shared folder.
  for (const p of ['/srv/media', '/home/magnus/music', '/mnt/nas/photos', '/data-shared'])
    assert.strictEqual(hostPathRefusal(p), null, `${p} should be allowed`);
});

test('a prefix is a directory, not a string', () => {
  // /etcetera is not /etc; /runner is not /run.
  assert.strictEqual(hostPathRefusal('/etcetera'), null);
  assert.strictEqual(hostPathRefusal('/runner/cache'), null);
});

test('named volumes are not host paths and pass', () => {
  assert.strictEqual(hostPathRefusal('data'), null);
  assert.doesNotThrow(() => assertSafeVolumes(['data:/app/data', 'cache:/cache:ro']));
});

test('a refused volume names itself and says what to use instead', () => {
  assert.throws(() => assertSafeVolumes(['data:/data', '/var/run/docker.sock:/sock']),
    /\/var\/run\/docker\.sock:\/sock.*runtime socket.*named volume/s);
});

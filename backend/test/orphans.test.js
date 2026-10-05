// What deleted agents leave behind, and domains that move.
const { test } = require('node:test');
const assert = require('node:assert');
const { agentIdOfImageTag, orphanImageTags, orphanBuildDirs, withDomainChanged } = require('../lib/orphans');

test("the panel's own images are never an agent's", () => {
  assert.strictEqual(agentIdOfImageTag('agenthotel-backend:latest'), null);
  assert.strictEqual(agentIdOfImageTag('agenthotel-frontend:latest'), null);
  assert.strictEqual(agentIdOfImageTag('hermes-agenthotel:latest'), null);
  assert.strictEqual(agentIdOfImageTag('agenthotel-git-app-reel-studio-1790886075660:latest'), 'git-app-reel-studio-1790886075660');
});

test('an image or checkout is an orphan only when its agent is gone', () => {
  const tags = ['agenthotel-backend:latest', 'agenthotel-git-app-reelstudio-1788196975990:latest',
                'agenthotel-git-app-lobby-1788204261179:latest', 'caddy:2', 'supabase/postgres:17.6'];
  const live = ['git-app-lobby-1788204261179', 'hermes-hermes-1790885925000'];
  assert.deepStrictEqual(orphanImageTags(tags, live), ['agenthotel-git-app-reelstudio-1788196975990:latest']);
  const dirs = ['git-app-lobby-1788204261179', 'git-app-reelstudio-1788196975990', 'git-compose-skillhub-1789682072420', 'README', '.cache'];
  assert.deepStrictEqual(orphanBuildDirs(dirs, live), ['git-app-reelstudio-1788196975990', 'git-compose-skillhub-1789682072420']);
});

test('values derived from the old domain follow it to the new one', () => {
  const { config, changed } = withDomainChanged({
    REEL_PUBLIC_BASE_URL: 'https://reelstudio.froste.eu',
    LINKS: 'https://reelstudio.froste.eu/watch, https://other.example',
    REEL_API_TOKEN: 'abc',
  }, 'reelstudio.froste.eu', 'reel.froste.eu');
  assert.strictEqual(config.REEL_PUBLIC_BASE_URL, 'https://reel.froste.eu');
  assert.strictEqual(config.LINKS, 'https://reel.froste.eu/watch, https://other.example');
  assert.strictEqual(config.REEL_API_TOKEN, 'abc');
  assert.deepStrictEqual(changed.sort(), ['LINKS', 'REEL_PUBLIC_BASE_URL']);
});

test('only the whole hostname is replaced', () => {
  const { config, changed } = withDomainChanged({
    A: 'https://xreel.froste.eu', B: 'https://reel.froste.eu.evil.example', C: 'https://reel.froste.eu:8443/mcp',
  }, 'reel.froste.eu', 'video.froste.eu');
  assert.strictEqual(config.A, 'https://xreel.froste.eu');
  assert.strictEqual(config.B, 'https://reel.froste.eu.evil.example');
  assert.strictEqual(config.C, 'https://video.froste.eu:8443/mcp');
  assert.deepStrictEqual(changed, ['C']);
});

test('no domain before or after means nothing to carry over', () => {
  assert.deepStrictEqual(withDomainChanged({ A: 'x' }, null, 'a.example').changed, []);
  assert.deepStrictEqual(withDomainChanged({ A: 'x' }, 'a.example', '').changed, []);
});

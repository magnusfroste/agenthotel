// Which runtime a guest runs under, and refusing one Docker does not have.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  chosenRuntime, isolationOf, registeredRuntimes, runtimeProblem, assertRuntimeUsable,
} = require('../lib/containerRuntime');
const { appendUnknownEnv } = require('../lib/envPassthrough');

// The Runtimes this host's Docker reported on 2026-11-18, after gVisor was
// registered.
function fakeDocker(runtimes = ['io.containerd.runc.v2', 'runc', 'runsc'], defaultRuntime = 'runc') {
  return { info: async () => ({ Runtimes: Object.fromEntries(runtimes.map(n => [n, { path: n }])), DefaultRuntime: defaultRuntime }) };
}

test("a guest's own choice wins over the hotel's", () => {
  assert.deepStrictEqual(
    chosenRuntime({ CONTAINER_RUNTIME: 'runc' }, { setting: 'runsc', env: { DEFAULT_AGENT_RUNTIME: 'kata' } }),
    { name: 'runc', source: 'guest' });
});

test('without one the panel setting, then the environment, then Docker decides', () => {
  assert.deepStrictEqual(chosenRuntime({}, { setting: 'runsc', env: { DEFAULT_AGENT_RUNTIME: 'kata' } }), { name: 'runsc', source: 'setting' });
  assert.deepStrictEqual(chosenRuntime({}, { setting: '', env: { DEFAULT_AGENT_RUNTIME: 'kata' } }), { name: 'kata', source: 'env' });
  assert.deepStrictEqual(chosenRuntime({}, { setting: '', env: {} }), { name: '', source: 'docker' });
});

test('blank values are no choice at all', () => {
  assert.deepStrictEqual(chosenRuntime({ CONTAINER_RUNTIME: '  ' }, { setting: ' ', env: {} }), { name: '', source: 'docker' });
  assert.deepStrictEqual(chosenRuntime(null, { env: {} }), { name: '', source: 'docker' });
});

test('the isolation is described so an operator can choose by it', () => {
  assert.strictEqual(isolationOf('').kind, 'container');
  assert.strictEqual(isolationOf('runc').kind, 'container');
  assert.strictEqual(isolationOf('io.containerd.runc.v2').kind, 'container');
  assert.strictEqual(isolationOf('runsc').kind, 'gvisor');
  assert.strictEqual(isolationOf('kata-fc').kind, 'microvm');
  assert.strictEqual(isolationOf('io.containerd.kata.v2').kind, 'microvm');
  assert.strictEqual(isolationOf('crun').kind, 'other');
});

test("the runc shim alias is left out of the list, Docker's default is marked", async () => {
  const { runtimes, dockerDefault, names } = await registeredRuntimes(fakeDocker());
  assert.strictEqual(dockerDefault, 'runc');
  assert.deepStrictEqual(runtimes.map(r => r.name), ['runc', 'runsc']);
  assert.ok(runtimes.find(r => r.name === 'runc').isDockerDefault);
  assert.ok(names.includes('io.containerd.runc.v2'), 'every registered name is still known for checking');
});

test('a runtime Docker has is fine, and so is none', () => {
  assert.strictEqual(runtimeProblem('runsc', ['runc', 'runsc']), null);
  assert.strictEqual(runtimeProblem('', ['runc']), null);
});

test('one Docker lacks is refused, saying how to add it without stopping the hotel', () => {
  const problem = runtimeProblem('kata', ['runc', 'runsc']);
  assert.match(problem, /no runtime "kata"/);
  assert.match(problem, /registered: runc, runsc/);
  assert.match(problem, /systemctl reload docker/);
});

test('a name that is not a runtime name is refused before Docker is asked', () => {
  assert.match(runtimeProblem('runsc --debug', ['runsc']), /not a container runtime name/);
  assert.match(runtimeProblem('../runsc', ['runsc']), /not a container runtime name/);
});

test('the check throws a 400 the API can pass on', async () => {
  await assert.doesNotReject(assertRuntimeUsable(fakeDocker(), 'runsc'));
  await assert.doesNotReject(assertRuntimeUsable(fakeDocker(), ''));
  await assert.rejects(assertRuntimeUsable(fakeDocker(['runc']), 'runsc'), err => err.status === 400 && /no runtime "runsc"/.test(err.message));
});

test('the choice never reaches the guest as an environment variable', () => {
  const env = appendUnknownEnv([], { CONTAINER_RUNTIME: 'runsc', SOME_PROVIDER_KEY: 'x' }, []);
  assert.deepStrictEqual(env, ['SOME_PROVIDER_KEY=x']);
});

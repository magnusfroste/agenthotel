// Which container runtime a guest runs under.
//
// Every guest used to run under Docker's default, runc: an ordinary container
// that shares the host's kernel with every other guest. A guest is an agent
// that runs shell commands a language model decided on, so one kernel escape
// reaches the whole hotel. Docker can start a container under another
// registered runtime instead, and the image stays the same:
//
//   - gVisor (runsc) gives the guest a kernel of its own, written in Go, in
//     user space. It needs no hardware virtualisation, so it works on a VPS
//     that offers none (Contabo, 2026-11-18). It costs CPU on system calls:
//     an idle Hermes used 14 % of a core under runsc against 2 % under runc.
//   - Kata Containers or Firecracker give each guest a small VM with its own
//     kernel. They need /dev/kvm, so they belong on a host that has it.
//
// The choice is made per guest (CONTAINER_RUNTIME in its config), else for the
// whole hotel (the panel setting default_container_runtime, else the
// DEFAULT_AGENT_RUNTIME environment variable), else Docker's own default. A
// runtime Docker does not have registered is refused before anything is torn
// down: a guest asked to run isolated must not quietly run without it, and it
// must not be left stopped either.

const CONFIG_KEY = 'CONTAINER_RUNTIME';
const SETTING_KEY = 'default_container_runtime';
const ENV_KEY = 'DEFAULT_AGENT_RUNTIME';

// Docker's own names: letters, digits and . _ - (a containerd shim name such
// as io.containerd.runsc.v1 included).
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// The runtime a guest is to run under, and where that choice came from. An
// empty name means Docker's default.
function chosenRuntime(config, { setting = '', env = process.env } = {}) {
  const own = clean(config && config[CONFIG_KEY]);
  if (own) return { name: own, source: 'guest' };
  const hotel = clean(setting);
  if (hotel) return { name: hotel, source: 'setting' };
  const fromEnv = clean(env && env[ENV_KEY]);
  if (fromEnv) return { name: fromEnv, source: 'env' };
  return { name: '', source: 'docker' };
}

// What a runtime does to isolate a guest, in words an operator can choose by.
function isolationOf(name) {
  const n = clean(name).toLowerCase();
  if (!n || n === 'runc' || n.startsWith('io.containerd.runc')) {
    return { kind: 'container', label: 'Container: shares the host kernel with every other guest' };
  }
  if (n.includes('runsc') || n.includes('gvisor')) {
    return { kind: 'gvisor', label: 'gVisor: its own kernel in user space, no KVM needed; system calls cost more CPU' };
  }
  if (n.includes('kata') || n.includes('firecracker') || n.includes('clh') || n.includes('qemu')) {
    return { kind: 'microvm', label: 'MicroVM: its own kernel in a small virtual machine; needs KVM on the host' };
  }
  return { kind: 'other', label: 'A runtime registered in Docker on this host' };
}

// The runtimes Docker on this host can start a container under. The runc shim
// alias (io.containerd.runc.v2) is the same as runc and only clutters a list.
async function registeredRuntimes(docker) {
  const info = await docker.info();
  const names = Object.keys((info && info.Runtimes) || {}).sort();
  const dockerDefault = (info && info.DefaultRuntime) || 'runc';
  return {
    dockerDefault,
    names,
    runtimes: names
      .filter(name => name === dockerDefault || !/^io\.containerd\.runc\./.test(name))
      .map(name => ({ name, isDockerDefault: name === dockerDefault, isolation: isolationOf(name) })),
  };
}

// What is wrong with running under this runtime here, or null.
function runtimeProblem(name, registered) {
  const n = clean(name);
  if (!n) return null;
  if (!NAME.test(n)) return `"${n}" is not a container runtime name.`;
  if (!registered.includes(n)) {
    return `Docker on this host has no runtime "${n}" (registered: ${registered.join(', ') || 'none'}). ` +
      'Install it, add it under "runtimes" in /etc/docker/daemon.json and run "systemctl reload docker", ' +
      'which reloads the list without stopping any container.';
  }
  return null;
}

// Throws a 400 when the runtime cannot be used here. Called before a guest is
// torn down for a redeploy, and again when its container is made.
async function assertRuntimeUsable(docker, name) {
  if (!clean(name)) return;
  const { names } = await registeredRuntimes(docker);
  const problem = runtimeProblem(name, names);
  if (problem) {
    const err = new Error(problem);
    err.status = 400;
    throw err;
  }
}

module.exports = {
  CONFIG_KEY, SETTING_KEY, ENV_KEY,
  chosenRuntime, isolationOf, registeredRuntimes, runtimeProblem, assertRuntimeUsable,
};

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { checkout } = require('../lib/gitCheckout');

// A compose stack that lives in a repository.
//
// The existing Compose runtime takes the YAML as text, which is enough for a
// stack that only names images. It is not enough for one that mounts its own
// files — SkillHub's compose bind-mounts a dozen: kong.yml, the SQL that seeds
// the store, the MCP server's source. Pasted as text, every one of those paths
// points at nothing. So this runtime checks the repository out and runs compose
// inside it.

function projectName(id, config) {
  const name = config?.COMPOSE_PROJECT || `agenthotel-${id}`;
  // Interpolated into a shell command; keep it to what a project name may hold.
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid COMPOSE_PROJECT "${name}": letters, digits, underscores and hyphens only`);
  }
  return name;
}

function composeFile(dir, config) {
  const rel = (config?.COMPOSE_FILE || 'docker-compose.yml').trim();
  const resolved = path.resolve(dir, rel);
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
    throw new Error('COMPOSE_FILE must stay inside the repository');
  }
  if (!fs.existsSync(resolved)) throw new Error(`No ${rel} in the repository`);
  return resolved;
}

function compose(args, cwd, envFile) {
  const base = ['compose', ...(envFile ? ['--env-file', envFile] : []), ...args];
  try {
    return execFileSync('docker', base, { cwd, stdio: 'pipe', timeout: 900000 }).toString();
  } catch (err) {
    const detail = (err.stderr || err.stdout || '').toString().trim() || err.message;
    throw new Error(detail.split('\n').slice(-6).join('\n'));
  }
}

// Create the external networks a stack declares but does not own.
//
// A compose file written for another platform names that platform's shared
// network — SkillHub declares `easypanel`, which is where that panel's proxy
// lives. Under AgentHotel nothing has created it, and compose refuses to start
// with "declared as external, but could not be found". Creating it is enough:
// the stack only needs something to attach to, and the panel reaches the guest
// by joining the routed container to its own network anyway.
function ensureExternalNetworks(file) {
  const text = fs.readFileSync(file, 'utf8');
  // Only the top-level networks: block, and only entries marked external.
  const block = /\nnetworks:\n([\s\S]*?)(?=\n[a-z_]+:\n|$)/.exec('\n' + text);
  if (!block) return [];
  const created = [];
  const re = /^ {2}([A-Za-z0-9_.-]+):\s*$\n((?:^ {4}.*$\n?)*)/gm;
  let m;
  while ((m = re.exec(block[1]))) {
    const [, name, body] = m;
    if (!/external:\s*true/.test(body)) continue;
    const named = /name:\s*([A-Za-z0-9_.-]+)/.exec(body);
    const actual = named ? named[1] : name;
    try {
      execFileSync('docker', ['network', 'inspect', actual], { stdio: 'pipe', timeout: 30000 });
    } catch (e) {
      execFileSync('docker', ['network', 'create', actual], { stdio: 'pipe', timeout: 60000 });
      created.push(actual);
    }
  }
  return created;
}

module.exports = {
  name: 'Git Compose',
  // The stack runs its own containers; the panel neither creates nor
  // inspects one container for this guest.
  composeManaged: true,
  description: 'Run a docker-compose stack straight from its Git repository',
  defaultImage: 'compose',
  defaultPort: 8000,
  // Hosts arbitrary stacks, so it is not handed provider credentials unless
  // the guest opts in with INJECT_PROVIDER_ENV.
  providerCredentials: 'optional',
  configFields: [
    { key: 'GIT_REPO', label: 'Repository URL', type: 'text', required: true },
    { key: 'GIT_REF', label: 'Branch, tag or commit', type: 'text', default: 'main' },
    { key: 'GIT_SUBDIR', label: 'Subdirectory holding the stack', type: 'text', required: false },
    { key: 'COMPOSE_FILE', label: 'Compose file (relative to the repo)', type: 'text', default: 'docker-compose.yml' },
    { key: 'COMPOSE_PROJECT', label: 'Compose project name', type: 'text', required: false },
    { key: 'COMPOSE_ENV', label: 'Environment (.env contents)', type: 'textarea', required: false },
    // A stack like this publishes no host ports: the panel must be told which
    // service answers, or there is nothing for the domain to point at.
    { key: 'ROUTE_SERVICE', label: 'Service the domain routes to', type: 'text', required: false },
    { key: 'ROUTE_PORT', label: 'Port on that service', type: 'number', default: 8000 },
    { key: 'INJECT_PROVIDER_ENV', label: 'Inject provider API keys (true/false)', type: 'text', required: false }
  ],

  buildConfig({ config }) { return { ...config }; },
  buildEnv() { return []; },

  // What this guest is running, read from the checkout rather than remembered.
  describeSource(id, config) {
    const { CHECKOUT_ROOT } = require('../lib/gitCheckout');
    const repoDir = path.join(CHECKOUT_ROOT, id);
    const source = {
      repo: config.GIT_REPO || null,
      ref: config.GIT_REF || 'main',
      subdir: config.GIT_SUBDIR || null,
      dockerfile: (config.COMPOSE_FILE || 'docker-compose.yml').trim(),
      image: `compose project ${config.COMPOSE_PROJECT || `agenthotel-${id}`}`,
      commit: null, subject: null, committedAt: null,
      checkedOut: fs.existsSync(path.join(repoDir, '.git'))
    };
    if (!source.checkedOut) return source;
    try {
      const out = execFileSync('git', ['log', '-1', '--format=%h%x00%s%x00%cI'], { cwd: repoDir, timeout: 10000 })
        .toString().trim().split('\0');
      [source.commit, source.subject, source.committedAt] = out;
    } catch (e) { /* a checkout mid-clone has no HEAD yet */ }
    return source;
  },

  // Which container the domain should reach. A stack like SkillHub publishes
  // no host ports — Kong answers inside the stack's own network — so the panel
  // has to be told which service to point at, and then be let into that
  // network. Without this a compose guest can have a domain and nothing
  // listening behind it.
  routeTarget(id, config) {
    const service = (config.ROUTE_SERVICE || '').trim();
    if (!service) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(service)) throw new Error(`Invalid ROUTE_SERVICE "${service}"`);
    const { CHECKOUT_ROOT } = require('../lib/gitCheckout');
    const dir = path.join(CHECKOUT_ROOT, id);
    const file = composeFile(dir, config);
    const out = execFileSync('docker',
      ['compose', '-p', projectName(id, config), '-f', file, 'ps', '-q', service],
      { cwd: dir, stdio: 'pipe', timeout: 60000 }).toString().trim().split('\n').filter(Boolean);
    if (!out.length) throw new Error(`Service "${service}" is not running`);
    const name = execFileSync('docker', ['inspect', '-f', '{{.Name}}', out[0]],
      { stdio: 'pipe', timeout: 30000 }).toString().trim().replace(/^\//, '');
    return { container: name, port: parseInt(config.ROUTE_PORT) || 8000 };
  },

  async deploy(id, name, config) {
    const co = checkout(id, config);
    const file = composeFile(co.dir, config);
    const project = projectName(id, config);

    // The .env goes beside the compose file, where compose looks for it, and
    // is written with the checkout so a redeploy cannot leave a stale one.
    let envFile = null;
    if (config.COMPOSE_ENV) {
      envFile = path.join(co.dir, '.env');
      fs.writeFileSync(envFile, config.COMPOSE_ENV, { mode: 0o600 });
    }

    const madeNetworks = ensureExternalNetworks(file);
    if (madeNetworks.length) console.log(`[Git Compose] Created external network(s): ${madeNetworks.join(', ')}`);

    compose(['-p', project, '-f', file, 'up', '-d', '--remove-orphans'], co.dir, envFile);
    return { success: true, commit: co.commit };
  },

  async stop(id, config) {
    try {
      const { CHECKOUT_ROOT } = require('../lib/gitCheckout');
      const dir = path.join(CHECKOUT_ROOT, id);
      const file = composeFile(dir, config);
      compose(['-p', projectName(id, config), '-f', file, 'stop'], dir,
        fs.existsSync(path.join(dir, '.env')) ? path.join(dir, '.env') : null);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  async remove(id, config) {
    const { CHECKOUT_ROOT } = require('../lib/gitCheckout');
    const dir = path.join(CHECKOUT_ROOT, id);
    try {
      const file = composeFile(dir, config);
      compose(['-p', projectName(id, config), '-f', file, 'down', '--volumes', '--remove-orphans'], dir,
        fs.existsSync(path.join(dir, '.env')) ? path.join(dir, '.env') : null);
    } catch (err) { /* a stack that never came up has nothing to tear down */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    return { success: true };
  }
};

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { normalizeSecrets, generateSecrets, renderEnvFile } = require('./templateSecrets');

// templates/ is bind-mounted read-only-ish at /templates (docker-compose.yml).
const TEMPLATES_DIR = process.env.TEMPLATES_DIR || '/templates';

// The runtime plugins are the deployable set, so they drive the template list.
// meta.yaml only enriches a runtime with presentation metadata; a runtime
// without one still shows up, just with plugin name/description and defaults.
// Config is NOT read from meta.yaml — plugin.configFields is the single source
// of truth, so the library can never offer a field the deploy path ignores.
const DEFAULTS = {
  hermes: { category: 'AI Agent', icon: 'zap', color: '#3b82f6' },
  openclaw: { category: 'AI Agent', icon: 'paw', color: '#10b981' },
  odysseus: { category: 'AI Agent', icon: 'bot', color: '#8b5cf6' },
  'docker-app': { category: 'Docker App', icon: 'container', color: '#f59e0b' },
  compose: { category: 'Docker Compose', icon: 'layers', color: '#ec4899' }
};

// Admin- and agent-authored templates live apart from the shipped ones. They
// are pure DATA — an image or a compose file plus env fields and presentation —
// and deploy through an existing runtime, so none of this introduces code that
// the backend executes. That distinction is the whole security model here:
// plugins are code and stay files in git; templates are data and can be
// written at runtime.
//
// A separate directory rather than templates/<id> because the upgrade path runs
// `git pull`: untracked files alongside tracked ones survive, but would collide
// the day a shipped template takes the same name. This one is gitignored.
const CUSTOM_DIR = path.join(TEMPLATES_DIR, 'custom');

// Ids become directory names and URL segments, so keep them boring.
const ID_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

// Parsed meta.yaml per runtime, invalidated on mtime change so editing a
// template on the host shows up without restarting the backend.
const cache = new Map();

// A data template — one with a deploy block rather than a runtime plugin —
// can be shipped in git alongside the runtimes, or written at runtime into
// custom/. Both are equally inert data; the only difference is who wrote it,
// and a runtime-written one shadows a shipped one of the same name never: the
// shipped tree is checked only when custom/ has nothing.
function metaPath(id, custom) {
  if (!custom) return path.join(TEMPLATES_DIR, id, 'meta.yaml');
  const written = path.join(CUSTOM_DIR, id, 'meta.yaml');
  if (fs.existsSync(written)) return written;
  return path.join(TEMPLATES_DIR, id, 'meta.yaml');
}

function loadMeta(id, custom = false) {
  const file = metaPath(id, custom);
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch (_) {
    return null; // no meta.yaml for this runtime
  }

  const key = custom ? 'custom:' + id : id;
  const hit = cache.get(key);
  if (hit && hit.mtimeMs === mtimeMs) return hit.meta;

  let meta = null;
  try {
    meta = yaml.load(fs.readFileSync(file, 'utf8')) || null;
    if (meta && typeof meta !== 'object') meta = null;
  } catch (err) {
    // A malformed template must not take the library down — log and fall back
    // to the plugin's own metadata.
    console.error(`[Templates] Failed to parse ${file}: ${err.message}`);
    meta = null;
  }

  cache.set(key, { mtimeMs, meta });
  return meta;
}

// Block scalars in meta.yaml keep trailing newlines; trim so the UI controls
// its own spacing.
function text(value) {
  return typeof value === 'string' ? value.trim() : undefined;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function summarize(id, plugin) {
  const meta = loadMeta(id) || {};
  const defaults = DEFAULTS[id] || {};
  return {
    id,
    name: text(meta.name) || plugin.name || id,
    description: text(meta.description) || plugin.description || '',
    category: text(meta.category) || defaults.category || 'Other',
    icon: text(meta.icon) || defaults.icon || 'container',
    // Path to the runtime's real logo, served from the frontend's public dir.
    // Optional: the icon above stays the fallback for runtimes without one.
    logo: text(meta.logo) || null,
    color: text(meta.color) || defaults.color || '#3b82f6',
    tags: list(meta.tags).filter(t => typeof t === 'string'),
    defaultImage: plugin.defaultImage || '',
    defaultPort: plugin.defaultPort,
    configFieldCount: (plugin.configFields || []).length,
    hasMeta: Boolean(loadMeta(id))
  };
}

// A custom template carries its own deploy recipe instead of being backed by a
// plugin. `deploy.runtime` names the EXISTING runtime that performs the work —
// docker-app for a single image, compose for a stack — so nothing here can
// deploy in a way the panel could not already.
function normalizeDeploy(deploy) {
  if (!deploy || typeof deploy !== 'object') return null;
  const runtime = text(deploy.runtime);
  if (runtime !== 'docker-app' && runtime !== 'compose' && runtime !== 'git-compose') return null;

  const env = list(deploy.env)
    .filter(f => f && typeof f === 'object' && text(f.key))
    .map(f => ({
      key: text(f.key),
      label: text(f.label) || text(f.key),
      type: ['text', 'password', 'number', 'textarea'].includes(text(f.type)) ? text(f.type) : 'text',
      required: Boolean(f.required),
      default: f.default === undefined ? '' : String(f.default),
      description: text(f.description) || ''
    }));

  if (runtime === 'compose') {
    const compose = text(deploy.compose);
    if (!compose) return null;
    return { runtime, compose, env };
  }

  // A stack whose compose file bind-mounts files from its own repository —
  // init scripts, a gateway config, edge functions — cannot be carried as
  // compose text. Embedding just the file deploys a stack whose database
  // cannot initialise. Such a template has to bring the repository.
  if (runtime === 'git-compose') {
    const repo = text(deploy.repo);
    if (!repo) return null;
    return {
      runtime,
      repo,
      ref: text(deploy.ref) || 'main',
      subdir: text(deploy.subdir) || '',
      composeFile: text(deploy.composeFile) || 'docker-compose.yml',
      composeProject: text(deploy.composeProject) || '',
      routeService: text(deploy.routeService) || '',
      routePort: parseInt(deploy.routePort) || 0,
      // The .env the stack is handed, with ${PLACEHOLDER} for anything
      // generated or asked for on the deploy form.
      envFile: typeof deploy.envFile === 'string' ? deploy.envFile : '',
      secrets: normalizeSecrets(deploy.secrets),
      env
    };
  }
  const image = text(deploy.image);
  if (!image) return null;
  return { runtime, image, port: parseInt(deploy.port) || 80, env };
}

// Turn a template's deploy block into the runtime and config that
// POST /api/agents would otherwise have been handed by a human. This is the
// whole of what deploying a data template means — the panel runs no template
// code, it just fills in the same form.
function materializeDeploy(deploy, provided = {}) {
  const supplied = {};
  for (const [key, value] of Object.entries(provided || {})) {
    if (value !== undefined && value !== null && String(value) !== '') supplied[key] = String(value);
  }

  // What the panel knows about this particular deployment. It is there to be
  // substituted into the env file, not to become configuration of its own —
  // without this every template-deployed container got an AGENT_NAME variable
  // nobody asked for.
  const context = {};
  for (const key of ['DOMAIN', 'AGENT_NAME']) {
    if (supplied[key] !== undefined) { context[key] = supplied[key]; delete supplied[key]; }
  }

  if (deploy.runtime === 'docker-app') {
    // image and port are columns on the agent, not just config: the container
    // is created from the column. A template that set only the config field
    // deployed an agent with an empty image — "no command specified", from
    // Docker, long after the template looked fine.
    return {
      runtime: 'docker-app',
      image: deploy.image,
      port: deploy.port || 80,
      config: { IMAGE: deploy.image, PORT: String(deploy.port || 80), ...supplied }
    };
  }
  if (deploy.runtime === 'compose') {
    return { runtime: 'compose', config: { COMPOSE_FILE: deploy.compose, ...supplied } };
  }

  // A field's default is what the form shows; leaving it untouched must mean
  // the default, not an unfilled ${PLACEHOLDER} in the deployed .env.
  for (const field of deploy.env || []) {
    if (supplied[field.key] === undefined && field.default !== '') supplied[field.key] = String(field.default);
  }

  const values = { ...generateSecrets(deploy.secrets || [], supplied), ...context };
  const config = {
    GIT_REPO: deploy.repo,
    GIT_REF: deploy.ref,
    COMPOSE_FILE: deploy.composeFile
  };
  if (deploy.subdir) config.GIT_SUBDIR = deploy.subdir;
  if (deploy.composeProject) config.COMPOSE_PROJECT = deploy.composeProject;
  if (deploy.routeService) config.ROUTE_SERVICE = deploy.routeService;
  if (deploy.routePort) config.ROUTE_PORT = String(deploy.routePort);
  if (deploy.envFile) config.COMPOSE_ENV = renderEnvFile(deploy.envFile, values);

  // Anything the operator typed that the env file did not consume is still
  // theirs — a field offered on the form must end up somewhere.
  for (const field of deploy.env || []) {
    if (supplied[field.key] !== undefined && !(config.COMPOSE_ENV || '').includes(`${field.key}=`)) {
      config[field.key] = supplied[field.key];
    }
  }
  return { runtime: 'git-compose', config };
}

function summarizeCustom(id) {
  const meta = loadMeta(id, true) || {};
  const deploy = normalizeDeploy(meta.deploy);
  return {
    id,
    name: text(meta.name) || id,
    description: text(meta.description) || '',
    category: text(meta.category) || 'Custom',
    icon: text(meta.icon) || 'boxes',
    logo: text(meta.logo) || null,
    color: text(meta.color) || '#64748b',
    tags: list(meta.tags).filter(t => typeof t === 'string'),
    defaultImage: (deploy && deploy.image) || (deploy ? 'compose' : ''),
    defaultPort: (deploy && deploy.port) || null,
    configFieldCount: deploy ? deploy.env.length : 0,
    hasMeta: true,
    // Provenance. Not a security boundary — the data is equally inert whoever
    // wrote it — but an operator should see at a glance whether a template
    // shipped with the panel or was written by an agent last Tuesday.
    source: text(meta.source) || 'custom',
    custom: true,
    deployRuntime: deploy ? deploy.runtime : null,
    // A template whose deploy block does not parse is listed but not
    // deployable, rather than vanishing with no explanation.
    usable: Boolean(deploy)
  };
}

function dirsWithMeta(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(e => e.isDirectory() && ID_RE.test(e.name))
      .map(e => e.name)
      .filter(id => fs.existsSync(path.join(root, id, 'meta.yaml')));
  } catch (_) {
    return []; // directory does not exist yet
  }
}

// Every data template, written or shipped. A shipped directory only counts as
// one if it declares a deploy block — the rest are the runtimes' own
// presentation metadata, which the plugin list already covers.
function listCustomIds() {
  const written = dirsWithMeta(CUSTOM_DIR);
  const shipped = dirsWithMeta(TEMPLATES_DIR)
    .filter(id => !written.includes(id))
    .filter(id => {
      const meta = loadMeta(id);
      return Boolean(meta && meta.deploy);
    });
  return [...written, ...shipped];
}

function listTemplates(runtimes) {
  const builtin = Object.entries(runtimes).map(([id, plugin]) => ({
    ...summarize(id, plugin), source: 'builtin', custom: false, usable: true
  }));
  // Shipped templates win a name collision: a custom one can never shadow a
  // runtime and silently change what deploying it means.
  const taken = new Set(builtin.map(t => t.id));
  const custom = listCustomIds().filter(id => !taken.has(id)).map(summarizeCustom);
  return [...builtin, ...custom];
}

function getTemplate(id, runtimes) {
  const plugin = runtimes[id];
  if (!plugin) {
    if (!ID_RE.test(id) || !fs.existsSync(metaPath(id, true))) return null;
    // Shipped data templates are cached under the plugin key, written ones
    // under custom: — loadMeta is told which by where the file was found.

    const meta = loadMeta(id, true) || {};
    const deploy = normalizeDeploy(meta.deploy);
    return {
      ...summarizeCustom(id),
      instructions: text(meta.instructions) || '',
      benefits: list(meta.benefits),
      features: list(meta.features),
      links: list(meta.links),
      changeLog: list(meta.changeLog),
      configFields: deploy ? deploy.env : [],
      deploy
    };
  }
  const meta = loadMeta(id) || {};
  return {
    ...summarize(id, plugin),
    instructions: text(meta.instructions) || '',
    benefits: list(meta.benefits),
    features: list(meta.features),
    links: list(meta.links),
    changeLog: list(meta.changeLog),
    // The deploy form renders these, so ship the plugin's fields verbatim.
    configFields: plugin.configFields || []
  };
}

// One writer for both entry points — the REST form and the MCP tool must not
// drift into accepting different things. Rejects anything that would not
// deploy, so a template can never be created in a state that only fails later.
function saveTemplate(spec, runtimes, source = 'custom') {
  const id = text(spec && spec.id);
  if (!id || !ID_RE.test(id)) {
    throw new Error('id must be 3-40 chars, lowercase letters, digits and hyphens');
  }
  if (runtimes && runtimes[id]) {
    throw new Error(`"${id}" is a built-in runtime — pick another id`);
  }
  const name = text(spec.name);
  if (!name) throw new Error('name is required');

  const deploy = normalizeDeploy(spec.deploy);
  if (!deploy) {
    throw new Error('deploy must set runtime to "docker-app" (with image) or "compose" (with compose)');
  }

  const doc = {
    name,
    category: text(spec.category) || 'Custom',
    icon: text(spec.icon) || 'boxes',
    color: text(spec.color) || '#64748b',
    source,
    description: text(spec.description) || '',
    instructions: text(spec.instructions) || '',
    tags: list(spec.tags).filter(t => typeof t === 'string'),
    links: list(spec.links).filter(l => l && text(l.url)).map(l => ({ label: text(l.label) || text(l.url), url: text(l.url) })),
    deploy
  };

  const dir = path.join(CUSTOM_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  // lineWidth -1 keeps compose files and long descriptions from being wrapped
  // into something that no longer round-trips.
  fs.writeFileSync(path.join(dir, 'meta.yaml'), yaml.dump(doc, { lineWidth: -1 }), 'utf8');
  cache.delete('custom:' + id);
  return id;
}

function deleteTemplate(id) {
  if (!ID_RE.test(id)) throw new Error('Invalid template id');
  const dir = path.join(CUSTOM_DIR, id);
  if (!fs.existsSync(path.join(dir, 'meta.yaml'))) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  cache.delete('custom:' + id);
  return true;
}

module.exports = {
  listTemplates, getTemplate, saveTemplate, deleteTemplate,
  normalizeDeploy, materializeDeploy, ID_RE, CUSTOM_DIR, metaPath
};

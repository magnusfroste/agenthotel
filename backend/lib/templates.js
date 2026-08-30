const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

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

function metaPath(id, custom) {
  return custom
    ? path.join(CUSTOM_DIR, id, 'meta.yaml')
    : path.join(TEMPLATES_DIR, id, 'meta.yaml');
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
  if (runtime !== 'docker-app' && runtime !== 'compose') return null;

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
  const image = text(deploy.image);
  if (!image) return null;
  return { runtime, image, port: parseInt(deploy.port) || 80, env };
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

function listCustomIds() {
  try {
    return fs.readdirSync(CUSTOM_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory() && ID_RE.test(e.name))
      .map(e => e.name)
      .filter(id => fs.existsSync(metaPath(id, true)));
  } catch (_) {
    return []; // directory does not exist yet
  }
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
  normalizeDeploy, ID_RE, CUSTOM_DIR, metaPath
};

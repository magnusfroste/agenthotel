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

// Parsed meta.yaml per runtime, invalidated on mtime change so editing a
// template on the host shows up without restarting the backend.
const cache = new Map();

function loadMeta(id) {
  const file = path.join(TEMPLATES_DIR, id, 'meta.yaml');
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch (_) {
    return null; // no meta.yaml for this runtime
  }

  const hit = cache.get(id);
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

  cache.set(id, { mtimeMs, meta });
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

function listTemplates(runtimes) {
  return Object.entries(runtimes).map(([id, plugin]) => summarize(id, plugin));
}

function getTemplate(id, runtimes) {
  const plugin = runtimes[id];
  if (!plugin) return null;
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

module.exports = { listTemplates, getTemplate };

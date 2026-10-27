// Which template a guest was deployed from, so the sidebar and the Fleet can
// say "Take" or "Reports" rather than "git-app" (2026-10-27). A template is a
// recipe on top of a runtime, and the agent row only ever recorded the
// runtime. New deploys record the template id; guests deployed before that are
// matched once, by the repository or image their config names.

// "https://GitHub.com/x/Repo.git/" and "https://github.com/x/repo" are one repo.
function normalizeRepo(url) {
  return String(url || '').trim().toLowerCase()
    .replace(/^http:\/\//, 'https://')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
}

// An image without its tag: a template that says :latest still matches a
// guest pinned to a version.
function imageName(image) {
  const s = String(image || '').trim().toLowerCase();
  const at = s.indexOf('@');
  const base = at >= 0 ? s.slice(0, at) : s;
  const slash = base.lastIndexOf('/');
  const colon = base.lastIndexOf(':');
  return colon > slash ? base.slice(0, colon) : base;
}

// The template id a guest came from, or null. Only an unambiguous match
// counts: two templates on one repository say nothing about which it was.
function matchTemplate(agent, config, templates) {
  const hits = [];
  for (const t of templates) {
    const d = t.deploy;
    if (!d || d.runtime !== agent.runtime) continue;
    if ((d.runtime === 'git-app' || d.runtime === 'git-compose') && config.GIT_REPO) {
      if (normalizeRepo(d.repo) === normalizeRepo(config.GIT_REPO)) hits.push(t.id);
    } else if (d.runtime === 'docker-app' && (config.IMAGE || agent.image)) {
      if (imageName(d.image) === imageName(config.IMAGE || agent.image)) hits.push(t.id);
    }
  }
  return hits.length === 1 ? hits[0] : null;
}

// Fills in the template of every guest that has none and can be matched.
// Runtime guests (Hermes, OpenClaw) need none: their runtime is their template.
function backfill(db, templates) {
  const rows = db.prepare('SELECT id, runtime, image, config FROM agents WHERE template IS NULL').all();
  const set = db.prepare('UPDATE agents SET template = ? WHERE id = ?');
  let filled = 0;
  for (const row of rows) {
    let config = {};
    try { config = JSON.parse(row.config || '{}'); } catch (_) {}
    const id = matchTemplate(row, config, templates);
    if (id) { set.run(id, row.id); filled++; }
  }
  return filled;
}

module.exports = { normalizeRepo, imageName, matchTemplate, backfill };

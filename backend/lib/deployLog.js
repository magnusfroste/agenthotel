// Every deploy, kept: when it ran, what started it, how it ended, and its full
// log. Until now the panel held only a 60-line build tail in memory while a
// build ran, so a redeploy that went wrong left nothing to read once it was
// over, and nothing at all after a panel restart (2026-10-10, redeploying
// davida). Easypanel's deployment list is the model: one row per deploy, a
// log that streams while it runs and stays afterwards.
//
// Rows live in the `deployments` table; each log is a plain file under
// <dataDir>/deploy-logs/<id>.log, appended as lines arrive. A deploy's work
// runs inside an AsyncLocalStorage context, and console output from that work
// is copied into its log — the deploy code already narrates itself with
// console.log, so it needs no second logging call at every step. Build output
// arrives on docker's stream callbacks and is attributed by agent id instead.
//
// Logs can carry secrets (a build echoing an env value, a compose file's
// interpolated .env), so every value of a secret-looking config key is masked
// before a line is written, and the panel shows the log under data-secret.

const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const SECRET_KEY = /key|token|secret|password|passwd|credential/i;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const KEEP_PER_AGENT = 30;
const MIN_SECRET_LENGTH = 6;

// The panel's one deploy log, for code that cannot be handed it — the runtime
// plugins. note() writes to the deploy the caller runs in, and does nothing
// outside one.
let active = null;
function note(text) {
  if (active && text && String(text).trim()) active.line(String(text).trim());
}

function createDeployLog(db, dataDir) {
  const dir = path.join(dataDir, 'deploy-logs');
  fs.mkdirSync(dir, { recursive: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS deployments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      agent_name TEXT,
      kind TEXT NOT NULL,
      trigger TEXT,
      status TEXT NOT NULL,
      queued_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      commit_sha TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS deployments_agent ON deployments(agent_id, id);
  `);

  const als = new AsyncLocalStorage();
  // agent id -> the deployment running for it, for output that arrives
  // outside the async context (docker's build stream).
  const running = new Map();
  // deployment id -> { secrets, bytes, truncated }
  const state = new Map();

  const file = (id) => path.join(dir, `${Number(id)}.log`);

  function secretsOf(config) {
    const out = [];
    for (const [k, v] of Object.entries(config || {})) {
      if (typeof v === 'string' && v.length >= MIN_SECRET_LENGTH && SECRET_KEY.test(k)) out.push(v);
    }
    // Longest first, so a secret that contains another is masked whole.
    return out.sort((a, b) => b.length - a.length);
  }

  function mask(text, secrets) {
    let out = text;
    for (const s of secrets) if (out.includes(s)) out = out.split(s).join('••••••');
    return out;
  }

  function write(id, text) {
    const st = state.get(id);
    if (!st || st.truncated) return;
    const stamp = new Date().toISOString().slice(11, 19);
    const lines = mask(String(text), st.secrets).replace(/\r/g, '').split('\n')
      .filter((l, i, all) => l.trim() || (i > 0 && i < all.length - 1));
    if (!lines.length) return;
    let chunk = lines.map(l => `${stamp} ${l}`).join('\n') + '\n';
    if (st.bytes + chunk.length > MAX_LOG_BYTES) {
      chunk = `${stamp} [log truncated at ${MAX_LOG_BYTES / 1024 / 1024} MB]\n`;
      st.truncated = true;
    }
    st.bytes += chunk.length;
    try { fs.appendFileSync(file(id), chunk); } catch (e) { /* a log must never fail a deploy */ }
  }

  function prune(agentId) {
    const old = db.prepare(
      'SELECT id FROM deployments WHERE agent_id = ? AND status NOT IN (\'queued\', \'running\') ORDER BY id DESC LIMIT -1 OFFSET ?'
    ).all(agentId, KEEP_PER_AGENT);
    for (const { id } of old) {
      db.prepare('DELETE FROM deployments WHERE id = ?').run(id);
      try { fs.rmSync(file(id), { force: true }); } catch (e) { /* best-effort */ }
    }
  }

  // A deploy enters the queue. Returns its id.
  function queued(agentId, { kind = 'deploy', trigger = null, config = null } = {}) {
    const name = (() => {
      try { return db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId)?.name || null; } catch (e) { return null; }
    })();
    const id = db.prepare(
      'INSERT INTO deployments (agent_id, agent_name, kind, trigger, status, queued_at) VALUES (?, ?, ?, ?, \'queued\', ?)'
    ).run(agentId, name, kind, trigger, Date.now()).lastInsertRowid;
    state.set(id, { secrets: secretsOf(config), bytes: 0, truncated: false });
    write(id, `${kind} of ${name || agentId} queued${trigger ? ` (${trigger})` : ''}`);
    return Number(id);
  }

  // Run a queued deploy's work with its log attached.
  async function run(id, agentId, work) {
    db.prepare('UPDATE deployments SET status = \'running\', started_at = ? WHERE id = ?').run(Date.now(), id);
    running.set(agentId, id);
    write(id, 'Started');
    try {
      const result = await als.run({ id }, work);
      db.prepare('UPDATE deployments SET status = \'succeeded\', finished_at = ? WHERE id = ?').run(Date.now(), id);
      write(id, 'Deploy finished');
      return result;
    } catch (err) {
      write(id, `Deploy failed: ${err && err.message ? err.message : err}`);
      db.prepare('UPDATE deployments SET status = \'failed\', finished_at = ?, error = ? WHERE id = ?')
        .run(Date.now(), String(err && err.message ? err.message : err).slice(0, 2000), id);
      throw err;
    } finally {
      if (running.get(agentId) === id) running.delete(agentId);
      state.delete(id);
      try { prune(agentId); } catch (e) { /* retention is best-effort */ }
    }
  }

  // A line for the deploy this code runs in, or the one running for agentId.
  function line(text, agentId = null) {
    const id = als.getStore()?.id ?? (agentId ? running.get(agentId) : undefined);
    if (id !== undefined) write(id, text);
  }

  function setCommit(agentId, commit) {
    const id = als.getStore()?.id ?? running.get(agentId);
    if (id !== undefined && commit) db.prepare('UPDATE deployments SET commit_sha = ? WHERE id = ?').run(String(commit).slice(0, 64), id);
  }

  // Copy console output made inside a deploy into its log.
  function teeConsole() {
    for (const level of ['log', 'warn', 'error']) {
      const original = console[level].bind(console);
      console[level] = (...args) => {
        original(...args);
        const store = als.getStore();
        if (!store) return;
        const text = args.map(a => (a instanceof Error ? a.message : typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch (e) { return String(a); } })())).join(' ');
        write(store.id, level === 'log' ? text : `${level.toUpperCase()}: ${text}`);
      };
    }
  }

  // At start: a deploy a restart cut off is over, and says so.
  function interruptStale() {
    const stale = db.prepare('SELECT id FROM deployments WHERE status IN (\'queued\', \'running\')').all();
    for (const { id } of stale) {
      try { fs.appendFileSync(file(id), `${new Date().toISOString().slice(11, 19)} Interrupted by a panel restart\n`); } catch (e) {}
      db.prepare('UPDATE deployments SET status = \'interrupted\', finished_at = ?, error = \'Interrupted by a panel restart\' WHERE id = ?').run(Date.now(), id);
    }
    return stale.length;
  }

  function list(agentId, limit = KEEP_PER_AGENT) {
    return db.prepare('SELECT * FROM deployments WHERE agent_id = ? ORDER BY id DESC LIMIT ?').all(agentId, limit);
  }

  function get(id) {
    return db.prepare('SELECT * FROM deployments WHERE id = ?').get(Number(id)) || null;
  }

  // The log from byte offset on, so a viewer can follow it by polling.
  function read(id, offset = 0) {
    const row = get(id);
    if (!row) return null;
    let text = '';
    let size = 0;
    try {
      size = fs.statSync(file(id)).size;
      const from = Math.max(0, Math.min(Number(offset) || 0, size));
      if (size > from) {
        const fd = fs.openSync(file(id), 'r');
        try {
          const buf = Buffer.alloc(size - from);
          fs.readSync(fd, buf, 0, buf.length, from);
          text = buf.toString('utf8');
        } finally { fs.closeSync(fd); }
      }
    } catch (e) { /* no log yet */ }
    return { deployment: row, text, offset: size, done: !['queued', 'running'].includes(row.status) };
  }

  const api = { queued, run, line, setCommit, teeConsole, interruptStale, list, get, read, secretsOf, mask, file };
  active = api;
  return api;
}

module.exports = { createDeployLog, note, MAX_LOG_BYTES, KEEP_PER_AGENT };

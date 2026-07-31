require('dotenv').config();
const express = require('express');
const cors = require('cors');
const expressWs = require('express-ws');
const Database = require('better-sqlite3');
const Docker = require('dockerode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const tar = require('tar-fs');
const { injectProviderEnv } = require('./lib/providerEnv');
const { demuxDockerBuffer } = require('./lib/demux');

const app = express();
expressWs(app);
app.use(cors());
app.use(express.json());

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const db = new Database(process.env.DB_PATH || '/data/agentpanel.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    runtime TEXT NOT NULL,
    domain TEXT UNIQUE,
    image TEXT NOT NULL,
    port INTEGER NOT NULL,
    status TEXT DEFAULT 'creating',
    config TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    baseUrl TEXT,
    apiKey TEXT,
    models TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS cleanup_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    executed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    success INTEGER NOT NULL,
    containers_deleted INTEGER DEFAULT 0,
    images_deleted INTEGER DEFAULT 0,
    networks_deleted INTEGER DEFAULT 0,
    volumes_deleted INTEGER DEFAULT 0,
    space_reclaimed INTEGER DEFAULT 0,
    error TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts DATETIME DEFAULT CURRENT_TIMESTAMP,
    type TEXT NOT NULL,
    agent_id TEXT,
    message TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS uptime_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ok INTEGER NOT NULL,
    status_code INTEGER,
    latency_ms INTEGER
  )
`);

// Lightweight activity log, shown in the System page "Recent Activity" card.
// agent_id may outlive the agent row (deleted agents) — query with LEFT JOIN.
function logEvent(type, agentId, message) {
  try {
    db.prepare('INSERT INTO events (type, agent_id, message) VALUES (?, ?, ?)')
      .run(type, agentId || null, message);
  } catch (err) {
    console.error('Failed to log event:', err.message);
  }
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isSetup() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_email');
  return !!row;
}

function requireAuth(req, res, next) {
  const headerToken = req.headers.authorization?.replace('Bearer ', '');
  const queryToken = req.query?.token;
  const token = headerToken || queryToken;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  const stored = db.prepare('SELECT value FROM settings WHERE key = ?').get('auth_token');
  if (!stored || stored.value !== token) return res.status(401).json({ error: 'Invalid token' });
  next();
}

app.get('/api/setup', (req, res) => {
  res.json({ configured: isSetup() });
});

app.post('/api/setup', (req, res) => {
  if (isSetup()) return res.status(400).json({ error: 'Already configured' });
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const token = generateToken();

  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('admin_email', email);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('admin_password_hash', hash);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('admin_password_salt', salt);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('auth_token', token);

  res.json({ token, email });
});

app.post('/api/login', (req, res) => {
  if (!isSetup()) return res.status(400).json({ error: 'Not configured yet' });
  const { email, password } = req.body;
  const storedEmail = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_email');
  const storedHash = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password_hash');
  const storedSalt = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password_salt');

  if (!storedEmail || storedEmail.value !== email) return res.status(401).json({ error: 'Invalid credentials' });
  const hash = hashPassword(password, storedSalt.value);
  if (hash !== storedHash.value) return res.status(401).json({ error: 'Invalid credentials' });

  const storedToken = db.prepare('SELECT value FROM settings WHERE key = ?').get('auth_token');
  logEvent('auth.login', null, `Login: ${email}`);
  res.json({ token: storedToken.value, email });
});

app.get('/api/settings', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const row of rows) {
    if (!['admin_password_hash', 'admin_password_salt', 'auth_token'].includes(row.key)) {
      settings[row.key] = row.value;
    }
  }
  
  // Default values for new settings
  if (!settings.caddy_email) settings.caddy_email = '';
  if (!settings.default_timeout) settings.default_timeout = '30';
  if (!settings.default_network) settings.default_network = 'agentpanel_agentpanel';
  if (!settings.rate_limit_enabled) settings.rate_limit_enabled = 'false';
  if (!settings.rate_limit_requests) settings.rate_limit_requests = '100';
  if (!settings.require_https) settings.require_https = 'true';
  if (!settings.session_timeout) settings.session_timeout = '60';
  if (!settings.container_restart_policy) settings.container_restart_policy = 'unless-stopped';
  if (!settings.default_memory_limit) settings.default_memory_limit = '';
  if (!settings.default_cpu_limit) settings.default_cpu_limit = '';
  if (!settings.theme) settings.theme = 'dark';
  if (!settings.language) settings.language = 'sv';
  if (!settings.timezone) settings.timezone = 'Europe/Stockholm';
  
  res.json(settings);
});

app.put('/api/settings', requireAuth, async (req, res) => {
  try {
    let domainChanged = false;
    let newDomain = null;
    let oldDomain = null;
    let caddyEmailChanged = false;

    for (const [key, value] of Object.entries(req.body)) {
      if (['admin_email', 'admin_password_hash', 'admin_password_salt', 'auth_token'].includes(key)) continue;
      
      if (key === 'panel_domain') {
        const existing = db.prepare('SELECT value FROM settings WHERE key = ?').get('panel_domain');
        oldDomain = existing?.value || null;
        newDomain = value || null;
        if (oldDomain !== newDomain) domainChanged = true;
      }

      if (key === 'caddy_email') {
        caddyEmailChanged = true;
      }

      const existing = db.prepare('SELECT key FROM settings WHERE key = ?').get(key);
      if (existing) {
        db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(value, key);
      } else {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
      }
    }

    if (domainChanged) {
      await updatePanelCaddyRoute(oldDomain, newDomain);
    }

    if (caddyEmailChanged) {
      await updateCaddyEmail();
    }

    res.json({ updated: true });
  } catch (err) {
    console.error('Settings update error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/docker/prune', requireAuth, async (req, res) => {
  try {
    const results = {};
    
    const containersPrune = await docker.pruneContainers();
    results.containers = containersPrune.ContainersDeleted || [];
    results.containersSpaceReclaimed = containersPrune.SpaceReclaimed || 0;
    
    const imagesPrune = await docker.pruneImages();
    results.images = imagesPrune.ImagesDeleted || [];
    results.imagesSpaceReclaimed = imagesPrune.SpaceReclaimed || 0;
    
    const networksPrune = await docker.pruneNetworks();
    results.networks = networksPrune.NetworksDeleted || [];

    // NOTE: volumes are never pruned here — pruneVolumes() would destroy the
    // named volumes of stopped agents. Agent volumes are removed explicitly
    // when the agent is deleted (DELETE /api/agents/:id).
    results.volumes = [];
    results.volumesSpaceReclaimed = 0;

    const totalReclaimed = (results.containersSpaceReclaimed || 0) +
                           (results.imagesSpaceReclaimed || 0);

    // Log to database
    db.prepare(`
      INSERT INTO cleanup_logs (success, containers_deleted, images_deleted, networks_deleted, volumes_deleted, space_reclaimed)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      1,
      results.containers.length,
      results.images.length,
      results.networks.length,
      0,
      totalReclaimed
    );

    logEvent('docker.cleanup', null, `Manual cleanup reclaimed ${(totalReclaimed / 1024 / 1024).toFixed(2)} MB`);

    res.json({
      success: true,
      results,
      totalSpaceReclaimed: totalReclaimed,
      totalSpaceReclaimedMB: (totalReclaimed / 1024 / 1024).toFixed(2)
    });
  } catch (err) {
    console.error('Docker prune error:', err);
    
    // Log error to database
    db.prepare(`
      INSERT INTO cleanup_logs (success, error)
      VALUES (?, ?)
    `).run(0, err.message);
    
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/docker/cleanup-history', requireAuth, (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const logs = db.prepare(`
      SELECT * FROM cleanup_logs 
      ORDER BY executed_at DESC 
      LIMIT ?
    `).all(limit);
    
    res.json(logs.map(log => ({
      ...log,
      success: log.success === 1,
      space_reclaimed_mb: (log.space_reclaimed / 1024 / 1024).toFixed(2)
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Scheduled daily cleanup (runs every 24 hours)
async function runScheduledCleanup() {
  try {
    console.log('[Cleanup] Running scheduled Docker cleanup...');
    
    const results = {};
    const containersPrune = await docker.pruneContainers();
    results.containers = containersPrune.ContainersDeleted || [];
    results.containersSpaceReclaimed = containersPrune.SpaceReclaimed || 0;
    
    const imagesPrune = await docker.pruneImages();
    results.images = imagesPrune.ImagesDeleted || [];
    results.imagesSpaceReclaimed = imagesPrune.SpaceReclaimed || 0;
    
    const networksPrune = await docker.pruneNetworks();
    results.networks = networksPrune.NetworksDeleted || [];
    
    // NOTE: volumes are never pruned — pruneVolumes() would destroy the named
    // volumes of stopped agents. Agent volumes are removed explicitly when the
    // agent is deleted (DELETE /api/agents/:id).
    results.volumes = [];
    results.volumesSpaceReclaimed = 0;
    
    const totalReclaimed = (results.containersSpaceReclaimed || 0) + 
                           (results.imagesSpaceReclaimed || 0);
    
    db.prepare(`
      INSERT INTO cleanup_logs (success, containers_deleted, images_deleted, networks_deleted, volumes_deleted, space_reclaimed)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      1,
      results.containers.length,
      results.images.length,
      results.networks.length,
      results.volumes.length,
      totalReclaimed
    );

    logEvent('docker.cleanup', null, `Scheduled cleanup reclaimed ${(totalReclaimed / 1024 / 1024).toFixed(2)} MB`);
    console.log(`[Cleanup] Success: Reclaimed ${(totalReclaimed / 1024 / 1024).toFixed(2)} MB`);
  } catch (err) {
    console.error('[Cleanup] Error:', err.message);
    db.prepare(`
      INSERT INTO cleanup_logs (success, error)
      VALUES (?, ?)
    `).run(0, err.message);
  }
}

// Schedule cleanup to run every 24 hours
setInterval(runScheduledCleanup, 24 * 60 * 60 * 1000);
console.log('[Cleanup] Scheduled daily Docker cleanup enabled');

// Run a command inside a container and resolve with the captured stdout/stderr.
// Used to introspect other containers (e.g. read Caddy's managed certificates).
async function execCapture(containerName, cmd) {
  const container = docker.getContainer(containerName);
  const info = await container.inspect().catch(() => null);
  if (!info || !info.State.Running) throw new Error(`container ${containerName} not running`);
  const exec = await container.exec({
    AttachStdout: true, AttachStderr: true, Tty: false, Cmd: cmd
  });
  const stream = await exec.start({ Tty: false });
  return await new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      // Demux docker stream frames (8-byte header: [type,0,0,0,len...]) when not a TTY.
      const raw = demuxDockerBuffer(Buffer.concat(chunks));
      resolve(raw.toString('utf8'));
    });
    stream.on('error', reject);
  });
}

function readProcStat() {
  const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
  const vals = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = vals[3] + (vals[4] || 0);
  const total = vals.reduce((a, b) => a + b, 0);
  return { idle, total };
}

app.get('/api/system/stats', requireAuth, async (req, res) => {
  try {
    const { execSync } = require('child_process');
    
    const t1 = readProcStat();
    await new Promise(r => setTimeout(r, 300));
    const t2 = readProcStat();
    const idleDelta = t2.idle - t1.idle;
    const totalDelta = t2.total - t1.total;
    const cpuPct = totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 1000) / 10 : 0;

    const memData = fs.readFileSync('/proc/meminfo', 'utf8');
    const getKB = key => parseInt(memData.match(new RegExp(key + ':\\s+(\\d+)'))?.[1] || 0) * 1024;
    const memTotal = getKB('MemTotal');
    const memUsed = memTotal - getKB('MemAvailable');

    let diskUsed = 0, diskTotal = 1;
    try {
      const dfLine = execSync('df -B1 / 2>/dev/null | tail -1').toString().trim().split(/\s+/);
      diskTotal = parseInt(dfLine[1]) || 1;
      diskUsed = parseInt(dfLine[2]) || 0;
    } catch {}

    let cpuCores = 1;
    let cpuFreq = 0;
    let cpuLoad = [0, 0, 0];
    try {
      const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
      cpuCores = (cpuinfo.match(/processor\s*:/g) || []).length || 1;
      const freqMatch = cpuinfo.match(/cpu MHz\s*:\s*(\d+)/);
      cpuFreq = freqMatch ? parseInt(freqMatch[1]) : 0;
      const loadavg = fs.readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/);
      cpuLoad = [parseFloat(loadavg[0]), parseFloat(loadavg[1]), parseFloat(loadavg[2])];
    } catch {}

    let network = {};
    try {
      const netData = fs.readFileSync('/proc/net/dev', 'utf8');
      const lines = netData.split('\n').slice(2);
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 10 && parts[0] !== 'lo:') {
          const iface = parts[0].replace(':', '');
          const rx = parseInt(parts[1]) || 0;
          const tx = parseInt(parts[9]) || 0;
          if (rx > 0 || tx > 0) {
            network[iface] = {
              rx: formatBytes(rx),
              tx: formatBytes(tx)
            };
          }
        }
      }
    } catch {}

    res.json({
      cpu: { pct: cpuPct, cores: cpuCores, frequency: cpuFreq, load: cpuLoad },
      mem: { used: memUsed, total: memTotal, pct: Math.round(memUsed / memTotal * 100) },
      disk: { used: diskUsed, total: diskTotal, pct: Math.round(diskUsed / diskTotal * 100) },
      network
    });
  } catch (err) {
    console.error('System stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Build the panel route: host-matched when a panel domain is configured,
// otherwise the original catch-all (no matcher) so the panel stays reachable.
function buildPanelRoute(domain) {
  const route = {
    '@id': 'panel-route',
    handle: [{
      handler: 'subroute',
      routes: [
        {
          match: [{ path: ['/api/*'] }],
          handle: [{
            handler: 'reverse_proxy',
            upstreams: [{ dial: 'backend:8080' }]
          }]
        },
        {
          match: [{ path: ['/mcp'] }],
          handle: [{
            handler: 'reverse_proxy',
            upstreams: [{ dial: 'backend:8080' }]
          }]
        },
        {
          handle: [{
            handler: 'reverse_proxy',
            upstreams: [{ dial: 'frontend:80' }]
          }]
        }
      ]
    }]
  };
  if (domain) route.match = [{ host: [domain] }];
  return route;
}

async function updatePanelCaddyRoute(oldDomain, newDomain) {
  const caddyApiUrl = process.env.CADDY_API_URL || 'http://caddy:2019';
  const fetch = require('node-fetch');

  // Always remove the existing route first — POSTing another route with the
  // same @id 'panel-route' would leave a duplicate id in Caddy's config.
  try {
    await fetch(`${caddyApiUrl}/id/panel-route`, { method: 'DELETE' });
  } catch (e) { /* ignore — route may not exist */ }

  // Recreate the route: host-matched for the new domain, or the catch-all
  // when the domain was cleared.
  const res = await fetch(`${caddyApiUrl}/config/apps/http/servers/srv0/routes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildPanelRoute(newDomain))
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to update Caddy panel route: ${err}`);
  }

  if (newDomain) {
    // Check if TLS policy already exists for this domain
    const existingPoliciesRes = await fetch(`${caddyApiUrl}/config/apps/tls/automation/policies`);
    if (existingPoliciesRes.ok) {
      const existingPolicies = await existingPoliciesRes.json();
      const policyExists = existingPolicies.some(policy => 
        policy.subjects && policy.subjects.includes(newDomain)
      );
      
      if (!policyExists) {
        const tlsRes = await fetch(`${caddyApiUrl}/config/apps/tls/automation/policies`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subjects: [newDomain],
            issuers: [{ module: 'acme', ca: 'https://acme-v02.api.letsencrypt.org/directory' }]
          })
        });

        if (!tlsRes.ok) {
          const err = await tlsRes.text();
          console.error('Failed to update Caddy TLS policy:', err);
        }
      }
    }
  }
}

async function updateCaddyEmail() {
  const caddyApiUrl = process.env.CADDY_API_URL || 'http://caddy:2019';
  const fetch = require('node-fetch');
  
  const emailRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('caddy_email');
  const email = emailRow?.value;
  
  if (!email) return;
  
  try {
    // Remove previously added global (subject-less) policies with a different
    // contact email — POST appends, so old ones would otherwise accumulate.
    const listRes = await fetch(`${caddyApiUrl}/config/apps/tls/automation/policies`);
    if (listRes.ok) {
      const policies = await listRes.json();
      for (let i = (policies || []).length - 1; i >= 0; i--) {
        const p = policies[i];
        if (p && !p.subjects) {
          const contact = p.issuers?.[0]?.contact || [];
          if (!contact.includes(`mailto:${email}`)) {
            await fetch(`${caddyApiUrl}/config/apps/tls/automation/policies/${i}`, { method: 'DELETE' })
              .catch(() => {});
          }
        }
      }
    }

    const res = await fetch(`${caddyApiUrl}/config/apps/tls/automation/policies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        issuers: [{
          module: 'acme',
          ca: 'https://acme-v02.api.letsencrypt.org/directory',
          contact: [`mailto:${email}`]
        }]
      })
    });
    
    if (!res.ok) {
      const err = await res.text();
      console.error('Failed to update Caddy email:', err);
    }
  } catch (err) {
    console.error('Failed to update Caddy email:', err);
  }
}

const runtimes = {
  hermes: require('./plugins/hermes'),
  openclaw: require('./plugins/openclaw'),
  odysseus: require('./plugins/odysseus'),
  'docker-app': require('./plugins/docker-app'),
  compose: require('./plugins/compose')
};

const { createMcpServer } = require('./mcp');
const mcpServer = createMcpServer(db, docker, runtimes, deployAgent, removeCaddyRoute);

app.post('/mcp', mcpServer.requireMcpAuth, mcpServer.handleMcpRequest);

app.get('/api/agents', requireAuth, (req, res) => {
  const agents = db.prepare('SELECT * FROM agents ORDER BY created_at DESC').all();
  res.json(agents.map(a => ({ ...a, config: JSON.parse(a.config || '{}') })));
});

app.get('/api/agents/:id', requireAuth, (req, res) => {
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json({ ...agent, config: JSON.parse(agent.config || '{}') });
});

app.post('/api/agents', requireAuth, async (req, res) => {
  let createdId = null;
  try {
    const { name, runtime, domain, image, port, config, quickStart } = req.body;
    const plugin = runtimes[runtime];
    if (!plugin) return res.status(400).json({ error: `Unknown runtime: ${runtime}` });

    // The name flows into container/volume names — keep it strict.
    if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      return res.status(400).json({ error: 'Invalid name: use lowercase letters, digits and hyphens, starting with a letter or digit' });
    }

    // Compose deploy would crash on writeFileSync(undefined) without a compose file.
    if (runtime === 'compose' && !(config && config.COMPOSE_FILE)) {
      return res.status(400).json({ error: 'COMPOSE_FILE is required for compose agents' });
    }

    const id = `${runtime}-${name}-${Date.now()}`;
    createdId = id;

    // Auto-inject provider API keys + default models (shared with mcp.js).
    const finalConfig = injectProviderEnv(db, config);

    const agentConfig = plugin.buildConfig({ name, domain, image, port, config: finalConfig });

    db.prepare(`
      INSERT INTO agents (id, name, runtime, domain, image, port, config, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'creating')
    `).run(id, name, runtime, domain, image || plugin.defaultImage, port || plugin.defaultPort, JSON.stringify(agentConfig));

    // Handle compose runtime separately
    if (runtime === 'compose') {
      await plugin.deploy(id, name, agentConfig, plugin);
    } else {
      await deployAgent(id, name, runtime, domain, image || plugin.defaultImage, port || plugin.defaultPort, agentConfig, plugin);
    }

    db.prepare("UPDATE agents SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    logEvent('agent.create', id, `Created agent ${name}`);
    res.json({ id, name, status: 'running' });
  } catch (err) {
    console.error('Create agent error:', err);
    // Delete only the row this request created — never pattern-match, that
    // wiped other agents' rows.
    if (createdId) {
      db.prepare('DELETE FROM agents WHERE id = ?').run(createdId);
    }
    res.status(500).json({ error: err.message });
  }
});

async function deployAgent(id, name, runtime, domain, image, port, config, plugin) {
  const containerName = `agentpanel-${id}`;
  const baseImage = `${runtime}-agentpanel:latest`;
  
  let imageToRun = image;
  let volumes = [];
  
  if (runtime !== 'docker-app') {
    const dockerfilePath = path.join('/templates', runtime, 'Dockerfile');
    if (fs.existsSync(dockerfilePath)) {
      // Check if image already exists
      try {
        await docker.getImage(baseImage).inspect();
        console.log(`Using existing image: ${baseImage}`);
        imageToRun = baseImage;
      } catch (e) {
        // Image doesn't exist, build it
        console.log(`Building image: ${baseImage}`);
        const buildContext = path.join('/templates', runtime);
        const tarStream = tar.pack(buildContext);
        const stream = await docker.buildImage(tarStream, { t: baseImage, pull: true });
        await new Promise((resolve, reject) => {
          docker.modem.followProgress(stream, (err) => err ? reject(err) : resolve());
        });
        imageToRun = baseImage;
      }
    }
    
    if (fs.existsSync(dockerfilePath)) {
      const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf8');
      const volumeMatches = dockerfileContent.match(/^VOLUME\s+(.+)$/gm);
      if (volumeMatches) {
        volumeMatches.forEach(match => {
          const volumeSpec = match.replace(/^VOLUME\s+/, '').replace(/[\[\]"]/g, '').trim();
          const volumePaths = volumeSpec.split(/[\s,]+/).filter(p => p && p.startsWith('/'));
          volumePaths.forEach(volumePath => {
            const safeName = volumePath.replace(/\//g, '-').replace(/^-/, '').replace(/[^a-zA-Z0-9_.-]/g, '');
            if (safeName) {
              volumes.push(`agentpanel-${id}-${safeName}:${volumePath}`);
            }
          });
        });
      }
    }
  }
  
  if (config.volumes && Array.isArray(config.volumes)) {
    config.volumes.forEach(vol => {
      if (typeof vol === 'string' && vol.includes(':')) {
        if (vol.startsWith('/')) {
          // Absolute host path (docker-app VOLUMES) — bind mount as-is,
          // preserving any :ro/:rw suffix.
          volumes.push(vol);
        } else {
          const [hostPath, containerPath] = vol.split(':');
          if (hostPath && containerPath) {
            volumes.push(`agentpanel-${id}-${hostPath}:${containerPath}`);
          }
        }
      }
    });
  }
  
  if (volumes.length === 0) {
    volumes = [`agentpanel-${id}-data:/data`];
  }
  
  const envVars = plugin.buildEnv(config);
  const containerConfig = {
    name: containerName,
    Image: imageToRun,
    Env: envVars,
    ExposedPorts: { [`${port}/tcp`]: {} },
    HostConfig: {
      // No PortBindings: agents are reached via the internal docker network +
      // Caddy. Publishing a random public host port would bypass Caddy.
      RestartPolicy: { Name: 'unless-stopped' },
      Binds: volumes
    },
    Labels: {
      'agentpanel.agent': 'true',
      'agentpanel.id': id,
      'agentpanel.runtime': runtime,
      'agentpanel.name': name
    }
  };

  if (runtime === 'hermes') {
    containerConfig.Cmd = ['gateway', 'run'];
  }

  if (domain) {
    containerConfig.Labels['agentpanel.domain'] = domain;
  }

  const networkRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('default_network');
  const networkName = networkRow?.value || 'agentpanel_agentpanel';

  const container = await docker.createContainer(containerConfig);
  try {
    await container.start();

    const network = docker.getNetwork(networkName);
    await network.connect({ Container: containerName });

    if (domain) {
      await addCaddyRoute(domain, containerName, port);
    }
  } catch (err) {
    // Roll back a partially deployed container so a retry doesn't collide
    // with the leftover container name.
    try { await container.remove({ force: true }); } catch (e) {}
    throw err;
  }

  // Hermes needs its model: block in /opt/data/config.yaml overridden. The image
  // bakes `provider: auto` + an OpenRouter base_url. We patch config.yaml (base64,
  // preserving other sections) then SIGHUP the gateway so it re-reads (s6
  // auto-respawns it; SIGHUP keeps Docker networks intact). This runs async —
  // deployAgent returns immediately once the container is up/routed.
  if (runtime === 'hermes' && plugin.generateConfig) {
    patchHermesConfig(container, plugin.generateConfig(config)).catch(err =>
      console.error('[Hermes] config patch failed:', err.message)
    );
  }
}

async function patchHermesConfig(container, modelBlock) {
  const b64 = Buffer.from(modelBlock).toString('base64');
  // Wait for the s6 init scripts to finish writing the baked config.
  await new Promise(r => setTimeout(r, 5000));
  const patchScript = `
import base64
mb = base64.b64decode('${b64}').decode()
with open('/opt/data/config.yaml') as f: lines = f.readlines()
out, i = [], 0
while i < len(lines):
    if lines[i].startswith('model:'):
        i += 1
        while i < len(lines) and lines[i].startswith('  '): i += 1
        continue
    out.append(lines[i]); i += 1
open('/opt/data/config.yaml', 'w').write(mb + ''.join(out))
`;
  const exec = await container.exec({ Cmd: ['python3', '-c', patchScript], AttachStdout: true, AttachStderr: true });
  const stream = await exec.start();
  await new Promise((resolve) => stream.on('end', resolve));
  // SIGHUP the supervised gateway process; s6 auto-respawns it with new config.
  const killExec = await container.exec({ Cmd: ['sh', '-c', 'kill -HUP $(pgrep -f "hermes gateway run" | head -1) 2>/dev/null; sleep 1'], AttachStdout: true, AttachStderr: true });
  const rs = await killExec.start({ Detach: true });
  rs.destroy();
  console.log('[Hermes] config.yaml patched, gateway reloading');
}

async function addCaddyRoute(domain, containerName, port) {
  const caddyApiUrl = process.env.CADDY_API_URL || 'http://caddy:2019';
  const fetch = require('node-fetch');

  const route = {
    '@id': `agent-${domain}`,
    match: [{ host: [domain] }],
    handle: [{
      handler: 'reverse_proxy',
      upstreams: [{ dial: `${containerName}:${port}` }]
    }]
  };

  const res = await fetch(`${caddyApiUrl}/config/apps/http/servers/srv0/routes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(route)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to add Caddy route: ${err}`);
  }
}

// Remove the named volumes created for an agent (agentpanel-<id>-*). Called on
// agent deletion only — global volume pruning would destroy stopped agents' data.
async function removeAgentVolumes(id) {
  try {
    const prefix = `agentpanel-${id}-`;
    const { Volumes } = await docker.listVolumes();
    for (const vol of (Volumes || [])) {
      if (vol.Name && vol.Name.startsWith(prefix)) {
        try {
          await docker.getVolume(vol.Name).remove();
        } catch (e) {
          console.error(`Failed to remove volume ${vol.Name}:`, e.message);
        }
      }
    }
  } catch (e) {
    console.error(`Failed to list volumes for agent ${id}:`, e.message);
  }
}

app.delete('/api/agents/:id', requireAuth, async (req, res) => {
  try {
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    if (agent.runtime === 'compose') {
      // Compose agents have no single container — tear the project down.
      const plugin = runtimes.compose;
      const config = JSON.parse(agent.config || '{}');
      await plugin.remove(agent.id, config);
    } else {
      const container = docker.getContainer(`agentpanel-${req.params.id}`);
      try {
        await container.stop();
        await container.remove();
      } catch (e) { /* container may not exist */ }

      await removeAgentVolumes(req.params.id);
    }

    if (agent.domain) {
      await removeCaddyRoute(agent.domain);
    }

    db.prepare('DELETE FROM agents WHERE id = ?').run(req.params.id);
    logEvent('agent.delete', req.params.id, `Deleted agent ${agent.name}`);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agents/:id/stop', requireAuth, async (req, res) => {
  try {
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const container = docker.getContainer(`agentpanel-${req.params.id}`);
    await container.stop();

    db.prepare("UPDATE agents SET status = 'stopped', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    logEvent('agent.stop', req.params.id, `Stopped agent ${agent.name}`);
    res.json({ stopped: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agents/:id/start', requireAuth, async (req, res) => {
  try {
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const container = docker.getContainer(`agentpanel-${req.params.id}`);
    await container.start();

    db.prepare("UPDATE agents SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    logEvent('agent.start', req.params.id, `Started agent ${agent.name}`);
    res.json({ started: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function removeCaddyRoute(domain) {
  const caddyApiUrl = process.env.CADDY_API_URL || 'http://caddy:2019';
  const fetch = require('node-fetch');
  await fetch(`${caddyApiUrl}/id/agent-${domain}`, { method: 'DELETE' });
}

app.put('/api/agents/:id', requireAuth, async (req, res) => {
  try {
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const { config, domain } = req.body;
    const updatedConfig = config ? { ...JSON.parse(agent.config || '{}'), ...config } : JSON.parse(agent.config || '{}');
    const updatedDomain = domain !== undefined ? domain : agent.domain;

    db.prepare("UPDATE agents SET config = ?, domain = ?, status = 'updating', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(JSON.stringify(updatedConfig), updatedDomain, req.params.id);

    const plugin = runtimes[agent.runtime];

    if (agent.runtime === 'compose') {
      // Compose agents are managed via the compose plugin, not dockerode
      // (their image is 'compose' and can't be created as a container).
      await plugin.stop(agent.id, JSON.parse(agent.config || '{}'));
      await plugin.deploy(agent.id, agent.name, updatedConfig, plugin);
    } else {
      const container = docker.getContainer(`agentpanel-${req.params.id}`);
      try { await container.stop(); await container.remove(); } catch (e) {}

      if (agent.domain) {
        await removeCaddyRoute(agent.domain);
      }

      await deployAgent(agent.id, agent.name, agent.runtime, updatedDomain, agent.image, agent.port, updatedConfig, plugin);
    }

    db.prepare("UPDATE agents SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    res.json({ updated: true, config: updatedConfig, domain: updatedDomain });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agents/:id/redeploy', requireAuth, async (req, res) => {
  try {
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const config = JSON.parse(agent.config || '{}');
    const plugin = runtimes[agent.runtime];

    db.prepare("UPDATE agents SET status = 'redeploying', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);

    if (agent.runtime === 'compose') {
      // Compose agents are managed via the compose plugin, not dockerode.
      await plugin.stop(agent.id, config);
      await plugin.deploy(agent.id, agent.name, config, plugin);
    } else {
      const container = docker.getContainer(`agentpanel-${req.params.id}`);
      try { await container.stop(); await container.remove(); } catch (e) {}

      if (agent.domain) {
        await removeCaddyRoute(agent.domain);
      }

      await deployAgent(agent.id, agent.name, agent.runtime, agent.domain, agent.image, agent.port, config, plugin);
    }

    db.prepare("UPDATE agents SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    logEvent('agent.redeploy', req.params.id, `Redeployed agent ${agent.name}`);
    res.json({ redeployed: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/agents/:id/logs', requireAuth, async (req, res) => {
  try {
    const container = docker.getContainer(`agentpanel-${req.params.id}`);
    const logs = await container.logs({
      stdout: true, stderr: true,
      tail: parseInt(req.query.tail) || 100,
      follow: false
    });
    // Containers run without a TTY, so docker returns the multiplexed stream
    // with 8-byte frame headers — strip them before sending to the log viewer.
    res.type('text/plain').send(demuxDockerBuffer(logs).toString('utf8'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.ws('/api/agents/:id/terminal', (ws, req) => {
  // Handle authentication manually for WebSocket
  const token = req.query.token || req.headers.authorization?.replace('Bearer ', '');
  const storedToken = db.prepare('SELECT value FROM settings WHERE key = ?').get('auth_token');
  
  if (!token || !storedToken || token !== storedToken.value) {
    ws.send('Authentication failed\r\n');
    ws.close();
    return;
  }
  
  console.log('[Terminal] WebSocket connection attempt for agent:', req.params.id);
  (async () => {
    let stream = null;
    try {
      const container = docker.getContainer(`agentpanel-${req.params.id}`);
      console.log('[Terminal] Got container, creating exec...');
      const exec = await container.exec({
        AttachStdin: true, AttachStdout: true, AttachStderr: true,
        Tty: true,
        Cmd: [process.env.DEFAULT_SHELL || '/bin/sh']
      });
      console.log('[Terminal] Exec created, starting...');
      stream = await exec.start({ Tty: true });
      console.log('[Terminal] Exec started, listening for data...');
      
      stream.on('data', (chunk) => {
        const data = chunk.toString('utf8');
        console.log('[Terminal] Data received:', data.substring(0, 50));
        ws.send(data);
      });
      
      stream.on('end', () => {
        console.log('[Terminal] Stream ended');
        ws.close();
      });
      
      stream.on('error', (err) => {
        console.error('[Terminal] Stream error:', err.message);
        ws.send(`\r\nStream error: ${err.message}\r\n`);
      });
      
      ws.on('message', (msg) => {
        if (stream && !stream.destroyed) {
          stream.write(msg.toString());
        }
      });
      
      ws.on('close', () => {
        console.log('[Terminal] WebSocket closed');
        if (stream) {
          try { stream.destroy(); } catch (e) {}
        }
      });
      
      ws.on('error', (err) => {
        console.error('[Terminal] WebSocket error:', err.message);
      });
    } catch (err) {
      console.error('[Terminal] Error:', err.message);
      ws.send(`Terminal error: ${err.message}\r\n`);
      ws.close();
    }
  })();
});

// Host terminal with node-pty (real PTY support)
app.ws('/api/system/host-terminal', (ws, req) => {
  const token = req.query.token || req.headers.authorization?.replace('Bearer ', '');
  const storedToken = db.prepare('SELECT value FROM settings WHERE key = ?').get('auth_token');
  
  if (!token || !storedToken || token !== storedToken.value) {
    ws.send('Authentication failed\r\n');
    ws.close();
    return;
  }
  
  console.log('[Host Terminal] WebSocket connection established');
  
  const pty = require('node-pty');
  const shell = process.env.SHELL || '/bin/bash';
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: process.env.HOME || '/root',
    env: process.env
  });
  
  ptyProcess.onData((data) => {
    try {
      ws.send(data);
    } catch (err) {
      console.error('[Host Terminal] WebSocket send error:', err.message);
    }
  });
  
  ptyProcess.onExit(({ exitCode, signal }) => {
    console.log('[Host Terminal] Process exited:', exitCode, signal);
    ws.close();
  });
  
  ws.on('message', (msg) => {
    const message = msg.toString();
    
    // Handle resize messages
    if (message.startsWith('{"cols"')) {
      try {
        const { cols, rows } = JSON.parse(message);
        ptyProcess.resize(cols, rows);
        console.log('[Host Terminal] Resized to', cols, 'x', rows);
      } catch (err) {
        console.error('[Host Terminal] Resize error:', err.message);
      }
    } else {
      ptyProcess.write(message);
    }
  });
  
  ws.on('close', () => {
    console.log('[Host Terminal] WebSocket closed, killing process');
    ptyProcess.kill();
  });
  
  ws.on('error', (err) => {
    console.error('[Host Terminal] WebSocket error:', err.message);
    ptyProcess.kill();
  });
});

app.get('/api/runtimes', requireAuth, (req, res) => {
  res.json(Object.entries(runtimes).map(([key, plugin]) => ({
    id: key,
    name: plugin.name,
    description: plugin.description,
    defaultImage: plugin.defaultImage,
    defaultPort: plugin.defaultPort,
    configFields: plugin.configFields
  })));
});

app.get('/api/agents/:id/status', requireAuth, async (req, res) => {
  try {
    const container = docker.getContainer(`agentpanel-${req.params.id}`);
    const info = await container.inspect();
    res.json({
      status: info.State.Running ? 'running' : 'stopped',
      health: info.State.Health?.Status || 'none',
      startedAt: info.State.StartedAt
    });
  } catch (err) {
    res.json({ status: 'not_found' });
  }
});

// Live per-container resource usage. Returns { running: false } (200) when the
// container is missing or stopped so the UI can show a friendly empty state.
app.get('/api/agents/:id/stats', requireAuth, async (req, res) => {
  try {
    const container = docker.getContainer(`agentpanel-${req.params.id}`);
    const info = await container.inspect().catch(() => null);
    if (!info || !info.State.Running) return res.json({ running: false });

    const stats = await container.stats({ stream: false });

    // Standard docker CPU% formula: delta of container vs system CPU usage,
    // scaled by the number of online CPUs.
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - (stats.precpu_stats.cpu_usage?.total_usage || 0);
    const systemDelta = stats.cpu_stats.system_cpu_usage - (stats.precpu_stats.system_cpu_usage || 0);
    const onlineCpus = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage.percpu_usage?.length || 1;
    const cpuPct = systemDelta > 0 && cpuDelta > 0
      ? Math.round((cpuDelta / systemDelta) * onlineCpus * 1000) / 10
      : 0;

    const memUsed = stats.memory_stats.usage || 0;
    const memLimit = stats.memory_stats.limit || 0;

    let rx = 0, tx = 0;
    for (const iface of Object.values(stats.networks || {})) {
      rx += iface.rx_bytes || 0;
      tx += iface.tx_bytes || 0;
    }

    res.json({
      running: true,
      cpu: { pct: cpuPct },
      mem: { used: memUsed, limit: memLimit, pct: memLimit > 0 ? Math.round(memUsed / memLimit * 1000) / 10 : 0 },
      network: { rx, tx }
    });
  } catch (err) {
    if (err.statusCode === 404) return res.json({ running: false });
    console.error('Agent stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Uptime summary for one agent: 24h/7d percentages, latest check, recent history.
app.get('/api/agents/:id/uptime', requireAuth, (req, res) => {
  try {
    const pct = (window) => {
      const row = db.prepare(`
        SELECT COUNT(*) AS total, SUM(ok) AS ok_count FROM uptime_checks
        WHERE agent_id = ? AND checked_at >= datetime('now', ?)
      `).get(req.params.id, window);
      return row.total > 0 ? Math.round((row.ok_count / row.total) * 1000) / 10 : null;
    };

    const current = db.prepare(`
      SELECT ok, status_code, latency_ms, checked_at FROM uptime_checks
      WHERE agent_id = ? ORDER BY checked_at DESC, id DESC LIMIT 1
    `).get(req.params.id) || null;

    const recent = db.prepare(`
      SELECT ok, status_code, latency_ms, checked_at FROM uptime_checks
      WHERE agent_id = ? ORDER BY checked_at DESC, id DESC LIMIT 50
    `).all(req.params.id).reverse(); // oldest -> newest for the bar strip

    res.json({
      last24h: pct('-1 day'),
      last7d: pct('-7 days'),
      current: current ? { ...current, ok: current.ok === 1 } : null,
      recent: recent.map(c => ({ ...c, ok: c.ok === 1 }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Activity log, newest first. LEFT JOIN keeps events of deleted agents (name null).
app.get('/api/events', requireAuth, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const rows = db.prepare(`
      SELECT events.*, agents.name AS agent_name
      FROM events LEFT JOIN agents ON events.agent_id = agents.id
      ORDER BY events.ts DESC, events.id DESC
      LIMIT ?
    `).all(limit);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/providers', requireAuth, (req, res) => {
  const providers = db.prepare('SELECT * FROM providers ORDER BY created_at DESC').all();
  res.json(providers.map(p => ({ ...p, models: JSON.parse(p.models || '[]') })));
});

app.post('/api/providers', requireAuth, (req, res) => {
  try {
    const { name, type, baseUrl, apiKey, models } = req.body;
    const id = `provider-${name}-${Date.now()}`;
    db.prepare('INSERT INTO providers (id, name, type, baseUrl, apiKey, models) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, name, type, baseUrl, apiKey, JSON.stringify(models || []));
    res.json({ id, name, type, baseUrl, apiKey, models });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/providers/:id', requireAuth, (req, res) => {
  try {
    const { name, type, baseUrl, apiKey, models } = req.body;
    db.prepare('UPDATE providers SET name = ?, type = ?, baseUrl = ?, apiKey = ?, models = ? WHERE id = ?')
      .run(name, type, baseUrl, apiKey, JSON.stringify(models || []), req.params.id);
    res.json({ updated: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/providers/:id', requireAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM providers WHERE id = ?').run(req.params.id);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/providers/:id/models', requireAuth, async (req, res) => {
  try {
    const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
    if (!provider) return res.status(404).json({ error: 'Provider not found' });
    
    if (provider.models && provider.models !== '[]') {
      return res.json(JSON.parse(provider.models));
    }
    
    if (provider.baseUrl) {
      const fetch = require('node-fetch');
      const headers = {};
      if (provider.apiKey) {
        headers['Authorization'] = `Bearer ${provider.apiKey}`;
      }
      const modelsRes = await fetch(`${provider.baseUrl}/models`, { headers });
      const data = await modelsRes.json();
      const models = data.data || data.models || [];
      res.json(models);
    } else {
      res.json([]);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/providers/:id/test', requireAuth, async (req, res) => {
  try {
    const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
    if (!provider) return res.status(404).json({ error: 'Provider not found' });
    
    const { model, prompt } = req.body;
    const testPrompt = prompt || 'Say hello in one word';
    const testModel = model || (provider.models && provider.models !== '[]' ? JSON.parse(provider.models)[0] : 'gpt-3.5-turbo');
    
    const fetch = require('node-fetch');
    const headers = {
      'Content-Type': 'application/json'
    };
    if (provider.apiKey) {
      headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }
    
    const body = JSON.stringify({
      model: testModel,
      messages: [{ role: 'user', content: testPrompt }],
      max_tokens: 50
    });
    
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body
    });
    
    if (!response.ok) {
      let errorMsg = `HTTP ${response.status}: ${response.statusText}`;
      try {
        const errData = await response.json();
        errorMsg = errData.error?.message || errData.message || errData.error || errorMsg;
      } catch {}
      res.json({ success: false, error: errorMsg });
      return;
    }
    
    const data = await response.json();
    
    if (data.error) {
      res.json({ success: false, error: data.error.message || data.error });
    } else {
      const reply = data.choices?.[0]?.message?.content || 'No response';
      res.json({ success: true, response: reply, model: testModel });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// System control endpoints
const { execSync } = require('child_process');

app.get('/api/system/status', requireAuth, (req, res) => {
  try {
    const uptimeRaw = execSync('uptime').toString().trim();
    const uptimeMatch = uptimeRaw.match(/up\s+(.+?),\s+\d+\s+user/);
    const uptime = uptimeMatch ? uptimeMatch[1].trim() : uptimeRaw;
    const hostname = execSync('hostname').toString().trim();
    const kernel = execSync('uname -r').toString().trim();
    const os = execSync('cat /etc/os-release | grep PRETTY_NAME | cut -d\\" -f2').toString().trim();
    const dockerVersion = execSync('docker --version').toString().trim();
    let gitBranch = 'unknown';
    let gitCommit = 'unknown';
    try {
      gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: '/app' }).toString().trim();
      gitCommit = execSync('git rev-parse --short HEAD', { cwd: '/app' }).toString().trim();
    } catch (e) {}
    
    res.json({
      hostname,
      kernel,
      os,
      uptime,
      dockerVersion,
      agentpanel: {
        branch: gitBranch,
        commit: gitCommit
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/system/restart-panel', requireAuth, (req, res) => {
  try {
    res.json({ message: 'Restarting AgentPanel...' });
    // The backend container's id is its hostname; restart it via the mounted
    // docker socket (there is no docker-compose.yml inside /app).
    setTimeout(() => {
      docker.getContainer(os.hostname()).restart()
        .catch(err => console.error('Panel restart failed:', err.message));
    }, 100);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/system/restart-docker', requireAuth, (req, res) => {
  // systemctl is not available inside the container.
  res.status(501).json({ error: 'Restarting Docker must be done on the host via ssh: systemctl restart docker' });
});

app.post('/api/system/update', requireAuth, async (req, res) => {
  // No .git or docker-compose.yml exists inside the container.
  res.status(501).json({ error: 'Updating AgentPanel must be done on the host via ssh: git pull && docker compose build && docker compose up -d' });
});

app.post('/api/system/reboot', requireAuth, (req, res) => {
  // The container cannot reboot the host.
  res.status(501).json({ error: 'Rebooting the server must be done on the host via ssh: reboot' });
});

app.post('/api/console/execute', requireAuth, (req, res) => {
  try {
    const { command } = req.body;
    if (!command) return res.status(400).json({ error: 'Command required' });
    
    const output = execSync(command, { 
      cwd: '/app',
      timeout: 30000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    res.json({ output, success: true });
  } catch (err) {
    res.json({ 
      output: err.stdout + err.stderr, 
      success: false,
      error: err.message 
    });
  }
});

app.get('/api/system/mcp-status', requireAuth, (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    
    const mcpDir = '/app/mcp';
    const mcpServerFile = path.join(mcpDir, 'server.js');
    const mcpConfigFile = path.join(mcpDir, 'config.json');
    
    let mcpInstalled = fs.existsSync(mcpServerFile);
    let mcpConfigured = fs.existsSync(mcpConfigFile);
    let mcpRunning = false;
    let mcpEndpoint = null;
    let mcpToken = null;
    
    if (mcpConfigured) {
      try {
        const config = JSON.parse(fs.readFileSync(mcpConfigFile, 'utf8'));
        mcpEndpoint = config.endpoint || null;
        mcpToken = config.token ? '***' + config.token.slice(-4) : null;
      } catch (e) {}
    }
    
    try {
      const ps = execSync('ps aux | grep -E "node.*mcp.*server" | grep -v grep', { encoding: 'utf8' });
      mcpRunning = ps.trim().length > 0;
    } catch (e) {}
    
    res.json({
      installed: mcpInstalled,
      configured: mcpConfigured,
      running: mcpRunning,
      endpoint: mcpEndpoint,
      token: mcpToken
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/system/mcp-enable', requireAuth, async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const { execSync } = require('child_process');
    
    const mcpDir = '/app/mcp';
    if (!fs.existsSync(mcpDir)) {
      fs.mkdirSync(mcpDir, { recursive: true });
    }
    
    const authToken = db.prepare("SELECT value FROM settings WHERE key = 'auth_token'").get()?.value;
    
    if (!authToken) {
      return res.status(500).json({ error: 'No auth token found' });
    }
    
    const config = {
      endpoint: '/mcp',
      token: authToken,
      enabled: true,
      createdAt: new Date().toISOString()
    };
    
    fs.writeFileSync(path.join(mcpDir, 'config.json'), JSON.stringify(config, null, 2));
    
    res.json({ 
      message: 'MCP enabled',
      endpoint: config.endpoint,
      token: '***' + authToken.slice(-4)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/certificates', requireAuth, async (req, res) => {
  try {
    // Caddy stores managed Let's Encrypt certificates as PEM files under
    // /data/caddy/certificates/<issuer-directory>/<domain>/<domain>.crt, with a
    // sibling .json carrying SANs + ACME renewal metadata. The Caddy admin API's
    // /pki/certificates/local only exposes the internal CA, not LE certs, so we
    // read the real leaf certs from disk via docker exec and parse them here.
    const output = await execCapture('agentpanel-caddy', [
      'sh', '-c',
      "for f in $(find /data/caddy/certificates -name '*.crt' 2>/dev/null); do echo \"===FILE:$f\"; cat \"$f\"; echo '===END'; done"
    ]);

    const crypto = require('crypto');
    const blocks = output.split(/===FILE:/);
    const certificates = [];
    const pemRe = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
    for (const block of blocks) {
      if (!block.trim()) continue;
      const m = block.match(pemRe);
      if (!m) continue;
      for (const pem of m) {
        try {
          const cert = new crypto.X509Certificate(Buffer.from(pem));
          const issuerCN = (cert.issuer.match(/CN=([^,]+)/) || [])[1] || cert.issuer;
          const sans = cert.subjectAltName
            ? cert.subjectAltName.replace(/DNS:/g, '').split(',').map(s => s.trim()).filter(Boolean)
            : [];
          const primary = sans[0] || (cert.subject.match(/CN=([^,]+)/) || [])[1] || 'unknown';
          certificates.push({
            domain: primary,
            sans,
            issuer: issuerCN,
            notBefore: new Date(cert.validFrom).toISOString(),
            notAfter: new Date(cert.validTo).toISOString(),
            fingerprint: cert.fingerprint256 ? cert.fingerprint256.slice(0, 23) : null
          });
        } catch (e) {
          // Skip unparseable/intermediate certs in the chain.
        }
      }
    }
    // Dedupe by domain, keep the cert with the latest expiry. Only return leaf
    // certificates (those with hostname SANs) — full chains on disk also embed
    // the Let's Encrypt intermediate/root certs which aren't user-relevant.
    const byDomain = {};
    for (const c of certificates) {
      if (!c.sans || c.sans.length === 0) continue; // skip intermediate/root certs
      const k = c.domain;
      if (!byDomain[k] || new Date(c.notAfter) > new Date(byDomain[k].notAfter)) byDomain[k] = c;
    }
    res.json(Object.values(byDomain).sort((a, b) => new Date(a.notAfter) - new Date(b.notAfter)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/domains', requireAuth, async (req, res) => {
  try {
    const caddyApiUrl = process.env.CADDY_API_URL || 'http://caddy:2019';
    const fetch = require('node-fetch');

    const routesRes = await fetch(`${caddyApiUrl}/config/apps/http/servers/srv0/routes`);
    const routes = await routesRes.json();

    // Index running agent containers once for O(1) lookups + live status.
    const containers = await docker.listContainers({ all: true }).catch(() => []);
    const byName = {};
    for (const c of containers) {
      for (const n of (c.Names || [])) byName[n.replace(/^\//, '')] = c;
    }

    const domains = routes
      .filter(r => r['@id'] && r['@id'].startsWith('agent-'))
      .map(r => {
        const host = r.match?.[0]?.host?.[0] || 'unknown';
        const upstream = r.handle?.[0]?.upstreams?.[0]?.dial || 'unknown';
        const [container, port] = upstream.split(':');
        const live = byName[container];
        const agent = db.prepare('SELECT name, runtime, status FROM agents WHERE domain = ?').get(host);
        return {
          id: r['@id'],
          domain: host,
          container,
          port,
          url: `https://${host}`,
          agentName: agent?.name || (live ? '(external container)' : '(orphaned route)'),
          runtime: agent?.runtime || 'external',
          status: live ? (live.State === 'running' ? 'running' : live.State) : 'orphaned',
          orphaned: !live
        };
      });

    const panelRoute = routes.find(r => r['@id'] === 'panel-route');
    if (panelRoute) {
      const panelHost = panelRoute.match?.[0]?.host?.[0] || 'panel';
      domains.unshift({
        id: 'panel-route',
        domain: panelHost,
        container: 'agentpanel-frontend',
        port: '80',
        url: `https://${panelHost}`,
        agentName: 'AgentPanel',
        runtime: 'panel',
        status: 'running',
        orphaned: false
      });
    }

    res.json(domains);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove a Caddy route by its @id. Used to clean up orphaned/stale domain
// routes whose backing container no longer exists. Refuses to touch panel-route.
app.delete('/api/domains/:id', requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    if (!id.startsWith('agent-')) return res.status(400).json({ error: 'Can only remove agent routes' });
    const caddyApiUrl = process.env.CADDY_API_URL || 'http://caddy:2019';
    const fetch = require('node-fetch');
    const del = await fetch(`${caddyApiUrl}/id/${id}`, { method: 'DELETE' });
    if (!del.ok) return res.status(502).json({ error: `Caddy responded ${del.status}` });
    res.json({ deleted: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/profile', requireAuth, (req, res) => {
  const email = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_email');
  res.json({ email: email?.value || 'admin@example.com' });
});

app.put('/api/profile/email', requireAuth, (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    const storedHash = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password_hash');
    const storedSalt = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password_salt');
    
    const hash = hashPassword(password, storedSalt.value);
    if (hash !== storedHash.value) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(email, 'admin_email');
    res.json({ success: true, email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/profile/password', requireAuth, (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password required' });
    }
    
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    
    const storedHash = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password_hash');
    const storedSalt = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password_salt');
    
    const currentHash = hashPassword(currentPassword, storedSalt.value);
    if (currentHash !== storedHash.value) {
      return res.status(401).json({ error: 'Invalid current password' });
    }
    
    const newSalt = crypto.randomBytes(16).toString('hex');
    const newHash = hashPassword(newPassword, newSalt);
    
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(newHash, 'admin_password_hash');
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(newSalt, 'admin_password_salt');
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/system/version', requireAuth, (req, res) => {
  try {
    const commit = process.env.GIT_COMMIT || 'unknown';
    const version = process.env.GIT_VERSION || commit;
    res.json({ version, commit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/system/check-update', requireAuth, async (req, res) => {
  try {
    const currentCommit = process.env.GIT_COMMIT || 'unknown';
    
    const fetch = require('node-fetch');
    const githubRes = await fetch('https://api.github.com/repos/magnusfroste/agentpanel/commits/main');
    const githubData = await githubRes.json();
    
    // GitHub returns an error object (e.g. rate limit) without a sha — don't crash.
    if (!githubData || !githubData.sha) {
      return res.json({
        hasUpdate: false,
        currentVersion: currentCommit.substring(0, 7),
        error: githubData?.message || 'Could not fetch latest commit from GitHub'
      });
    }
    
    const latestCommit = githubData.sha.substring(0, 7);
    const hasUpdate = currentCommit !== 'unknown' && currentCommit !== latestCommit;
    
    res.json({
      hasUpdate,
      currentVersion: currentCommit.substring(0, 7),
      latestVersion: latestCommit,
      remoteCommit: latestCommit
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/system/upgrade', requireAuth, async (req, res) => {
  // No .git or docker-compose.yml exists inside the container.
  res.status(501).json({ error: 'Upgrading AgentPanel must be done on the host via ssh: git pull && docker compose build && docker compose up -d' });
});

app.get('/api/system/ip', requireAuth, async (req, res) => {
  try {
    const fetch = require('node-fetch');
    const response = await fetch('https://api.ipify.org?format=json');
    const data = await response.json();
    res.json({ ip: data.ip });
  } catch (err) {
    try {
      const ip = execSync("hostname -I | awk '{print $1}'").toString().trim();
      res.json({ ip });
    } catch (err2) {
      res.status(500).json({ error: 'Could not determine IP address' });
    }
  }
});

// Uptime monitoring: probe every running agent with a domain every 60s, keep
// 7 days of history, and log agent.down/agent.up events on state transitions
// only (uptimeState tracks the last known ok-state per agent).
const uptimeState = new Map();

async function runUptimeChecks() {
  const fetch = require('node-fetch');
  const agents = db.prepare(
    "SELECT id, name, domain FROM agents WHERE domain IS NOT NULL AND domain != '' AND status = 'running'"
  ).all();

  for (const agent of agents) {
    const started = Date.now();
    let ok = 0;
    let statusCode = null;
    try {
      const res = await fetch(`https://${agent.domain}`, { timeout: 10000, redirect: 'manual' });
      statusCode = res.status;
      ok = res.status < 500 ? 1 : 0;
    } catch (err) {
      // Network failure / timeout — unreachable.
    }
    const latency = Date.now() - started;

    try {
      db.prepare('INSERT INTO uptime_checks (agent_id, ok, status_code, latency_ms) VALUES (?, ?, ?, ?)')
        .run(agent.id, ok, statusCode, latency);

      const isUp = ok === 1;
      const prev = uptimeState.get(agent.id);
      if (prev === undefined) {
        uptimeState.set(agent.id, isUp);
      } else if (prev !== isUp) {
        uptimeState.set(agent.id, isUp);
        logEvent(
          isUp ? 'agent.up' : 'agent.down',
          agent.id,
          isUp ? `Agent ${agent.name} is back up` : `Agent ${agent.name} is down (${statusCode ?? 'unreachable'})`
        );
      }
    } catch (err) {
      console.error(`[Uptime] Failed to record check for ${agent.name}:`, err.message);
    }
  }

  // Prune history older than 7 days.
  db.prepare("DELETE FROM uptime_checks WHERE checked_at < datetime('now', '-7 days')").run();
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`AgentPanel backend running on port ${PORT}`);
  await initPanelRoute();
  setInterval(() => {
    runUptimeChecks().catch(err => console.error('[Uptime] Error:', err.message));
  }, 60 * 1000);
  console.log('[Uptime] Monitoring enabled (60s interval)');
});

async function initPanelRoute() {
  try {
    const caddyApiUrl = process.env.CADDY_API_URL || 'http://caddy:2019';
    const fetch = require('node-fetch');
    
    const panelDomain = db.prepare('SELECT value FROM settings WHERE key = ?').get('panel_domain');
    
    // Check if panel-route already exists with correct domain
    const routesRes = await fetch(`${caddyApiUrl}/config/apps/http/servers/srv0/routes`);
    if (routesRes.ok) {
      const routes = await routesRes.json();
      const panelRoute = routes.find(r => r['@id'] === 'panel-route');
      
      if (panelRoute) {
        const existingDomain = panelRoute.match?.[0]?.host?.[0];
        const expectedDomain = panelDomain?.value || null;
        
        if (existingDomain === expectedDomain) {
          console.log(`Panel route already exists for ${existingDomain || 'catch-all'}`);
          return;
        }
        
        // Domain changed, remove old route
        console.log(`Panel domain changed from ${existingDomain} to ${expectedDomain}, updating...`);
        try {
          await fetch(`${caddyApiUrl}/id/panel-route`, { method: 'DELETE' });
        } catch (e) { /* ignore */ }
      }
    }
    
    if (panelDomain?.value) {
      await updatePanelCaddyRoute(null, panelDomain.value);
      console.log(`Panel route created for ${panelDomain.value}`);
    } else {
      await fetch(`${caddyApiUrl}/config/apps/http/servers/srv0/routes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPanelRoute(null))
      });
      console.log('Panel catch-all route created (no domain configured)');
    }
  } catch (err) {
    console.error('Failed to init panel route:', err);
  }
}

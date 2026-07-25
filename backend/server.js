require('dotenv').config();
const express = require('express');
const cors = require('cors');
const expressWs = require('express-ws');
const Database = require('better-sqlite3');
const Docker = require('dockerode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const tar = require('tar-fs');

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
  res.json(settings);
});

app.put('/api/settings', requireAuth, async (req, res) => {
  try {
    let domainChanged = false;
    let newDomain = null;
    let oldDomain = null;

    for (const [key, value] of Object.entries(req.body)) {
      if (['admin_password_hash', 'admin_password_salt', 'auth_token'].includes(key)) continue;
      
      if (key === 'panel_domain') {
        const existing = db.prepare('SELECT value FROM settings WHERE key = ?').get('panel_domain');
        oldDomain = existing?.value || null;
        newDomain = value || null;
        if (oldDomain !== newDomain) domainChanged = true;
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
    
    const volumesPrune = await docker.pruneVolumes();
    results.volumes = volumesPrune.VolumesDeleted || [];
    results.volumesSpaceReclaimed = volumesPrune.SpaceReclaimed || 0;
    
    const totalReclaimed = (results.containersSpaceReclaimed || 0) + 
                           (results.imagesSpaceReclaimed || 0) + 
                           (results.volumesSpaceReclaimed || 0);
    
    res.json({
      success: true,
      results,
      totalSpaceReclaimed: totalReclaimed,
      totalSpaceReclaimedMB: (totalReclaimed / 1024 / 1024).toFixed(2)
    });
  } catch (err) {
    console.error('Docker prune error:', err);
    res.status(500).json({ error: err.message });
  }
});

function readProcStat() {
  const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
  const vals = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = vals[3] + (vals[4] || 0);
  const total = vals.reduce((a, b) => a + b, 0);
  return { idle, total };
}

app.get('/api/system/stats', requireAuth, async (req, res) => {
  try {
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
      const { execSync } = require('child_process');
      const dfLine = execSync('df -B1 / 2>/dev/null | tail -1').toString().trim().split(/\s+/);
      diskTotal = parseInt(dfLine[1]) || 1;
      diskUsed = parseInt(dfLine[2]) || 0;
    } catch {}

    res.json({
      cpu: { pct: cpuPct },
      mem: { used: memUsed, total: memTotal, pct: Math.round(memUsed / memTotal * 100) },
      disk: { used: diskUsed, total: diskTotal, pct: Math.round(diskUsed / diskTotal * 100) }
    });
  } catch (err) {
    console.error('System stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

async function updatePanelCaddyRoute(oldDomain, newDomain) {
  const caddyApiUrl = process.env.CADDY_API_URL || 'http://caddy:2019';
  const fetch = require('node-fetch');

  if (oldDomain) {
    try {
      await fetch(`${caddyApiUrl}/id/panel-route`, { method: 'DELETE' });
    } catch (e) { /* ignore */ }
  }

  if (newDomain) {
    const route = {
      '@id': 'panel-route',
      match: [{ host: [newDomain] }],
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
            handle: [{
              handler: 'reverse_proxy',
              upstreams: [{ dial: 'frontend:80' }]
            }]
          }
        ]
      }]
    };

    const res = await fetch(`${caddyApiUrl}/config/apps/http/servers/srv0/routes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(route)
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to update Caddy panel route: ${err}`);
    }

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

const runtimes = {
  hermes: require('./plugins/hermes'),
  openclaw: require('./plugins/openclaw'),
  odysseus: require('./plugins/odysseus'),
  'docker-app': require('./plugins/docker-app')
};

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
  try {
    const { name, runtime, domain, image, port, config } = req.body;
    const plugin = runtimes[runtime];
    if (!plugin) return res.status(400).json({ error: `Unknown runtime: ${runtime}` });

    const id = `${runtime}-${name}-${Date.now()}`;
    const agentConfig = plugin.buildConfig({ name, domain, image, port, config });

    db.prepare(`
      INSERT INTO agents (id, name, runtime, domain, image, port, config, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'creating')
    `).run(id, name, runtime, domain, image || plugin.defaultImage, port || plugin.defaultPort, JSON.stringify(agentConfig));

    await deployAgent(id, name, runtime, domain, image || plugin.defaultImage, port || plugin.defaultPort, agentConfig, plugin);

    db.prepare("UPDATE agents SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    res.json({ id, name, status: 'running' });
  } catch (err) {
    console.error('Create agent error:', err);
    if (req.body.name) {
      const id = `${req.body.runtime}-${req.body.name}`;
      db.prepare('DELETE FROM agents WHERE id LIKE ?').run(`${id}%`);
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
    const existingImage = await docker.getImage(baseImage).get().catch(() => null);
    
    if (!existingImage) {
      const dockerfilePath = path.join('/templates', runtime, 'Dockerfile');
      if (fs.existsSync(dockerfilePath)) {
        const buildContext = path.join('/templates', runtime);
        const tarStream = tar.pack(buildContext);
        const stream = await docker.buildImage(tarStream, { t: baseImage });
        await new Promise((resolve, reject) => {
          docker.modem.followProgress(stream, (err) => err ? reject(err) : resolve());
        });
        imageToRun = baseImage;
      }
    } else {
      imageToRun = baseImage;
    }
    
    const dockerfilePath = path.join('/templates', runtime, 'Dockerfile');
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
        const [hostPath, containerPath] = vol.split(':');
        if (hostPath && containerPath) {
          volumes.push(`agentpanel-${id}-${hostPath}:${containerPath}`);
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
      PortBindings: { [`${port}/tcp`]: [{ HostPort: '0' }] },
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

  if (domain) {
    containerConfig.Labels['agentpanel.domain'] = domain;
  }

  const container = await docker.createContainer(containerConfig);
  await container.start();

  if (domain) {
    await addCaddyRoute(domain, containerName, port);
  }
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

app.delete('/api/agents/:id', requireAuth, async (req, res) => {
  try {
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const container = docker.getContainer(`agentpanel-${req.params.id}`);
    try {
      await container.stop();
      await container.remove();
    } catch (e) { /* container may not exist */ }

    if (agent.domain) {
      await removeCaddyRoute(agent.domain);
    }

    db.prepare('DELETE FROM agents WHERE id = ?').run(req.params.id);
    res.json({ deleted: true });
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
    const container = docker.getContainer(`agentpanel-${req.params.id}`);
    try { await container.stop(); await container.remove(); } catch (e) {}

    if (agent.domain) {
      await removeCaddyRoute(agent.domain);
    }

    await deployAgent(agent.id, agent.name, agent.runtime, updatedDomain, agent.image, agent.port, updatedConfig, plugin);

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

    const container = docker.getContainer(`agentpanel-${req.params.id}`);
    try { await container.stop(); await container.remove(); } catch (e) {}

    if (agent.domain) {
      await removeCaddyRoute(agent.domain);
    }

    await deployAgent(agent.id, agent.name, agent.runtime, agent.domain, agent.image, agent.port, config, plugin);

    db.prepare("UPDATE agents SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
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
    res.type('text/plain').send(logs.toString());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.ws('/api/agents/:id/terminal', requireAuth, (ws, req) => {
  (async () => {
    try {
      const container = docker.getContainer(`agentpanel-${req.params.id}`);
      const exec = await container.exec({
        AttachStdin: true, AttachStdout: true, AttachStderr: true,
        Tty: true,
        Cmd: [process.env.DEFAULT_SHELL || '/bin/bash']
      });
      const stream = await exec.start({ Tty: true });
      stream.pipe(ws);
      ws.on('message', (msg) => stream.write(msg));
      ws.on('close', () => { try { stream.destroy(); } catch (e) {} });
    } catch (err) {
      ws.send(`Terminal error: ${err.message}`);
      ws.close();
    }
  })();
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

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`AgentPanel backend running on port ${PORT}`);
});

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const expressWs = require('express-ws');
const Database = require('better-sqlite3');
const Docker = require('dockerode');
const path = require('path');
const fs = require('fs');

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

const runtimes = {
  hermes: require('./plugins/hermes'),
  openclaw: require('./plugins/openclaw'),
  odysseus: require('./plugins/odysseus'),
  'docker-app': require('./plugins/docker-app')
};

app.get('/api/agents', (req, res) => {
  const agents = db.prepare('SELECT * FROM agents ORDER BY created_at DESC').all();
  res.json(agents.map(a => ({ ...a, config: JSON.parse(a.config || '{}') })));
});

app.get('/api/agents/:id', (req, res) => {
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json({ ...agent, config: JSON.parse(agent.config || '{}') });
});

app.post('/api/agents', async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});

async function deployAgent(id, name, runtime, domain, image, port, config, plugin) {
  const containerName = `agentpanel-${id}`;
  const dockerfilePath = path.join(__dirname, '..', 'templates', runtime, 'Dockerfile');
  const buildImage = `${runtime}-agentpanel:${name}`;

  if (fs.existsSync(dockerfilePath) && runtime !== 'docker-app') {
    const buildContext = path.join(__dirname, '..', 'templates', runtime);
    const stream = await docker.buildImage(buildContext, { t: buildImage });
    await new Promise((resolve, reject) => {
      docker.modem.followProgress(stream, (err) => err ? reject(err) : resolve());
    });
  } else {
    await docker.pull(image);
  }

  const imageToRun = (runtime !== 'docker-app' && fs.existsSync(dockerfilePath)) ? buildImage : image;
  const envVars = plugin.buildEnv(config);
  const containerConfig = {
    name: containerName,
    Image: imageToRun,
    Env: envVars,
    ExposedPorts: { [`${port}/tcp`]: {} },
    HostConfig: {
      PortBindings: { [`${port}/tcp`]: [{ HostPort: '0' }] },
      RestartPolicy: { Name: 'unless-stopped' },
      Binds: [
        `agentpanel-${id}-data:/data`,
        `agentpanel-${id}-config:/config`
      ]
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

app.delete('/api/agents/:id', async (req, res) => {
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

app.post('/api/agents/:id/redeploy', async (req, res) => {
  try {
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const config = JSON.parse(agent.config || '{}');
    const plugin = runtimes[agent.runtime];

    db.prepare("UPDATE agents SET status = 'redeploying', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);

    const container = docker.getContainer(`agentpanel-${req.params.id}`);
    try { await container.stop(); await container.remove(); } catch (e) {}

    await deployAgent(agent.id, agent.name, agent.runtime, agent.domain, agent.image, agent.port, config, plugin);

    db.prepare("UPDATE agents SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    res.json({ redeployed: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/agents/:id/logs', async (req, res) => {
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

app.ws('/api/agents/:id/terminal', (ws, req) => {
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

app.get('/api/runtimes', (req, res) => {
  res.json(Object.entries(runtimes).map(([key, plugin]) => ({
    id: key,
    name: plugin.name,
    description: plugin.description,
    defaultImage: plugin.defaultImage,
    defaultPort: plugin.defaultPort,
    configFields: plugin.configFields
  })));
});

app.get('/api/agents/:id/status', async (req, res) => {
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

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`AgentPanel backend running on port ${PORT}`);
});

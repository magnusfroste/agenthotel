const crypto = require('crypto');
const { injectProviderEnv } = require('./lib/providerEnv');
const { demuxDockerBuffer } = require('./lib/demux');
const {
  collectHostMetrics, collectDockerUsage, collectAgentStats, collectUptime, buildHealthReport
} = require('./lib/observability');
const { listTemplates, getTemplate, saveTemplate } = require('./lib/templates');

// An agent's stored config holds provider API keys verbatim. The MCP surface
// is readable by every connected agent, so keys must never travel over it —
// an operator who needs one reads it from the panel's Credentials tab.
const SECRET_FIELD = /key|token|secret|password/i;

function redactConfig(raw) {
  if (!raw) return raw;
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { return raw; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return raw;
  const safe = {};
  for (const [k, v] of Object.entries(parsed)) {
    safe[k] = SECRET_FIELD.test(k) && typeof v === 'string' && v ? '***redacted***' : v;
  }
  return JSON.stringify(safe);
}

function createMcpServer(db, docker, runtimes, deployAgent, removeCaddyRoute, extras = {}) {
  const MCP_VERSION = '2024-11-05';
  // pruneDocker is the same routine the REST endpoint and the daily job use,
  // so a cleanup triggered over MCP is logged and bounded identically.
  // removeAgentVolumes likewise mirrors DELETE /api/agents/:id — without it an
  // MCP delete left every named volume behind as an orphan.
  const { pruneDocker, removeAgentVolumes } = extras;

  const tools = {
    list_agents: {
      description: 'List all AI agents managed by AgentHotel',
      inputSchema: { type: 'object', properties: {} }
    },
    get_agent: {
      description: 'Get detailed information about a specific agent',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The agent ID' }
        },
        required: ['agent_id']
      }
    },
    create_agent: {
      description: 'Create and deploy a new AI agent',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Agent name (unique)' },
          runtime: { type: 'string', description: 'Runtime: openclaw, hermes, odysseus, docker-app, or compose' },
          domain: { type: 'string', description: 'Full domain for the agent (optional, e.g. hermes.example.com)' },
          image: { type: 'string', description: 'Docker image (optional, uses default)' },
          port: { type: 'integer', description: 'Port (optional, uses default)' },
          config: { type: 'object', description: 'Agent configuration (env vars, volumes, etc)' }
        },
        required: ['name', 'runtime']
      }
    },
    delete_agent: {
      description: 'Delete an agent and its container',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The agent ID to delete' }
        },
        required: ['agent_id']
      }
    },
    redeploy_agent: {
      description: 'Redeploy an agent with latest image',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The agent ID to redeploy' },
          rebuild: { type: 'boolean', description: 'Rebuild the runtime template image first, picking up edits to templates/<runtime>/Dockerfile (slower)' }
        },
        required: ['agent_id']
      }
    },
    set_agent_env: {
      description: "Set environment variables on an existing agent — the way to hand a guest already in its room a credential for a tool. create_agent takes config only at check-in; this updates it afterwards. Values are stored in the agent's config, so they are re-injected on every later redeploy and survive restarts, unlike a secret mentioned in an ask_agent message. Applied by redeploying the agent, which replaces its container: volume data persists but anything running in it stops, so set the variables before dispatching work, not during it. Pass null as a value to remove a variable. Returns variable names only, never their values",
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The agent ID' },
          env: { type: 'object', description: 'Variables to set, e.g. {"SOME_API_TOKEN": "abc123"}. A null value removes that variable' },
          apply: { type: 'boolean', description: 'Redeploy so the container picks the values up (default true). False stores them for the next redeploy without disturbing a running agent' }
        },
        required: ['agent_id', 'env']
      }
    },
    get_agent_logs: {
      description: 'Get logs from an agent container',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The agent ID' },
          tail: { type: 'integer', description: 'Number of lines (default: 100)' }
        },
        required: ['agent_id']
      }
    },
    system_status: {
      description: 'Get system information and resource usage',
      inputSchema: { type: 'object', properties: {} }
    },
    list_runtimes: {
      description: 'List available agent runtimes and their configuration',
      inputSchema: { type: 'object', properties: {} }
    },
    health_check: {
      description: 'One-call VPS health verdict: healthy/degraded/critical with ranked findings (disk, memory, CPU, per-agent state, uptime) and hints on which tool fixes each. Call this first when monitoring.',
      inputSchema: { type: 'object', properties: {} }
    },
    get_host_metrics: {
      description: 'Host CPU (percent, cores, load), memory (bytes used/available, swap) and root-disk usage of the VPS itself',
      inputSchema: { type: 'object', properties: {} }
    },
    get_agent_stats: {
      description: 'Live per-agent container stats: CPU percent, memory vs limit, network I/O, restart count and OOM-kill flag',
      inputSchema: { type: 'object', properties: {} }
    },
    get_uptime: {
      description: "Uptime rollup per agent from the panel's 60s probes: uptime percent, latency, recent failures",
      inputSchema: {
        type: 'object',
        properties: {
          hours: { type: 'integer', description: 'Window in hours (default 24, max 168)' }
        }
      }
    },
    get_docker_usage: {
      description: 'Docker disk accounting: images, containers, volumes and build cache with reclaimable bytes',
      inputSchema: { type: 'object', properties: {} }
    },
    get_events: {
      description: "Panel event log (agent lifecycle, alerts, cleanups). Filter by agent or type, newest first",
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Only events for this agent' },
          type: { type: 'string', description: "Event type prefix, e.g. 'agent.' or 'docker.'" },
          limit: { type: 'integer', description: 'Max rows (default 50, max 500)' }
        }
      }
    },
    run_cleanup: {
      description: 'Prune stopped containers, dangling images, unused networks and unused build cache. Never touches volumes. Returns what was reclaimed',
      inputSchema: { type: 'object', properties: {} }
    },
    ask_agent: {
      description: "Give a hosted agent a task and get its reply. This is the point of the hotel: check a guest in with create_agent, then hand it work. Set background true for jobs that outlive a request — the agent keeps working after this returns, and you read the outcome later with get_agent_logs",
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The agent ID' },
          message: { type: 'string', description: 'The task, in plain language' },
          background: { type: 'boolean', description: 'Return immediately and let the agent keep working (default false)' },
          timeout_ms: { type: 'integer', description: 'How long to wait for a reply when not backgrounded (default 180000, max 600000)' }
        },
        required: ['agent_id', 'message']
      }
    },
    exec_in_agent: {
      description: "Run a shell command INSIDE an agent's container and return its output — for checking an agent's own state, config and logs from the outside. Non-interactive: it runs, returns, and exits. This never touches the VPS host; use the panel's Server Console for that",
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The agent ID' },
          command: { type: 'string', description: 'Command line, run through /bin/sh -c inside the container' },
          timeout_ms: { type: 'integer', description: 'Give up after this long (default 60000, max 300000)' }
        },
        required: ['agent_id', 'command']
      }
    },
    list_templates: {
      description: 'List the template library — every deployable runtime with its category, tags and defaults',
      inputSchema: { type: 'object', properties: {} }
    },
    create_template: {
      description: 'Add a template to the library so it can be deployed later. Pure data: an image or a compose file plus env fields and presentation, deployed through an existing runtime. Use this when you find an agent or app worth trying — the operator reviews it in the library before anything runs',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Slug: lowercase letters, digits and hyphens, 3-40 chars' },
          name: { type: 'string', description: 'Display name' },
          description: { type: 'string', description: 'What it is and why someone would run it' },
          instructions: { type: 'string', description: 'What the operator must do after deploying' },
          category: { type: 'string', description: 'Grouping in the library, e.g. "AI Agent"' },
          icon: { type: 'string', description: 'zap | paw | bot | container | layers | boxes | server | database' },
          color: { type: 'string', description: 'Hex colour for the tile, e.g. "#8b5cf6"' },
          tags: { type: 'array', items: { type: 'string' } },
          links: {
            type: 'array',
            description: 'Upstream docs and homepage',
            items: { type: 'object', properties: { label: { type: 'string' }, url: { type: 'string' } } }
          },
          deploy: {
            type: 'object',
            description: 'How to run it. runtime "docker-app" needs image (and port); runtime "compose" needs compose',
            properties: {
              runtime: { type: 'string', description: '"docker-app" or "compose"' },
              image: { type: 'string', description: 'Full image reference, docker-app only' },
              port: { type: 'integer', description: 'Port the container listens on, docker-app only' },
              compose: { type: 'string', description: 'A complete docker-compose.yml, compose only' },
              env: {
                type: 'array',
                description: 'Fields the deploy form asks for',
                items: {
                  type: 'object',
                  properties: {
                    key: { type: 'string' },
                    label: { type: 'string' },
                    type: { type: 'string', description: 'text | password | number | textarea' },
                    required: { type: 'boolean' },
                    default: { type: 'string' },
                    description: { type: 'string' }
                  }
                }
              }
            },
            required: ['runtime']
          }
        },
        required: ['id', 'name', 'deploy']
      }
    },
    get_template: {
      description: 'Full detail for one template: description, post-deploy instructions, benefits, features, links and the config fields the deploy form expects. Use the template id as the runtime for create_agent',
      inputSchema: {
        type: 'object',
        properties: {
          template_id: { type: 'string', description: 'The template id, e.g. "hermes"' }
        },
        required: ['template_id']
      }
    }
  };

  async function handleToolCall(name, args) {
    switch (name) {
      case 'list_agents': {
        const agents = db.prepare('SELECT id, name, runtime, domain, image, port, status, config, created_at FROM agents').all()
          .map((a) => ({ ...a, config: redactConfig(a.config) }));
        return { content: [{ type: 'text', text: JSON.stringify(agents, null, 2) }] };
      }

      case 'get_agent': {
        const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(args.agent_id);
        if (!agent) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Agent not found' }) }], isError: true };
        return { content: [{ type: 'text', text: JSON.stringify({ ...agent, config: redactConfig(agent.config) }, null, 2) }] };
      }

      case 'create_agent': {
        const id = `${args.runtime}-${args.name}-${Date.now()}`;
        const plugin = runtimes[args.runtime];
        if (!plugin) return { content: [{ type: 'text', text: JSON.stringify({ error: `Unknown runtime: ${args.runtime}` }) }], isError: true };

        const image = args.image || plugin.defaultImage;
        const port = args.port || plugin.defaultPort;

        // Auto-inject API keys from providers + default models (shared with
        // server.js /api/agents via lib/providerEnv.js).
        const finalConfig = await injectProviderEnv(db, args.config, plugin);

        const agentConfig = plugin.buildConfig({ name: args.name, domain: args.domain, image, port, config: finalConfig });

        db.prepare('INSERT INTO agents (id, name, runtime, domain, image, port, status, config) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, args.name, args.runtime, args.domain || null, image, port, 'creating', JSON.stringify(agentConfig));

        try {
          if (args.runtime === 'compose') {
            await plugin.deploy(id, args.name, agentConfig, plugin);
          } else {
            await deployAgent(id, args.name, args.runtime, args.domain, image, port, agentConfig, plugin);
          }
          db.prepare("UPDATE agents SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
          return { content: [{ type: 'text', text: JSON.stringify({ success: true, agent_id: id, status: 'running' }) }] };
        } catch (err) {
          db.prepare("UPDATE agents SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
          return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
        }
      }

      case 'delete_agent': {
        const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(args.agent_id);
        if (!agent) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Agent not found' }) }], isError: true };

        if (agent.runtime === 'compose') {
          // Compose agents have no single container — tear the project down.
          const plugin = runtimes.compose;
          const config = JSON.parse(agent.config || '{}');
          try { await plugin.remove(agent.id, config); } catch (e) {}
        } else {
          try {
            const container = docker.getContainer(`agenthotel-${args.agent_id}`);
            // Same single forced removal as the REST delete. This path already
            // worked, because its stop and remove had separate catches — but two
            // paths doing teardown two ways is how they drift apart.
            try { await container.remove({ force: true }); } catch (e) {}
          } catch (e) {}
        }

        if (agent.domain) {
          try { await removeCaddyRoute(agent.domain); } catch (e) {}
        }

        // Same teardown as the REST delete: the agent's named volumes go with
        // it, otherwise deleting over MCP silently leaks gigabytes of state.
        if (removeAgentVolumes) {
          try { await removeAgentVolumes(args.agent_id); } catch (e) {
            console.error('[MCP] Volume cleanup failed for', args.agent_id, e.message);
          }
        }

        db.prepare('DELETE FROM agents WHERE id = ?').run(args.agent_id);
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, deleted: args.agent_id }) }] };
      }

      case 'set_agent_env': {
        const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(args.agent_id);
        if (!agent) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Agent not found' }) }], isError: true };

        const env = args.env;
        if (!env || typeof env !== 'object' || Array.isArray(env)) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'env must be an object of variable names to values' }) }], isError: true };
        }

        // Config keys are the container's environment, so a variable name has
        // to be one the shell can actually carry.
        const names = Object.keys(env);
        if (!names.length) return { content: [{ type: 'text', text: JSON.stringify({ error: 'env is empty' }) }], isError: true };
        const bad = names.filter(n => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
        if (bad.length) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: `Invalid variable names: ${bad.join(', ')}` }) }], isError: true };
        }

        const config = JSON.parse(agent.config || '{}');
        const set = [], removed = [];
        for (const [name, value] of Object.entries(env)) {
          if (value === null) { delete config[name]; removed.push(name); continue; }
          if (typeof value === 'object') {
            return { content: [{ type: 'text', text: JSON.stringify({ error: `Value for ${name} must be a string, number or boolean` }) }], isError: true };
          }
          config[name] = String(value);
          set.push(name);
        }

        // Names only. Echoing a secret back would write it into the calling
        // agent's transcript, which is the leak this tool exists to avoid.
        db.prepare('INSERT INTO events (type, agent_id, message) VALUES (?, ?, ?)')
          .run('agent.env', args.agent_id, `Environment updated: ${[...set, ...removed.map(n => '-' + n)].join(', ')}`);
        db.prepare('UPDATE agents SET config = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(config), args.agent_id);

        if (args.apply === false) {
          return { content: [{ type: 'text', text: JSON.stringify({ success: true, set, removed, applied: false, note: 'Stored — the container keeps its current environment until the next redeploy' }) }] };
        }

        const plugin = runtimes[agent.runtime];
        const deployConfig = await injectProviderEnv(db, config, plugin);
        db.prepare("UPDATE agents SET config = ?, status = 'redeploying', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(JSON.stringify(deployConfig), args.agent_id);

        try {
          if (agent.runtime === 'compose') {
            try { await plugin.stop(agent.id, deployConfig); } catch (e) {}
            await plugin.deploy(agent.id, agent.name, deployConfig, plugin);
          } else {
            const container = docker.getContainer(`agenthotel-${args.agent_id}`);
            try { await container.stop(); } catch (e) {}
            try { await container.remove({ force: true }); } catch (e) {}
            await deployAgent(agent.id, agent.name, agent.runtime, agent.domain, agent.image, agent.port, deployConfig, plugin);
          }
          db.prepare("UPDATE agents SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(args.agent_id);
          return { content: [{ type: 'text', text: JSON.stringify({ success: true, set, removed, applied: true, status: 'running' }) }] };
        } catch (err) {
          db.prepare("UPDATE agents SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(args.agent_id);
          return { content: [{ type: 'text', text: JSON.stringify({ error: err.message, set, removed, applied: false }) }], isError: true };
        }
      }

      case 'redeploy_agent': {
        const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(args.agent_id);
        if (!agent) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Agent not found' }) }], isError: true };

        const plugin = runtimes[agent.runtime];
        // Re-inject provider env, exactly as the REST redeploy does. Without
        // this the two paths disagreed: redeploying from the panel picked up
        // providers added since the agent was created, while redeploying over
        // MCP silently kept the old set — so a provider swapped on the panel
        // never reached an agent redeployed by an agent. Injection only fills
        // missing keys, so manual env edits are still never clobbered.
        const config = await injectProviderEnv(db, JSON.parse(agent.config || '{}'), plugin);
        db.prepare('UPDATE agents SET config = ? WHERE id = ?').run(JSON.stringify(config), args.agent_id);

        db.prepare("UPDATE agents SET status = 'redeploying', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(args.agent_id);

        try {
          if (agent.runtime === 'compose') {
            // Compose agents are managed via the compose plugin, not dockerode.
            try { await plugin.stop(agent.id, config); } catch (e) {}
            await plugin.deploy(agent.id, agent.name, config, plugin);
          } else {
            const container = docker.getContainer(`agenthotel-${args.agent_id}`);
            try { await container.stop(); } catch (e) {}
            try { await container.remove(); } catch (e) {}

            await deployAgent(agent.id, agent.name, agent.runtime, agent.domain, agent.image, agent.port, config, plugin, { rebuildImage: args.rebuild === true });
          }
          db.prepare("UPDATE agents SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(args.agent_id);
          return { content: [{ type: 'text', text: JSON.stringify({ success: true, agent_id: args.agent_id, status: 'running' }) }] };
        } catch (err) {
          db.prepare("UPDATE agents SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(args.agent_id);
          return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
        }
      }

      case 'get_agent_logs': {
        try {
          const container = docker.getContainer(`agenthotel-${args.agent_id}`);
          const logs = await container.logs({ stdout: true, stderr: true, tail: args.tail || 100 });
          // Containers run without a TTY — strip the 8-byte multiplex headers.
          return { content: [{ type: 'text', text: demuxDockerBuffer(logs).toString('utf8') }] };
        } catch (err) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
        }
      }

      case 'system_status': {
        const { execSync } = require('child_process');
        const agents = db.prepare('SELECT id, name, runtime, status FROM agents').all();
        const hostname = execSync('hostname').toString().trim();
        const uptime = execSync('uptime').toString().trim();
        const dockerVersion = execSync('docker --version').toString().trim();
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ hostname, uptime, dockerVersion, agents }, null, 2)
          }]
        };
      }

      case 'health_check': {
        // Sequential on purpose: agent stats and host CPU sampling both cost
        // a few hundred ms; running them together skews the CPU numbers.
        const host = await collectHostMetrics();
        const dockerUsage = await collectDockerUsage(docker);
        const agentStats = await collectAgentStats(docker, db);
        const uptime = collectUptime(db, 24);
        const expectedAgents = db.prepare('SELECT COUNT(*) AS n FROM agents').get().n;
        const report = buildHealthReport({ host, dockerUsage, agentStats, uptime, expectedAgents });
        return { content: [{ type: 'text', text: JSON.stringify({ ...report, host, agents: agentStats }, null, 2) }] };
      }

      case 'get_host_metrics': {
        return { content: [{ type: 'text', text: JSON.stringify(await collectHostMetrics(), null, 2) }] };
      }

      case 'get_agent_stats': {
        return { content: [{ type: 'text', text: JSON.stringify(await collectAgentStats(docker, db), null, 2) }] };
      }

      case 'get_uptime': {
        const hours = Math.min(Math.max(parseInt(args?.hours, 10) || 24, 1), 168);
        return { content: [{ type: 'text', text: JSON.stringify(collectUptime(db, hours), null, 2) }] };
      }

      case 'get_docker_usage': {
        return { content: [{ type: 'text', text: JSON.stringify(await collectDockerUsage(docker), null, 2) }] };
      }

      case 'get_events': {
        const limit = Math.min(Math.max(parseInt(args?.limit, 10) || 50, 1), 500);
        const conds = [];
        const params = [];
        if (args?.agent_id) { conds.push('agent_id = ?'); params.push(args.agent_id); }
        if (args?.type) { conds.push("type LIKE ? || '%'"); params.push(args.type); }
        const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
        const rows = db.prepare(`SELECT ts, type, agent_id, message FROM events ${where} ORDER BY id DESC LIMIT ?`).all(...params, limit);
        return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
      }

      case 'run_cleanup': {
        if (!pruneDocker) return { content: [{ type: 'text', text: JSON.stringify({ error: 'cleanup not available' }) }], isError: true };
        const results = await pruneDocker();
        db.prepare(`
          INSERT INTO cleanup_logs (success, containers_deleted, images_deleted, networks_deleted, volumes_deleted, space_reclaimed)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(1, results.containers.length, results.images.length, results.networks.length, 0, results.totalSpaceReclaimed);
        db.prepare('INSERT INTO events (type, agent_id, message) VALUES (?, ?, ?)')
          .run('docker.cleanup', null, `MCP cleanup reclaimed ${(results.totalSpaceReclaimed / 1024 / 1024).toFixed(2)} MB`);
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
      }

      case 'list_runtimes': {
        const runtimeList = Object.entries(runtimes).map(([key, plugin]) => ({
          id: key,
          name: plugin.name,
          description: plugin.description,
          defaultImage: plugin.defaultImage,
          defaultPort: plugin.defaultPort,
          configFields: plugin.configFields
        }));
        return { content: [{ type: 'text', text: JSON.stringify(runtimeList, null, 2) }] };
      }

      case 'ask_agent': {
        const agent = db.prepare('SELECT id, name, runtime FROM agents WHERE id = ?').get(args.agent_id);
        if (!agent) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'Agent not found' }) }], isError: true };
        }
        const plugin = runtimes[agent.runtime];
        // The runtime declares how it is spoken to; a runtime that declares
        // nothing is not addressable this way, and says so rather than having
        // the caller guess at a CLI.
        if (!plugin || typeof plugin.dispatch !== 'function') {
          return { content: [{ type: 'text', text: JSON.stringify({
            error: `The ${agent.runtime} runtime has no dispatch interface — talk to it through its own UI, or use exec_in_agent`
          }) }], isError: true };
        }
        const message = String(args.message || '').trim();
        if (!message) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'message is required' }) }], isError: true };
        }

        try {
          const container = docker.getContainer(`agenthotel-${agent.id}`);
          const info = await container.inspect().catch(() => null);
          if (!info || !info.State.Running) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: 'Agent is not running' }) }], isError: true };
          }

          // argv, not a shell string: the message is arbitrary text and must
          // never be parsed as shell.
          const cmd = plugin.dispatch(message);
          const runAs = plugin.terminalUser;
          const exec = await container.exec({
            Cmd: cmd,
            AttachStdout: !args.background, AttachStderr: !args.background,
            Tty: false,
            ...(runAs ? { User: runAs } : {})
          });

          db.prepare('INSERT INTO events (type, agent_id, message) VALUES (?, ?, ?)')
            .run('agent.task', agent.id, `Task sent over MCP: ${message.slice(0, 120)}`);

          if (args.background) {
            // Detached: the agent keeps working after this returns. Its output
            // goes to the container log, which get_agent_logs reads.
            const stream = await exec.start({ Detach: true });
            try { stream.destroy(); } catch (_) {}
            return { content: [{ type: 'text', text: JSON.stringify({
              dispatched: true, agent: agent.name,
              note: 'Running in the background — read the outcome with get_agent_logs'
            }, null, 2) }] };
          }

          const timeoutMs = Math.min(parseInt(args.timeout_ms) || 180000, 600000);
          const stream = await exec.start({ Tty: false });
          const chunks = [];
          let size = 0;
          const CAP = 256 * 1024;
          const how = await new Promise((resolve) => {
            const timer = setTimeout(() => { try { stream.destroy(); } catch (_) {} resolve('timeout'); }, timeoutMs);
            stream.on('data', (c) => { if (size < CAP) { chunks.push(c); size += c.length; } });
            stream.on('end', () => { clearTimeout(timer); resolve('end'); });
            stream.on('error', () => { clearTimeout(timer); resolve('error'); });
          });
          const details = await exec.inspect().catch(() => ({}));
          return { content: [{ type: 'text', text: JSON.stringify({
            agent: agent.name,
            exitCode: details.ExitCode ?? null,
            timedOut: how === 'timeout',
            truncated: size >= CAP,
            reply: demuxDockerBuffer(Buffer.concat(chunks)).toString('utf8').trim()
          }, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
        }
      }

      case 'exec_in_agent': {
        const agent = db.prepare('SELECT id, runtime FROM agents WHERE id = ?').get(args.agent_id);
        if (!agent) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'Agent not found' }) }], isError: true };
        }
        const command = String(args.command || '').trim();
        if (!command) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'command is required' }) }], isError: true };
        }
        const timeoutMs = Math.min(parseInt(args.timeout_ms) || 60000, 300000);

        try {
          const container = docker.getContainer(`agenthotel-${agent.id}`);
          const info = await container.inspect().catch(() => null);
          if (!info || !info.State.Running) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: 'Agent is not running' }) }], isError: true };
          }

          // Run as the runtime's own user where it declares one. OpenClaw's
          // state volumes belong to `node`; a root shell there leaves
          // root-owned files it can no longer write.
          const runAs = runtimes[agent.runtime]?.terminalUser;
          const exec = await container.exec({
            Cmd: ['/bin/sh', '-c', command],
            AttachStdout: true, AttachStderr: true, Tty: false,
            ...(runAs ? { User: runAs } : {})
          });
          const stream = await exec.start({ Tty: false });

          const chunks = [];
          let size = 0;
          const OUTPUT_CAP = 256 * 1024; // a runaway command must not flood the caller
          const output = await new Promise((resolve) => {
            const done = (reason) => resolve(reason);
            const timer = setTimeout(() => { try { stream.destroy(); } catch (_) {} done('timeout'); }, timeoutMs);
            stream.on('data', (c) => {
              if (size < OUTPUT_CAP) { chunks.push(c); size += c.length; }
            });
            stream.on('end', () => { clearTimeout(timer); done('end'); });
            stream.on('error', () => { clearTimeout(timer); done('error'); });
          });

          const details = await exec.inspect().catch(() => ({}));
          const text = demuxDockerBuffer(Buffer.concat(chunks)).toString('utf8');
          db.prepare('INSERT INTO events (type, agent_id, message) VALUES (?, ?, ?)')
            .run('agent.exec', agent.id, `Ran over MCP: ${command.slice(0, 120)}`);

          return { content: [{ type: 'text', text: JSON.stringify({
            exitCode: details.ExitCode ?? null,
            timedOut: output === 'timeout',
            truncated: size >= OUTPUT_CAP,
            output: text
          }, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
        }
      }

      case 'list_templates': {
        return { content: [{ type: 'text', text: JSON.stringify(listTemplates(runtimes), null, 2) }] };
      }

      case 'create_template': {
        try {
          // Marked source: 'mcp' so the library can show who wrote it. The data
          // is equally inert whoever did, but an operator deserves to know.
          const id = saveTemplate(args, runtimes, 'mcp');
          db.prepare('INSERT INTO events (type, agent_id, message) VALUES (?, ?, ?)')
            .run('template.create', null, `Created template ${id} (mcp)`);
          return { content: [{ type: 'text', text: JSON.stringify(getTemplate(id, runtimes), null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
        }
      }

      case 'get_template': {
        const template = getTemplate(args.template_id, runtimes);
        if (!template) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: `Unknown template: ${args.template_id}` }) }], isError: true };
        }
        return { content: [{ type: 'text', text: JSON.stringify(template, null, 2) }] };
      }

      default:
        return { content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }], isError: true };
    }
  }

  async function handleMcpRequest(req, res) {
    const { method, params, id } = req.body;

    try {
      let result;

      switch (method) {
        case 'initialize':
          result = {
            protocolVersion: MCP_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'agenthotel', version: '1.0.0' }
          };
          break;

        case 'notifications/initialized':
          return res.status(204).send();

        case 'tools/list':
          result = { tools };
          break;

        case 'tools/call': {
          const { name, arguments: args } = params;
          result = await handleToolCall(name, args || {});
          break;
        }

        default:
          return res.json({ jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' }, id });
      }

      res.json({ jsonrpc: '2.0', result, id });
    } catch (err) {
      res.json({ jsonrpc: '2.0', error: { code: -32603, message: err.message }, id });
    }
  }

  function requireMcpAuth(req, res, next) {
    // The endpoint used to be mounted unconditionally, so it answered from the
    // moment the panel had an admin account — the "Enable MCP" button only wrote
    // a file the status page read back. The switch displayed a state it did not
    // control. It gates the surface now, which matters because these tools create
    // and delete agents on a host where the panel is root-equivalent.
    const mcpOn = db.prepare("SELECT value FROM settings WHERE key = 'mcp_enabled'").get();
    if (!mcpOn || mcpOn.value !== 'true') {
      return res.status(403).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: "MCP is disabled — enable it on the panel's System page" },
        id: null
      });
    }

    const authHeader = req.headers.authorization;
    const queryToken = req.query.token;
    
    const settings = {};
    db.prepare('SELECT key, value FROM settings').all().forEach(r => settings[r.key] = r.value);
    const expectedToken = settings.auth_token;

    const providedToken = authHeader?.startsWith('Bearer ') 
      ? authHeader.slice(7) 
      : queryToken;

    if (!expectedToken || providedToken !== expectedToken) {
      return res.status(401).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Unauthorized' }, id: null });
    }

    next();
  }

  return { handleMcpRequest, requireMcpAuth, tools };
}

module.exports = { createMcpServer };

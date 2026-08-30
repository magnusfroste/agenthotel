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

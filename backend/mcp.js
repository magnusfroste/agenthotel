const crypto = require('crypto');

function createMcpServer(db, docker, runtimes, deployAgent, removeCaddyRoute) {
  const MCP_VERSION = '2024-11-05';

  const tools = {
    list_agents: {
      description: 'List all AI agents managed by AgentPanel',
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
          agent_id: { type: 'string', description: 'The agent ID to redeploy' }
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
    }
  };

  async function handleToolCall(name, args) {
    switch (name) {
      case 'list_agents': {
        const agents = db.prepare('SELECT id, name, runtime, domain, image, port, status, config, created_at FROM agents').all();
        return { content: [{ type: 'text', text: JSON.stringify(agents, null, 2) }] };
      }

      case 'get_agent': {
        const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(args.agent_id);
        if (!agent) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Agent not found' }) }], isError: true };
        return { content: [{ type: 'text', text: JSON.stringify(agent, null, 2) }] };
      }

      case 'create_agent': {
        const id = `${args.runtime}-${args.name}-${Date.now()}`;
        const plugin = runtimes[args.runtime];
        if (!plugin) return { content: [{ type: 'text', text: JSON.stringify({ error: `Unknown runtime: ${args.runtime}` }) }], isError: true };

        const image = args.image || plugin.defaultImage;
        const port = args.port || plugin.defaultPort;

        // Auto-inject API keys from providers, mapped by provider NAME (not type).
        // Keep this in sync with the provider injection in server.js /api/agents.
        const PROVIDER_ENV_MAP = {
          openai: { key: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
          openrouter: { key: 'OPENROUTER_API_KEY' },
          anthropic: { key: 'ANTHROPIC_API_KEY' },
          gemini: { key: 'GEMINI_API_KEY' },
          deepseek: { key: 'DEEPSEEK_API_KEY' },
          groq: { key: 'GROQ_API_KEY' },
          xai: { key: 'XAI_API_KEY' },
          mistral: { key: 'MISTRAL_API_KEY' }
        };
        const finalConfig = { ...(args.config || {}) };
        const providers = db.prepare('SELECT name, type, apiKey, baseUrl FROM providers').all();
        for (const provider of providers) {
          const slug = provider.name.toLowerCase().replace(/[^a-z0-9]/g, '');
          const mapping = PROVIDER_ENV_MAP[slug];
          if (mapping) {
            if (!finalConfig[mapping.key] && provider.apiKey) finalConfig[mapping.key] = provider.apiKey;
            if (mapping.baseUrl && !finalConfig[mapping.baseUrl] && provider.baseUrl) {
              finalConfig[mapping.baseUrl] = provider.baseUrl;
            }
          } else if (provider.type === 'openai' && provider.apiKey) {
            // Custom OpenAI-compatible provider (e.g. vLLM, DGX1).
            if (!finalConfig.OPENAI_API_KEY) finalConfig.OPENAI_API_KEY = provider.apiKey;
            if (!finalConfig.OPENAI_BASE_URL && provider.baseUrl) finalConfig.OPENAI_BASE_URL = provider.baseUrl;
          }
        }

        // Set default model if not specified and a provider key is available.
        // Hermes needs a model that accepts reasoning.effort; gpt-5.4 works.
        if (!finalConfig.OPENCLAW_MODEL_PRIMARY && !finalConfig.HERMES_MODEL) {
          if (finalConfig.OPENAI_API_KEY) {
            finalConfig.OPENCLAW_MODEL_PRIMARY = 'openai/gpt-4o';
            finalConfig.HERMES_MODEL = 'openai/gpt-5.4';
          } else if (finalConfig.OPENROUTER_API_KEY) {
            finalConfig.OPENCLAW_MODEL_PRIMARY = 'openrouter/openai/gpt-4o';
            finalConfig.HERMES_MODEL = 'openrouter/openai/gpt-5.4';
          }
        }

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

        try {
          const container = docker.getContainer(`agentpanel-${args.agent_id}`);
          try { await container.stop(); } catch (e) {}
          try { await container.remove(); } catch (e) {}
        } catch (e) {}

        if (agent.domain) {
          try { await removeCaddyRoute(agent.domain); } catch (e) {}
        }

        db.prepare('DELETE FROM agents WHERE id = ?').run(args.agent_id);
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, deleted: args.agent_id }) }] };
      }

      case 'redeploy_agent': {
        const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(args.agent_id);
        if (!agent) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Agent not found' }) }], isError: true };

        const plugin = runtimes[agent.runtime];
        const config = JSON.parse(agent.config || '{}');

        db.prepare("UPDATE agents SET status = 'redeploying', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(args.agent_id);

        try {
          const container = docker.getContainer(`agentpanel-${args.agent_id}`);
          try { await container.stop(); } catch (e) {}
          try { await container.remove(); } catch (e) {}

          await deployAgent(agent.id, agent.name, agent.runtime, agent.domain, agent.image, agent.port, config, plugin);
          db.prepare("UPDATE agents SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(args.agent_id);
          return { content: [{ type: 'text', text: JSON.stringify({ success: true, agent_id: args.agent_id, status: 'running' }) }] };
        } catch (err) {
          db.prepare("UPDATE agents SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(args.agent_id);
          return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
        }
      }

      case 'get_agent_logs': {
        try {
          const container = docker.getContainer(`agentpanel-${args.agent_id}`);
          const logs = await container.logs({ stdout: true, stderr: true, tail: args.tail || 100 });
          return { content: [{ type: 'text', text: logs.toString() }] };
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
            serverInfo: { name: 'agentpanel', version: '1.0.0' }
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

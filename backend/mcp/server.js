import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const BACKEND_URL = process.env.AGENTHOTEL_URL || 'http://localhost:8080';
const AUTH_TOKEN = process.env.AGENTHOTEL_TOKEN;

async function apiRequest(path, method = 'GET', body = null) {
  const fetch = (await import('node-fetch')).default;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${AUTH_TOKEN}`
  };
  
  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);
  
  const res = await fetch(`${BACKEND_URL}${path}`, options);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API error: ${res.status} - ${err}`);
  }
  return res.json();
}

const server = new Server(
  {
    name: 'agenthotel-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'list_agents',
        description: 'List all agents in AgentHotel',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'create_agent',
        description: 'Create a new agent',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Agent name' },
            runtime: { type: 'string', description: 'Runtime (openclaw, hermes, odysseus, docker-app)' },
            domain: { type: 'string', description: 'Optional domain for the agent' },
            image: { type: 'string', description: 'Optional custom image' },
            port: { type: 'number', description: 'Optional custom port' },
            config: { type: 'object', description: 'Optional configuration object' },
          },
          required: ['name', 'runtime'],
        },
      },
      {
        name: 'delete_agent',
        description: 'Delete an agent',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Agent ID' },
          },
          required: ['id'],
        },
      },
      {
        name: 'get_agent_status',
        description: 'Get agent status and health',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Agent ID' },
          },
          required: ['id'],
        },
      },
      {
        name: 'get_agent_logs',
        description: 'Get agent logs',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Agent ID' },
            tail: { type: 'number', description: 'Number of lines to return (default: 100)' },
          },
          required: ['id'],
        },
      },
      {
        name: 'update_agent',
        description: 'Update agent configuration',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Agent ID' },
            config: { type: 'object', description: 'Configuration updates' },
            domain: { type: 'string', description: 'New domain' },
          },
          required: ['id'],
        },
      },
      {
        name: 'redeploy_agent',
        description: 'Redeploy an agent',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Agent ID' },
          },
          required: ['id'],
        },
      },
      {
        name: 'list_runtimes',
        description: 'List available runtimes and their configuration fields',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_settings',
        description: 'Get panel settings',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'update_settings',
        description: 'Update panel settings',
        inputSchema: {
          type: 'object',
          properties: {
            panel_domain: { type: 'string', description: 'Panel domain' },
          },
        },
      },
      {
        name: 'list_providers',
        description: 'List AI providers',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'create_provider',
        description: 'Create a new AI provider',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Provider name' },
            type: { type: 'string', description: 'Provider type (openai, anthropic, etc.)' },
            baseUrl: { type: 'string', description: 'Base URL for the provider API' },
            apiKey: { type: 'string', description: 'API key' },
            models: { type: 'array', description: 'List of available models' },
          },
          required: ['name', 'type'],
        },
      },
      {
        name: 'update_provider',
        description: 'Update an AI provider',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Provider ID' },
            name: { type: 'string', description: 'Provider name' },
            type: { type: 'string', description: 'Provider type' },
            baseUrl: { type: 'string', description: 'Base URL' },
            apiKey: { type: 'string', description: 'API key' },
            models: { type: 'array', description: 'List of models' },
          },
          required: ['id'],
        },
      },
      {
        name: 'delete_provider',
        description: 'Delete an AI provider',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Provider ID' },
          },
          required: ['id'],
        },
      },
      {
        name: 'docker_prune',
        description: 'Clean up unused Docker resources (containers, images, networks, volumes)',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_system_stats',
        description: 'Get system resource usage (CPU, memory, disk)',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      case 'list_agents':
        result = await apiRequest('/api/agents');
        break;

      case 'create_agent':
        result = await apiRequest('/api/agents', 'POST', args);
        break;

      case 'delete_agent':
        result = await apiRequest(`/api/agents/${args.id}`, 'DELETE');
        break;

      case 'get_agent_status':
        result = await apiRequest(`/api/agents/${args.id}/status`);
        break;

      case 'get_agent_logs':
        const tail = args.tail || 100;
        const fetch = (await import('node-fetch')).default;
        const res = await fetch(`${BACKEND_URL}/api/agents/${args.id}/logs?tail=${tail}`, {
          headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` }
        });
        result = { logs: await res.text() };
        break;

      case 'update_agent':
        result = await apiRequest(`/api/agents/${args.id}`, 'PUT', args);
        break;

      case 'redeploy_agent':
        result = await apiRequest(`/api/agents/${args.id}/redeploy`, 'POST');
        break;

      case 'list_runtimes':
        result = await apiRequest('/api/runtimes');
        break;

      case 'get_settings':
        result = await apiRequest('/api/settings');
        break;

      case 'update_settings':
        result = await apiRequest('/api/settings', 'PUT', args);
        break;

      case 'list_providers':
        result = await apiRequest('/api/providers');
        break;

      case 'create_provider':
        result = await apiRequest('/api/providers', 'POST', args);
        break;

      case 'update_provider':
        result = await apiRequest(`/api/providers/${args.id}`, 'PUT', args);
        break;

      case 'delete_provider':
        result = await apiRequest(`/api/providers/${args.id}`, 'DELETE');
        break;

      case 'docker_prune':
        result = await apiRequest('/api/docker/prune', 'POST');
        break;

      case 'get_system_stats':
        result = await apiRequest('/api/system/stats');
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('AgentHotel MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

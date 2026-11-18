const crypto = require('crypto');
const { injectProviderEnv } = require('./lib/providerEnv');
const { demuxDockerBuffer } = require('./lib/demux');
const { execInAgent } = require('./lib/agentExec');
const { containerNameFor } = require('./lib/containerFor');
const {
  collectHostMetrics, collectDockerUsage, collectAgentStats, collectUptime, buildHealthReport
} = require('./lib/observability');
const { listTemplates, getTemplate, saveTemplate, materializeDeploy } = require('./lib/templates');
const { domainProblem } = require('./lib/domainName');
const containerRuntime = require('./lib/containerRuntime');
const { createDomainCheck, parentOf } = require('./lib/domainCheck');

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

// What is wrong with a call's arguments, or null. A tool used to be handed
// whatever arrived: get_template called with `id` instead of `template_id`
// answered 'The "path" argument must be of type string', and a `PORT` sent
// beside `port` was dropped without a word. The caller is an agent reading the
// reply, so the reply names what the tool takes.
function argumentProblem(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'The arguments must be an object';
  const schema = tool.inputSchema || {};
  const known = Object.keys(schema.properties || {});
  const required = schema.required || [];
  const missing = required.filter(k => args[k] === undefined || args[k] === null || args[k] === '');
  const unknown = Object.keys(args).filter(k => !known.includes(k));
  if (!missing.length && !unknown.length) return null;
  const parts = [];
  if (missing.length) parts.push(`Missing: ${missing.join(', ')}`);
  if (unknown.length) parts.push(`Not an argument of this tool: ${unknown.join(', ')}`);
  parts.push(known.length
    ? `It takes: ${known.map(k => (required.includes(k) ? k : `${k} (optional)`)).join(', ')}`
    : 'It takes no arguments');
  return parts.join('. ');
}

// A deploy can take many minutes, and a request through a proxy does not live
// that long: Cloudflare cuts it at 100 s, and the agent's own client gave up
// at 90 (2026-11-14, a create waiting behind a nine-minute build). The call
// waits this long for the deploy and then answers that it is still going; the
// deploy carries on either way.
const DEFAULT_WAIT_SECONDS = 60;
const MAX_WAIT_SECONDS = 600;

function waitSeconds(value) {
  const n = Number(value);
  if (value === undefined || value === null || !Number.isFinite(n)) return DEFAULT_WAIT_SECONDS;
  return Math.min(Math.max(n, 0), MAX_WAIT_SECONDS);
}

// `run` resolves to the tool's result and never rejects. `pending` is the
// answer when it has not resolved in time.
async function settleWithin(run, seconds, pending) {
  let timer;
  const LATE = Symbol('late');
  const late = new Promise(resolve => { timer = setTimeout(() => resolve(LATE), seconds * 1000); });
  try {
    const first = await Promise.race([run, late]);
    return first === LATE ? pending() : first;
  } finally {
    clearTimeout(timer);
  }
}

const ok = (body) => ({ content: [{ type: 'text', text: JSON.stringify(body) }] });
const fail = (body) => ({ content: [{ type: 'text', text: JSON.stringify(typeof body === 'string' ? { error: body } : body) }], isError: true });

const WAIT_PROPERTY = {
  type: 'number',
  description: `How long to wait for the deploy before answering that it is still going (default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}; 0 answers at once). The deploy continues either way: follow it with get_deploy_log`
};

function createMcpServer(db, docker, runtimes, deployAgent, removeAgentRoutes, extras = {}) {
  const MCP_VERSION = '2024-11-05';
  // pruneDocker is the same routine the REST endpoint and the daily job use,
  // so a cleanup triggered over MCP is logged and bounded identically.
  // removeAgentVolumes likewise mirrors DELETE /api/agents/:id — without it an
  // MCP delete left every named volume behind as an orphan.
  const { pruneDocker, removeAgentVolumes, ensureAgentImage, redeployAgent } = extras;
  // Deploys run in the panel's one deploy queue. Outside it, a redeploy over
  // MCP built beside the Redeploy button's build of the same agent, and the
  // image between the two was never removed (2026-10-09).
  const enqueueDeploy = extras.enqueueDeploy || ((work) => work());
  const deployLog = extras.deployLog || null;
  const { issueTransfer, startImportFrom, importJobs, attachComposeRoute } = extras;
  const domainCheck = extras.domainCheck || createDomainCheck();
  // The server's public address, when the panel can tell. The panel's own name
  // may sit behind Cloudflare, and then DNS does not show it.
  const serverAddress = async () => {
    try { return (extras.serverAddress && await extras.serverAddress()) || null; } catch (_) { return null; }
  };
  // See server.js: ask the plugin whether it runs its own containers, rather
  // than matching the runtime's name.
  const composeManaged = (runtime) => !!runtimes[runtime]?.composeManaged;

  // What an operator did over MCP belongs in the event log like what was done
  // in the panel. A create and a delete here used to leave no trace.
  const logEvent = (type, agentId, message) => {
    try { db.prepare('INSERT INTO events (type, agent_id, message) VALUES (?, ?, ?)').run(type, agentId || null, message); }
    catch (err) { console.error('[MCP] Failed to log event:', err.message); }
  };

  const setting = (key) => {
    try { return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || null; }
    catch (_) { return null; }
  };
  // The names the hotel itself answers on: what a guest's name is compared with.
  const hotelNames = () => [setting('panel_domain'), ...String(setting('panel_domain_aliases') || '').split(',').map(s => s.trim())].filter(Boolean);

  const describeHolder = (a) => `${a.name} (${a.id}, ${a.status})`;
  const KEPT = 'A create that fails keeps its guest: redeploy_agent retries it, update_agent changes its domain or port, delete_agent frees its name and domain';

  // Who already answers on this domain, as a sentence, or null when it is free.
  function domainTaken(domain, exceptId = null) {
    if (!domain) return null;
    if (hotelNames().includes(domain)) return `${domain} is the panel's own address`;
    const holder = db.prepare('SELECT id, name, status FROM agents WHERE domain = ? AND id != ?').get(domain, exceptId || '');
    if (!holder) return null;
    return `${domain} is held by the agent ${describeHolder(holder)}. ${KEPT}`;
  }

  function portProblem(port) {
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? null : `Invalid port ${JSON.stringify(port)}: a whole number from 1 to 65535`;
  }

  // Said with the result of a create or a move, never a refusal: the record
  // may be on its way, and the guest is built the same.
  async function dnsWarning(domain) {
    if (!domain) return null;
    try {
      const found = await domainCheck.lookup(domain);
      if (!found.missing) return null;
      return `${domain} has no DNS record yet. The guest is deployed, but nobody reaches it and it gets no certificate until the name points at this hotel. check_domain says when it does; list_domains shows where new names need no DNS change`;
    } catch (_) { return null; }
  }

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
      description: "Check a new guest in and deploy it. `runtime` is a runtime from list_runtimes or a template id from list_templates (get_template shows the config it expects); a repository with a Dockerfile is runtime git-app with config {GIT_REPO, GIT_REF}. Give `port` when the app does not listen on the runtime's default (git-app 8000, docker-app 80): the panel does not read a Dockerfile's EXPOSE. Give a `domain` that already points at this hotel: check_domain says whether one does, list_domains where new names work without a DNS change. A build takes minutes, so the call waits wait_seconds and then answers done:false while the deploy goes on. A create that fails keeps its guest as failed, still holding its name and domain: read get_deploy_log, fix the cause and redeploy_agent, or delete_agent to start over",
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Agent name (unique): lowercase letters, digits and hyphens' },
          runtime: { type: 'string', description: 'A runtime id from list_runtimes (hermes, openclaw, git-app, docker-app, …) or a template id from list_templates' },
          domain: { type: 'string', description: 'The name the guest answers on, e.g. game.example.com. Optional; without one the guest has no public address' },
          image: { type: 'string', description: 'Docker image (optional, uses default)' },
          port: { type: 'integer', description: "The port the app listens on inside its container. Defaults to config.PORT where the runtime has that field, else the runtime's default" },
          config: { type: 'object', description: 'Agent configuration: the fields the runtime or template lists, and environment variables' },
          wait_seconds: WAIT_PROPERTY
        },
        required: ['name', 'runtime']
      }
    },
    update_agent: {
      description: "Move a guest to another domain, change the port the panel sends its traffic to, or change the container runtime it runs under, without deleting and creating it again: its id, volumes and deploy history stay. Applied by redeploying the guest, which replaces its container (and for a Git App builds its ref again). Config values that carried the old domain follow the new one. If the build fails, or the runtime is not registered in Docker on this host, the guest keeps running where it was and nothing is changed. For environment variables use set_agent_env",
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The agent ID' },
          domain: { type: 'string', description: 'The new name it answers on. check_domain first: it must point at this hotel' },
          port: { type: 'integer', description: 'The port the app listens on inside its container' },
          container_runtime: { type: 'string', description: 'The Docker runtime the guest runs under: "runc" shares the host kernel, "runsc" (gVisor) gives it a kernel of its own, a Kata runtime a microVM. Only runtimes registered in Docker on this host work: system_status lists them under container_runtimes. An empty string means the hotel default' },
          wait_seconds: WAIT_PROPERTY
        },
        required: ['agent_id']
      }
    },
    check_domain: {
      description: "Whether a name can be given to a guest, or works for the one that has it: valid as a domain, free or held (and by whom), what public DNS says (no-record, here, proxied through Cloudflare, elsewhere), whether its parent zone has a wildcard record, and for a held name what it answers from outside. Ask before create_agent or update_agent, and after a deploy to see the guest from the outside — a guest cannot reach its own public address from inside the hotel",
      inputSchema: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: 'The full name, e.g. game.example.com' }
        },
        required: ['domain']
      }
    },
    list_domains: {
      description: "Where this hotel's guests live: each parent zone guests have names under, the guests there, and whether the zone has a wildcard DNS record — under a wildcard a new name already resolves, to wherever the wildcard points, and needs no DNS change; elsewhere a new name needs its own record before the guest is reachable. The panel cannot create DNS records",
      inputSchema: { type: 'object', properties: {} }
    },
    delete_agent: {
      description: 'Delete an agent: its container, routes and volumes. Its data is gone with it',
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
          rebuild: { type: 'boolean', description: 'Rebuild the runtime template image first, picking up edits to templates/<runtime>/Dockerfile (slower)' },
          wait_seconds: WAIT_PROPERTY
        },
        required: ['agent_id']
      }
    },
    create_transfer: {
      description: "Move an agent to another AgentHotel: issue a one-time transfer URL (valid one hour) that the other hotel pulls the agent from with its import_from_hotel tool, or its Import Agent > From another hotel. With include_data (default true) the agent's memory goes too — its volumes — and stop_on_pull (default true) stops it here at the moment of the pull, so it never runs in two hotels at once; it stays here, stopped, until deleted. The URL is a credential: hand it only to the hotel that should receive the agent",
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The agent to move' },
          include_data: { type: 'boolean', description: "Include the agent's volume data (default true)" },
          stop_on_pull: { type: 'boolean', description: 'Stop the agent when the other hotel pulls it (default true)' }
        },
        required: ['agent_id']
      }
    },
    import_from_hotel: {
      description: "Move an agent into this hotel from another AgentHotel: give the transfer URL that hotel issued (its create_transfer tool, or Export > Move to another hotel). This hotel fetches the agent itself, server to server, in the background — returns a job id for get_import_status. The agent arrives stopped: point its domain's DNS here, then redeploy_agent",
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The transfer URL, ending in /api/transfer/<token>' } },
        required: ['url']
      }
    },
    get_import_status: {
      description: 'Progress of an import_from_hotel job: downloading (bytes so far, total when known), importing, done (with the new agent) or failed (with why)',
      inputSchema: {
        type: 'object',
        properties: { job_id: { type: 'string' } },
        required: ['job_id']
      }
    },
    get_deploy_log: {
      description: "An agent's recent deploys (status, what started each, commit, duration) and the log of one — the latest unless deployment_id is given. Read it when a create, redeploy or set_agent_env failed or is still running: the build output, pulls and container start are all there. Secret config values are masked in it.",
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The agent ID' },
          deployment_id: { type: 'number', description: 'A deploy from the list; the latest when omitted' },
          tail: { type: 'number', description: 'Lines from the end of the log (default 200)' }
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
          apply: { type: 'boolean', description: 'Redeploy so the container picks the values up (default true). False stores them for the next redeploy without disturbing a running agent' },
          wait_seconds: WAIT_PROPERTY
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
      description: 'Get system information: host, Docker version, every guest with the container runtime it is set to run under, and container_runtimes: the runtimes Docker on this host has registered (the names update_agent takes as container_runtime), what each isolates, and the hotel default',
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
      description: 'Docker disk accounting: images, containers, volumes and build cache, and byAgent — what each agent holds (its volumes and container layer, bytes) with the image it runs. Image sizes overlap (shared layers); layersSize counts each layer once',
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
          },
          place: {
            type: 'object',
            description: 'Only for a service other guests should use through the reception: where its MCP endpoint is and which variable holds its token. Every guest then finds it in hotel_guide',
            properties: {
              mcp: { type: 'string', description: 'Path of the MCP endpoint on the guest\'s own port, e.g. "/mcp"' },
              auth: { type: 'string', description: '"bearer" (default), "header" or "none"' },
              tokenEnv: { type: 'string', description: 'Name of the env variable holding the token, e.g. "LOBBY_API_TOKEN"' },
              header: { type: 'string', description: 'Header that carries the token, with auth "header"' }
            }
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
    const tool = tools[name];
    if (!tool) return fail(`Unknown tool: ${name}`);
    const problem = argumentProblem(tool, args);
    if (problem) return fail(`${name}: ${problem}`);

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
        const name = args.name;
        // The name flows into container and volume names.
        if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
          return fail('Invalid name: use lowercase letters, digits and hyphens, starting with a letter or digit');
        }
        if (args.config !== undefined && (args.config === null || typeof args.config !== 'object' || Array.isArray(args.config))) {
          return fail('config must be an object of field names to values');
        }
        const domain = args.domain || null;
        const badDomain = domainProblem(domain);
        if (badDomain) return fail(badDomain);

        // A template is a recipe for a runtime, filled in the way POST
        // /api/agents fills it. get_template has always said "use the template
        // id as the runtime for create_agent", and this answered "Unknown
        // runtime" to every one of them.
        let runtime = args.runtime;
        let config = args.config || {};
        let image = args.image;
        let port = args.port;
        let templateId = null;
        if (!runtimes[runtime]) {
          const template = getTemplate(runtime, runtimes);
          if (!template || !template.deploy) {
            return fail(`Unknown runtime: ${runtime}. list_runtimes and list_templates say what there is`);
          }
          try {
            const filled = materializeDeploy(template.deploy, { ...config, DOMAIN: domain || '', AGENT_NAME: name });
            templateId = template.id;
            runtime = filled.runtime;
            config = filled.config;
            if (!image && filled.image) image = filled.image;
            if (port === undefined && filled.port) port = filled.port;
          } catch (err) {
            return fail(`Template ${template.name}: ${err.message}`);
          }
        }
        const plugin = runtimes[runtime];
        if (!plugin) return fail(`Unknown runtime: ${runtime}`);
        if (runtime === 'compose' && !config.COMPOSE_FILE) return fail('COMPOSE_FILE is required for compose agents');

        // Where the panel sends the guest's traffic. An app runtime has a PORT
        // field, and an agent that filled it in was still routed to the
        // default: a game's nginx listened on 8080, its route went to 8000,
        // and health said ECONNREFUSED with nothing to connect the two
        // (2026-11-14).
        const notes = [];
        const hasPortField = (plugin.configFields || []).some(f => f.key === 'PORT');
        if (port === undefined && hasPortField && config.PORT !== undefined && config.PORT !== '') port = Number(config.PORT);
        if (port === undefined) {
          port = plugin.defaultPort;
          if (hasPortField) notes.push(`No port given: traffic goes to ${port}, this runtime's default. If the app listens elsewhere, update_agent with its port`);
        }
        const badPort = portProblem(port);
        if (badPort) return fail(badPort);
        if (hasPortField) config = { ...config, PORT: String(port) };
        image = image || plugin.defaultImage;

        // Said before the row exists. The table's own answer to a second
        // create was "UNIQUE constraint failed: agents.domain".
        const sameName = db.prepare('SELECT id, name, status FROM agents WHERE name = ?').get(name);
        if (sameName) return fail(`The name ${name} is held by the agent ${describeHolder(sameName)}. ${KEPT}`);
        const taken = domainTaken(domain);
        if (taken) return fail(taken);

        const id = `${runtime}-${name}-${Date.now()}`;
        // Auto-inject API keys from providers + default models (shared with
        // server.js /api/agents via lib/providerEnv.js).
        const finalConfig = await injectProviderEnv(db, config, plugin);
        let agentConfig;
        try {
          agentConfig = plugin.buildConfig({ name, domain, image, port, config: finalConfig });
        } catch (err) {
          return fail(err.message);
        }

        db.prepare('INSERT INTO agents (id, name, runtime, domain, image, port, status, config, template) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, name, runtime, domain, image, port, 'creating', JSON.stringify(agentConfig), templateId);

        const dns = dnsWarning(domain);
        const extra = async () => {
          const warning = await dns;
          return { ...(warning ? { warning } : {}), ...(notes.length ? { notes } : {}) };
        };

        const run = Promise.resolve().then(() => enqueueDeploy(async () => {
          if (composeManaged(runtime)) {
            await plugin.deploy(id, name, agentConfig, plugin);
            // A compose guest's route is added after its stack is up. Only the
            // runtime named 'compose' was told apart here, and nothing attached
            // a route, so a stack created over MCP had no address.
            if (attachComposeRoute) await attachComposeRoute({ id }, plugin, agentConfig, domain);
          } else {
            await deployAgent(id, name, runtime, domain, image, port, agentConfig, plugin);
          }
        }, id, { kind: 'create', trigger: 'MCP', config: agentConfig })).then(async () => {
          db.prepare("UPDATE agents SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
          logEvent('agent.create', id, `Created agent ${name} over MCP`);
          return ok({ success: true, agent_id: id, status: 'running', ...(domain ? { domain } : {}), port, ...(await extra()) });
        }, async (err) => {
          // The guest is kept: its deploy log is the only account of what went
          // wrong, and the fix is usually a redeploy after a push.
          db.prepare("UPDATE agents SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
          logEvent('agent.error', id, `Create of ${name} over MCP failed: ${err.message}`);
          return fail({
            error: err.message, agent_id: id, status: 'failed',
            next: `The guest ${name} is kept and holds its name${domain ? ' and ' + domain : ''}. get_deploy_log shows the build; when the cause is fixed, redeploy_agent retries it (update_agent first for another port or domain). delete_agent starts over`
          });
        });

        return settleWithin(run, waitSeconds(args.wait_seconds), async () => ok({
          agent_id: id, status: 'creating', done: false, ...(domain ? { domain } : {}), port,
          next: 'Still deploying, and it goes on without this call. get_deploy_log shows progress; get_agent says running or failed when it ends',
          ...(await extra())
        }));
      }

      case 'update_agent': {
        const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(args.agent_id);
        if (!agent) return fail('Agent not found');
        if (args.domain === undefined && args.port === undefined && args.container_runtime === undefined) {
          return fail('Nothing to change: give domain, port or container_runtime');
        }
        if (composeManaged(agent.runtime)) {
          return fail(`${agent.name} runs its own containers (${agent.runtime}); update_agent does not move such a guest`);
        }
        if (['creating', 'redeploying', 'updating'].includes(agent.status)) {
          return fail(`A deploy of ${agent.name} is going (${agent.status}). Wait for it: get_deploy_log shows where it is`);
        }

        let domain = agent.domain;
        if (args.domain !== undefined) {
          if (typeof args.domain !== 'string' || !args.domain) return fail('domain must be a name like game.example.com');
          const badDomain = domainProblem(args.domain);
          if (badDomain) return fail(badDomain);
          domain = args.domain;
        }
        let port = agent.port;
        if (args.port !== undefined) {
          const badPort = portProblem(args.port);
          if (badPort) return fail(badPort);
          port = args.port;
        }
        let config = {};
        try { config = JSON.parse(agent.config || '{}'); } catch (_) {}
        const runtimeBefore = config[containerRuntime.CONFIG_KEY] || '';
        let runtimeAfter = runtimeBefore;
        if (args.container_runtime !== undefined) {
          if (typeof args.container_runtime !== 'string') return fail('container_runtime must be a runtime name, or "" for the hotel default');
          runtimeAfter = args.container_runtime.trim();
          try { await containerRuntime.assertRuntimeUsable(docker, runtimeAfter); }
          catch (err) { return fail(err.message); }
        }
        if (domain === agent.domain && port === agent.port && runtimeAfter === runtimeBefore) {
          return ok({ success: true, agent_id: agent.id, changed: false, domain, port, container_runtime: runtimeAfter });
        }
        if (domain !== agent.domain) {
          const taken = domainTaken(domain, agent.id);
          if (taken) return fail(taken);
        }

        // Values written from the old domain follow it (lib/orphans.js), and
        // the PORT field says what the port column says.
        const moved = require('./lib/orphans').withDomainChanged(config, agent.domain, domain);
        config = moved.config;
        if (port !== agent.port && config.PORT !== undefined) config = { ...config, PORT: String(port) };
        if (runtimeAfter !== runtimeBefore) {
          config = { ...config };
          if (runtimeAfter) config[containerRuntime.CONFIG_KEY] = runtimeAfter;
          else delete config[containerRuntime.CONFIG_KEY];
        }

        const changes = [
          domain !== agent.domain ? `${agent.domain || 'no domain'} → ${domain}` : null,
          port !== agent.port ? `port ${agent.port} → ${port}` : null,
          runtimeAfter !== runtimeBefore ? `runtime ${runtimeBefore || 'hotel default'} → ${runtimeAfter || 'hotel default'}` : null
        ].filter(Boolean).join(', ');

        if (!redeployAgent) return fail('Redeploys unavailable');
        db.prepare('UPDATE agents SET domain = ?, port = ?, config = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(domain, port, JSON.stringify(config), agent.id);
        const dns = domain !== agent.domain ? dnsWarning(domain) : Promise.resolve(null);

        // The panel's redeploy reads the row again, so it builds, routes and
        // starts the guest with the new values. Its routes for the old name
        // are not its to know about: that one is removed here, afterwards, so
        // the old name serves until the new one does.
        const dropOldRoute = async () => {
          if (!agent.domain || agent.domain === domain) return;
          try { await removeAgentRoutes({ domain: agent.domain, config: '{}' }); } catch (_) {}
        };
        const run = Promise.resolve().then(() => redeployAgent(agent.id, { trigger: 'MCP', kind: 'update' })).then(async () => {
          await dropOldRoute();
          logEvent('agent.update', agent.id, `Updated agent ${agent.name} over MCP: ${changes}`);
          const warning = await dns;
          return ok({ success: true, agent_id: agent.id, status: 'running', changed: true, domain, port, ...(args.container_runtime !== undefined ? { container_runtime: runtimeAfter } : {}), ...(warning ? { warning } : {}) });
        }, async (err) => {
          if (/left running/.test(err.message)) {
            // The build failed before anything was taken down: the guest still
            // answers where it did, and the row says so again.
            db.prepare('UPDATE agents SET domain = ?, port = ?, config = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
              .run(agent.domain, agent.port, agent.config, agent.id);
            return fail({ error: err.message, agent_id: agent.id, changed: false, domain: agent.domain, port: agent.port });
          }
          await dropOldRoute();
          logEvent('agent.update', agent.id, `Updated agent ${agent.name} over MCP: ${changes}, and its deploy failed`);
          return fail({
            error: err.message, agent_id: agent.id, changed: true, domain, port,
            next: 'The changes are saved, but the guest did not come back up. get_deploy_log shows why; redeploy_agent retries'
          });
        });

        return settleWithin(run, waitSeconds(args.wait_seconds), async () => {
          const warning = await dns;
          return ok({
            agent_id: agent.id, status: 'redeploying', done: false, domain, port,
            next: 'Still deploying, and it goes on without this call. get_deploy_log shows progress; get_agent says running when it ends, with the old domain and port back if the build failed',
            ...(warning ? { warning } : {})
          });
        });
      }

      case 'check_domain': {
        const domain = String(args.domain).trim().toLowerCase();
        const problem = domainProblem(domain);
        if (problem) return ok({ domain, valid: false, ready: false, verdict: problem });

        const hotel = hotelNames();
        const isPanel = hotel.includes(domain);
        const holder = db.prepare('SELECT id, name, status FROM agents WHERE domain = ?').get(domain) || null;
        const parent = parentOf(domain);
        const address = await serverAddress();
        const [dns, wildcard] = await Promise.all([
          domainCheck.check(domain, { hotel, addresses: [address] }),
          parent ? domainCheck.hasWildcard(parent) : Promise.resolve(false)
        ]);
        // Asked only for a name a guest holds: an unheld name has no route
        // here, and what it answers says nothing about this hotel.
        let answers = null;
        if (holder && dns.addresses.length) answers = await domainCheck.answers(domain, dns.addresses[0]);
        const reaches = answers && answers.status && answers.status < 500;

        const where = dns.hotelAddresses.length ? dns.hotelAddresses.join(', ') : (hotel[0] ? `where ${hotel[0]} points` : "this hotel's address");
        let ready, verdict;
        if (isPanel) {
          ready = false; verdict = "This is the panel's own address";
        } else if (dns.state === 'no-record') {
          ready = false;
          verdict = `No DNS record. It needs an A record to ${where} before anyone reaches a guest on it. The panel cannot create DNS records: ask the operator, or pick a name under a zone list_domains shows a wildcard for`;
        } else if (dns.state === 'unknown') {
          ready = null; verdict = `DNS did not answer (${dns.error}). Ask again`;
        } else if (dns.state === 'elsewhere') {
          ready = false; verdict = `Points at ${dns.addresses.join(', ')}, which is not this hotel (${dns.hotelAddresses.join(', ')})`;
        } else if (holder) {
          ready = !!reaches;
          verdict = reaches
            ? `Answers from outside with HTTP ${answers.status}`
            : `Resolves, but from outside it answers ${answers && answers.status ? 'HTTP ' + answers.status : (answers && answers.error) || 'nothing'}. A 502 or 52x is the route or the port: health_check and get_agent_logs, then update_agent with the port the app listens on. A certificate takes a minute after the first deploy`;
        } else if (dns.state === 'here') {
          ready = true; verdict = 'Free, and points at this hotel';
        } else if (dns.state === 'proxied') {
          ready = null; verdict = 'Free, and resolves through Cloudflare, which hides where it ends up. If the record is meant for this hotel it works: deploy, then ask again to see what it answers';
        } else {
          ready = null; verdict = "Free, and resolves. The hotel's own address is not known to compare with: deploy, then ask again to see what it answers";
        }

        return ok({
          domain, valid: true, ready, verdict,
          held_by: holder ? { agent_id: holder.id, name: holder.name, status: holder.status } : (isPanel ? 'the panel' : null),
          dns: { state: dns.state, addresses: dns.addresses },
          parent: parent ? { zone: parent, wildcard } : null,
          ...(answers ? { answers } : {})
        });
      }

      case 'list_domains': {
        const guests = db.prepare("SELECT id, name, domain, status FROM agents WHERE domain IS NOT NULL AND domain != '' ORDER BY domain").all();
        const zones = new Map();
        for (const g of guests) {
          const zone = parentOf(g.domain) || g.domain;
          if (!zones.has(zone)) zones.set(zone, []);
          zones.get(zone).push({ domain: g.domain, name: g.name, agent_id: g.id, status: g.status });
        }
        const out = await Promise.all([...zones].map(async ([zone, list]) => {
          const wildcard = await domainCheck.hasWildcard(zone);
          return {
            zone, wildcard,
            new_names: wildcard === true ? 'resolve already: no DNS change needed'
              : wildcard === false ? 'need a DNS record of their own first'
              : 'unknown: DNS did not answer',
            guests: list
          };
        }));
        return ok({
          panel: hotelNames()[0] || null,
          address: await serverAddress(),
          zones: out,
          note: 'A zone is the part of a guest\'s name after its first label; address is where a DNS record for a new name points. check_domain says whether one name is free and where it points'
        });
      }

      case 'delete_agent': {
        const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(args.agent_id);
        if (!agent) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Agent not found' }) }], isError: true };

        if (composeManaged(agent.runtime)) {
          // Compose agents have no single container — tear the project down.
          const plugin = runtimes[agent.runtime];
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
          // Every hostname the guest answers to, not just the primary.
          try { await removeAgentRoutes(agent); } catch (e) {}
        }

        // Same teardown as the REST delete: the agent's named volumes go with
        // it, otherwise deleting over MCP silently leaks gigabytes of state.
        if (removeAgentVolumes) {
          try { await removeAgentVolumes(args.agent_id); } catch (e) {
            console.error('[MCP] Volume cleanup failed for', args.agent_id, e.message);
          }
        }

        db.prepare('DELETE FROM agents WHERE id = ?').run(args.agent_id);
        logEvent('agent.delete', args.agent_id, `Deleted agent ${agent.name} over MCP`);
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
        // Compose guests don't take their environment from config keys — the
        // panel writes COMPOSE_ENV to a .env file beside the stack, and the
        // compose file interpolates from there. Setting a top-level key would
        // store the value where nothing ever reads it.
        const isCompose = composeManaged(agent.runtime);
        const composeEnv = isCompose
          ? (config.COMPOSE_ENV || '').split('\n').filter(l => l.trim() !== '')
          : null;
        const composeSet = (name, value) => {
          const line = value === null ? null : `${name}=${value}`;
          const at = composeEnv.findIndex(l => l.split('=')[0].trim() === name);
          if (at === -1) { if (line) composeEnv.push(line); return; }
          if (line) composeEnv[at] = line; else composeEnv.splice(at, 1);
        };

        const set = [], removed = [];
        for (const [name, value] of Object.entries(env)) {
          if (value === null) {
            if (isCompose) composeSet(name, null); else delete config[name];
            removed.push(name);
            continue;
          }
          if (typeof value === 'object') {
            return { content: [{ type: 'text', text: JSON.stringify({ error: `Value for ${name} must be a string, number or boolean` }) }], isError: true };
          }
          if (isCompose) composeSet(name, String(value)); else config[name] = String(value);
          set.push(name);
        }
        if (isCompose) config.COMPOSE_ENV = composeEnv.join('\n');

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

        const applied = (async () => { try {
          let buildError = null;
          await enqueueDeploy(async () => {
            if (composeManaged(agent.runtime)) {
              try { await plugin.stop(agent.id, deployConfig); } catch (e) {}
              await plugin.deploy(agent.id, agent.name, deployConfig, plugin);
              return;
            }
            // Build before tearing down, so the guest keeps serving meanwhile.
            if (ensureAgentImage) {
              try {
                await ensureAgentImage(agent.id, agent.name, agent.runtime, agent.image, deployConfig, plugin, { rebuildImage: false });
              } catch (err) {
                buildError = err;
                return;
              }
            }
            const container = docker.getContainer(`agenthotel-${args.agent_id}`);
            try { await container.stop(); } catch (e) {}
            try { await container.remove({ force: true }); } catch (e) {}
            await deployAgent(agent.id, agent.name, agent.runtime, agent.domain, agent.image, agent.port, deployConfig, plugin, { alreadyBuilt: true });
          }, args.agent_id, { kind: 'update', trigger: 'MCP', config: deployConfig });
          if (buildError) {
            db.prepare("UPDATE agents SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(args.agent_id);
            return { content: [{ type: 'text', text: JSON.stringify({ error: `Build failed, the agent was left running: ${buildError.message}` }) }], isError: true };
          }
          db.prepare("UPDATE agents SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(args.agent_id);
          return { content: [{ type: 'text', text: JSON.stringify({ success: true, set, removed, applied: true, status: 'running' }) }] };
        } catch (err) {
          db.prepare("UPDATE agents SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(args.agent_id);
          return { content: [{ type: 'text', text: JSON.stringify({ error: err.message, set, removed, applied: false }) }], isError: true };
        } })();
        return settleWithin(applied, waitSeconds(args.wait_seconds), () => ok({
          set, removed, applied: false, status: 'redeploying', done: false,
          next: 'The values are stored and the redeploy that applies them is still going. get_deploy_log shows progress; get_agent says running when it ends'
        }));
      }

      case 'redeploy_agent': {
        const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(args.agent_id);
        if (!agent) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Agent not found' }) }], isError: true };

        // The panel's own redeploy, exactly as the Redeploy button runs it:
        // provider env re-injected, the deploy queue, the status handling, and
        // an identical redeploy already queued or running joined rather than
        // built a second time (lib/redeployGate.js). This used to be a copy
        // that ran outside the queue — a redeploy here a minute after one from
        // the button built the same commit twice, side by side (2026-10-09).
        const run = Promise.resolve().then(() => redeployAgent(agent.id, { rebuildImage: args.rebuild === true, trigger: 'MCP' })).then(
          () => ok({ success: true, agent_id: args.agent_id, status: 'running' }),
          (err) => fail(err.message));
        return settleWithin(run, waitSeconds(args.wait_seconds), () => ok({
          agent_id: args.agent_id, status: 'redeploying', done: false,
          next: 'Still deploying, and it goes on without this call. get_deploy_log shows progress; get_agent says running when it ends'
        }));
      }

      case 'create_transfer': {
        if (!issueTransfer) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Transfers unavailable' }) }], isError: true };
        const domain = db.prepare("SELECT value FROM settings WHERE key = 'panel_domain'").get()?.value;
        if (!domain) return { content: [{ type: 'text', text: JSON.stringify({ error: "This hotel has no panel domain set, so it cannot say where to fetch from — set one on the Domains page" }) }], isError: true };
        try {
          const t = await issueTransfer(args.agent_id, { includeData: args.include_data !== false, stopOnPull: args.stop_on_pull !== false, base: `https://${domain}` });
          return { content: [{ type: 'text', text: JSON.stringify(t) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
        }
      }

      case 'import_from_hotel': {
        if (!startImportFrom) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Transfers unavailable' }) }], isError: true };
        try {
          const job = startImportFrom(args.url);
          return { content: [{ type: 'text', text: JSON.stringify({ job_id: job.id, status: job.status, next: 'get_import_status(job_id) until done or failed' }) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
        }
      }

      case 'get_import_status': {
        const job = importJobs && importJobs.get(args.job_id);
        if (!job) return { content: [{ type: 'text', text: JSON.stringify({ error: 'No such import job' }) }], isError: true };
        return { content: [{ type: 'text', text: JSON.stringify(job) }] };
      }

      case 'get_deploy_log': {
        if (!deployLog) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Deploy log unavailable' }) }], isError: true };
        const deploys = deployLog.list(args.agent_id, 10);
        if (!deploys.length) return { content: [{ type: 'text', text: JSON.stringify({ deployments: [], note: 'No deploys recorded for this agent yet' }) }] };
        const chosen = args.deployment_id ? deploys.find(d => d.id === Number(args.deployment_id)) || deployLog.get(args.deployment_id) : deploys[0];
        if (!chosen || chosen.agent_id !== args.agent_id) return { content: [{ type: 'text', text: JSON.stringify({ error: 'No such deployment for this agent' }) }], isError: true };
        const log = deployLog.read(chosen.id, 0);
        const tail = Math.max(1, Math.min(2000, parseInt(args.tail) || 200));
        const summary = d => ({ id: d.id, kind: d.kind, trigger: d.trigger, status: d.status, commit: d.commit_sha,
          queued_at: new Date(d.queued_at).toISOString(),
          seconds: d.finished_at && d.started_at ? Math.round((d.finished_at - d.started_at) / 1000) : null, error: d.error });
        return { content: [{ type: 'text', text: JSON.stringify({
          deployments: deploys.map(summary), deployment: summary(chosen), done: log.done,
          log: log.text.split('\n').slice(-tail - 1).join('\n')
        }) }] };
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
        // One command that is missing must not cost the whole answer.
        const run = (cmd) => {
          try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (_) { return null; }
        };
        const hostname = run('hostname');
        const uptime = run('uptime');
        const dockerVersion = run('docker --version');

        // The runtimes a guest can be moved to with update_agent's
        // container_runtime, so an agent does not have to guess a name.
        const setting = db.prepare('SELECT value FROM settings WHERE key = ?').get(containerRuntime.SETTING_KEY)?.value || '';
        const hotel = containerRuntime.chosenRuntime({}, { setting });
        let container_runtimes;
        let dockerDefault = null;
        try {
          const registered = await containerRuntime.registeredRuntimes(docker);
          dockerDefault = registered.dockerDefault;
          container_runtimes = {
            available: registered.runtimes,
            hotel_default: hotel.name || dockerDefault,
            hotel_default_source: hotel.source,
            applies: 'on the guest\'s next redeploy; update_agent with container_runtime saves and redeploys'
          };
        } catch (err) {
          container_runtimes = { error: `Docker did not say which runtimes it has: ${err.message}` };
        }

        // Each guest's container runtime as chosen (its own, else the hotel's);
        // its config itself stays out, it can hold keys.
        const agents = db.prepare('SELECT id, name, runtime, status, config FROM agents').all().map(({ config, ...a }) => {
          let own = {};
          try { own = JSON.parse(config || '{}'); } catch (_) {}
          const chosen = containerRuntime.chosenRuntime(own, { setting });
          return { ...a, container_runtime: chosen.name || dockerDefault, container_runtime_source: chosen.source };
        });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ hostname, uptime, dockerVersion, container_runtimes, agents }, null, 2)
          }]
        };
      }

      case 'health_check': {
        // Sequential on purpose: agent stats and host CPU sampling both cost
        // a few hundred ms; running them together skews the CPU numbers.
        const host = await collectHostMetrics();
        const dockerUsage = await collectDockerUsage(docker);
        const agentStats = await collectAgentStats(docker, db, runtimes);
        const uptime = collectUptime(db, 24);
        const expectedAgents = db.prepare('SELECT COUNT(*) AS n FROM agents').get().n;
        const report = buildHealthReport({ host, dockerUsage, agentStats, uptime, expectedAgents });
        return { content: [{ type: 'text', text: JSON.stringify({ ...report, host, agents: agentStats }, null, 2) }] };
      }

      case 'get_host_metrics': {
        return { content: [{ type: 'text', text: JSON.stringify(await collectHostMetrics(), null, 2) }] };
      }

      case 'get_agent_stats': {
        return { content: [{ type: 'text', text: JSON.stringify(await collectAgentStats(docker, db, runtimes), null, 2) }] };
      }

      case 'get_uptime': {
        const hours = Math.min(Math.max(parseInt(args?.hours, 10) || 24, 1), 168);
        return { content: [{ type: 'text', text: JSON.stringify(collectUptime(db, hours), null, 2) }] };
      }

      case 'get_docker_usage': {
        const usage = await collectDockerUsage(docker);
        // Per agent too: "which agent filled the disk" is the question this
        // tool is asked, and the totals alone could not answer it.
        try {
          const { diskByAgent } = require('./lib/diskUsage');
          const agents = db.prepare('SELECT id, name, runtime, config FROM agents').all();
          const byAgent = diskByAgent(await docker.df(), agents);
          usage.byAgent = byAgent.agents.map(a => ({ name: a.name, total: a.total, data: a.data, container: a.container, image: a.image }));
          usage.layersSize = byAgent.layersSize;
        } catch (_) { /* the totals still answer */ }
        return { content: [{ type: 'text', text: JSON.stringify(usage, null, 2) }] };
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
        try {
          const result = await execInAgent(docker, agent.id, args.command, {
            timeoutMs: parseInt(args.timeout_ms) || 60000,
            user: runtimes[agent.runtime]?.terminalUser,
            container: containerNameFor(runtimes, agent)
          });
          db.prepare('INSERT INTO events (type, agent_id, message) VALUES (?, ?, ?)')
            .run('agent.exec', agent.id, `Ran over MCP: ${String(args.command).slice(0, 120)}`);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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
    const { method, params, id } = req.body || {};

    try {
      let result;

      // A notification has no id and gets no reply.
      if (typeof method === 'string' && method.startsWith('notifications/')) return res.status(202).send();

      switch (method) {
        case 'initialize':
          result = {
            protocolVersion: MCP_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'agenthotel', version: '1.0.0' }
          };
          break;

        case 'ping':
          result = {};
          break;

        // The tool list is an array of named tools, as the protocol has it.
        // This sent the object the tools are kept in, keyed by name, which a
        // client that checks the reply refuses: the panel's own Connect page
        // was the only reader, so nobody saw it until an agent was asked to
        // run the hotel and had to write its JSON-RPC by hand (2026-11-14).
        case 'tools/list':
          result = { tools: Object.entries(tools).map(([name, tool]) => ({ name, ...tool })) };
          break;

        case 'tools/call': {
          const { name, arguments: args } = params || {};
          result = await handleToolCall(name, args === undefined || args === null ? {} : args);
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

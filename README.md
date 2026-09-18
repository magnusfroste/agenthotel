# AgentHotel

**Self-hosted control panel for AI agents. Check them in, watch them work.**

AgentHotel turns one VPS into a hotel for AI agents. Each guest gets its own room — an isolated container with its own memory and CPU allowance, its own domain with automatic HTTPS, and persistent state that survives restarts, redeploys and nights. You run the front desk: a web UI, a live view of every room, and an MCP server so your own AI tools can check guests in and out for you.

## Why a hotel?

Because that is what running several agents actually is. The metaphor is not decoration — it is how the panel is built:

| Front desk | What it does |
|---|---|
| **Check in** | Pick a runtime, name the agent, done. Domain, TLS and routing are automatic. |
| **Rooms** | Each agent is capped at its own RAM and CPU, so no guest starves the others — or the hotel. |
| **No vacancy** | The panel warns you before you overbook the host, not after. |
| **Guests remember** | Sessions, memory and workspace files live in volumes that outlive the container. |
| **Room keys** | Provider API keys are configured once and injected into every agent that needs them. |
| **Housekeeping** | Stopped containers, dangling images and build cache are reclaimed on a schedule. |
| **The dining room** | Guests share a data store, so an agent can find what a colleague already worked out instead of starting from nothing. |
| **The ledger** | Health, uptime, resource use and events — from the UI or over MCP. |

Running AI agents on your own server otherwise means hand-rolled Docker commands, manual reverse-proxy config, and API keys copy-pasted into env files. AgentHotel removes all of that.

## Features

### Agent Management
- **Seven runtimes** — Hermes, OpenClaw, Odysseus, generic Docker App, Git App, Git Compose, and full Docker Compose deployments
- **Quick Start** — API keys are injected automatically from your configured providers (OpenAI, Anthropic, OpenRouter, Gemini, DeepSeek, Groq, xAI, Mistral, or any OpenAI-compatible endpoint like vLLM)
- **Tabbed agent view** — Overview, Logs, Console, Environment, Credentials and Settings in one place
- **Source apart from environment** — where a guest's code comes from (repository, ref, compose file, which service the domain points at) is edited on its own panel, with the commit it is running. `GIT_REF` is not a variable the app reads; it decides what the app *is*, and mixing the two put it between two API keys
- **Start / Stop / Redeploy / Delete** from the dashboard, with one-click Open on the agent's URL
- **Web terminal** — full TTY shell into any container via WebSocket + xterm.js

### Template Library
- **Browsable library** — every deployable runtime as a card with its category, tags, default image and port, filtered by search, category or tag
- **Template detail page** — what the template is, what to do after deployment, benefits, features, upstream links, changelog, and the exact config fields the deploy form will ask for
- **Data-driven** — presentation lives in `templates/<id>/meta.yaml`, so a new template needs no frontend change; edits are picked up without restarting the backend
- **Templates are deployable** — a template can be a recipe rather than a runtime: an image, a compose file, or a repository whose compose file it runs. Deploying one fills in the form a person would otherwise fill in, then creates an ordinary agent on the runtime it names
- **Declared secrets** — a template says what is secret and how to make it (`hex`, `password`, or a JWT signed with another generated secret), and the panel generates it at deploy. No template ever carries a credential, and two deployments never share one
- **SkillHub** — self-hosted Supabase as a shared data layer for the hotel's agents: Postgres with pgvector, storage, edge functions and Studio, with every secret generated per deployment

### Agents That Reach Your Tools
- **MCP servers as configuration** — point a Hermes agent at an MCP server from the panel and the block is written into its config on deploy. A new agent is born able to reach the organisation's tools, several agents follow one edit, and an agent recreated from its config comes back whole
- **Identity per agent** — a shared data store like SkillHub derives *who is writing* from the key in the header, so each agent gets its own. Sharing one key would make the store unable to tell whose work is whose
- **The panel owns what guards a guest** — dashboard credentials and session-signing keys are generated per agent and shown under Credentials, never a constant baked into a runtime

### Deploy Anything
- **Docker App runtime** — deploy any Docker image with port, env vars and volume mounts
- **Compose runtime** — paste a `docker-compose.yml` with env-var editor and YAML validation

### Domains & TLS
- **Automatic HTTPS** — Caddy issues and renews Let's Encrypt certificates for every agent subdomain
- **Live domains view** — real container status, orphaned-route detection and cleanup
- **Certificates panel** — issuer, validity dates, SANs and fingerprints, read live from Caddy's cert store
- **Cloudflare Tunnel (optional)** — no open ports, no DNS record pointing here and no local certificate; works behind NAT. One origin for every hostname, since Caddy still routes on the Host header ([manual](docs/MANUAL.md#cloudflare-tunnel))

### Providers & Models
- **Multi-provider system** — add providers once, keys are injected into new agents automatically (and into existing agents on redeploy); every provider gets its own slug-based env vars (`Hetzner` → `HERTZNER_API_KEY` / `HERTZNER_BASE_URL` / `HERTZNER_MODELS`) alongside the canonical slots. **OpenClaw** and **Hermes** both list every configured provider — including private, self-hosted endpoints — by name in their model pickers, so switching model or provider is a live choice rather than a redeploy. Odysseus takes one endpoint, added in its own admin UI
- **Provider testing** — list available models and test them per provider, right from the UI
- **Private models** — point the whole fleet at your own hardware with one setting; the panel probes each provider's models, declines any too small for a runtime to run, and says so rather than falling back to a hosted API without telling you

See the [Providers & Models manual chapter](docs/MANUAL.md#providers--models) for the full injection rules and per-runtime behavior.

### Observability & System
- **Dashboard** — app-centric cards with live status, system CPU/RAM/disk stats, auto-refresh; fleet search, status filter and sorting for larger installations
- **Resource guardrails** — the panel can never be frozen out by its own fleet: every agent gets a CPU cap (default 1 core, `CPU_LIMIT`) and RAM cap (default 1024 MB, `MEMORY_LIMIT_MB`), low cpu-shares (256) and a high OOM-kill priority, while the panel containers run at 2048 shares with `oom_score_adj: -500`. Shares only matter under saturation, so agents still use all idle capacity — but the panel always stays responsive, no reboot needed. Host-wide defaults via `DEFAULT_AGENT_CPU` / `DEFAULT_AGENT_MEM_MB`
- **Serialized deploys** — one build/deploy at a time, so concurrent deploys can't saturate the host
- **Routes that heal** — Caddy holds its routes in memory, and a compose stack's containers come back on their own networks when recreated. Both are re-checked every minute: a present route over a lost network is a 502 that no route check would catch
- **Per-agent resource stats** — live CPU, memory and network usage per container, refreshed every 5s on the agent's Overview tab
- **Uptime monitoring** — HTTPS checks every minute for running agents with a domain, 24h/7d percentages and a 50-check history strip, with `agent.up`/`agent.down` events on state transitions
- **Alert notifications** — webhook (Slack/Discord) or Telegram alerts when an agent goes down or recovers, or when host disk/memory crosses a configurable threshold
- **Bounded container logs** — agents are deployed with json-file log rotation (10 MB × 3) so a chatty agent can't fill the disk
- **Activity log** — agent lifecycle, cleanup and login events, shown on the System page
- **Log viewer** — demuxed container logs, no binary garbage
- **Daily Docker cleanup** — scheduled pruning of unused resources, with history and space-reclaimed stats (agent volumes are never touched); orphaned agent volumes can be reviewed and removed explicitly from the System page
- **Dark & light mode**, mobile-responsive sidebar, toast notifications, skeleton loaders

### Automation & MCP
- **Built-in MCP server** — let external AI agents list, create, redeploy and delete agents, check system status and pull logs
- **REST API** — everything the UI does is available over a token-authenticated JSON API
- **Export / import** — one-click instance backup and VPS-to-VPS migration (agents, providers and settings; admin credentials are never exported), plus per-service export/import as a zip — move a single agent between instances like Easypanel, optionally including its persistent volume data (requires a stopped agent, for a consistent copy)

## Quick Start

**Point DNS at the VPS first.** Caddy asks Let's Encrypt for a certificate the
first time a domain is requested, and that fails if the name does not already
resolve to this server. You need an A record for the panel (`panel.example.com`)
and one per agent (`myagent.example.com`) — or a single wildcard `*.example.com`,
which is simpler since every agent gets its own subdomain.

Then, on a fresh VPS (Ubuntu/Debian), as root:

```bash
git clone https://github.com/magnusfroste/agenthotel.git
cd agenthotel
./install.sh
```

That is the whole install. `install.sh` installs Docker, Git and lsof, creates a
2 GB swapfile if the host has none, builds the images with the checked-out
commit baked in, and starts everything — no separate `docker compose up`
afterwards, and no parameters.

Open `http://your-server-ip`, create your admin account, set your panel domain —
and deploy your first agent.

Requirements: ports 80/443 free, and DNS as above. Docker is installed for you
via the official apt repository.

Next: add a provider under **Providers** so agents have a model to use. If that
model runs on your own hardware, see the
[Private models chapter](docs/MANUAL.md#private-models).

## Recommended Hardware

The panel itself is light — 1 vCPU / 1GB RAM runs it fine. What matters is what you run on top of it:

- **2 vCPU / 4GB** — panel plus one or two agents. Each Hermes or OpenClaw agent typically needs ~0.5–1GB RAM of its own.
- **4 vCPU / 8GB** — a comfortable fit for a handful of agents.
- **8 vCPU / 16GB+** — many agents, or a heavier observability stack.

A shared data layer is the heavy guest, and worth budgeting for separately: SkillHub idles at ~1.2GB RAM across eleven containers and its images are ~9.3GB on disk before it holds anything. A 4GB host runs it alongside two agents; it will not have much left over.

The built-in observability (per-agent stats, uptime checks, activity log) is intentionally lightweight and adds no meaningful overhead. If you outgrow it on a bigger host, layer on Prometheus/Grafana/Loki — they run fine side by side as Docker App deployments.

## Runtimes

| Runtime | What it is |
| --- | --- |
| **Hermes** | NousResearch Hermes agent, pre-configured with provider auto-detection |
| **OpenClaw** | OpenClaw persistent agent |
| **Odysseus** | Self-hosted AI workspace with browser tooling |
| **Docker App** | Any Docker image, with env vars and volumes |
| **Git App** | Build straight from a Git repository — for apps that ship a Dockerfile but no image, including the MCP tools your agents call |
| **Git Compose** | Run a whole stack from a repository. For a compose file that mounts its own files — init SQL, a gateway config, edge functions — the repository is the deployable unit; the file alone is not |
| **Compose** | Full `docker-compose.yml` deployments |

## MCP Integration

AgentHotel exposes an MCP endpoint so your own agents can manage the platform:

```json
{
  "mcpServers": {
    "agenthotel": {
      "url": "https://panel.yourdomain.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

**Fleet** — `list_agents`, `get_agent`, `create_agent`, `delete_agent`, `redeploy_agent`, `get_agent_logs`

**Put agents to work** — `ask_agent` hands a hosted agent a task and returns its
reply, or dispatches it in the background so the agent keeps working after the
call returns and you read the outcome from its logs. `set_agent_env` gives an
agent already checked in the credentials its next job needs — stored in its
config, so they survive restarts and redeploys, unlike a token mentioned in a
task message. `exec_in_agent` runs a command inside an agent's container for
inspection. None of them touches the VPS host; that is the panel's own Server
Console.

**Observability** — `health_check`, `get_host_metrics`, `get_agent_stats`, `get_uptime`, `get_docker_usage`, `get_events`, `system_status`, `run_cleanup`

Because both surfaces share one endpoint, a supervising agent can cross-check
what a working agent claims against what the host recorded. See
[Putting agents to work](docs/MANUAL.md#putting-agents-to-work) for dispatching,
watching and correcting a background agent — and for the transport details to
hand an agent along with an external MCP tool.

**Templates** — `list_runtimes`, `list_templates`, `get_template`, `create_template`

The endpoint is off until you enable it under System → MCP Server, and the token
is the panel's own — which is root-equivalent on that host, so treat it
accordingly. Rotate it from the same page.

## Architecture

Three containers, one `docker-compose.yml`:

```
┌────────┐   80/443    ┌──────────┐  /api  ┌─────────┐        ┌────────┐
│  Caddy │ ──────────► │ Frontend │ ─────► │ Backend │ ─────► │ Agents │
│  (TLS) │ ◄────────── │ React SPA│        │ Express │ docker │ (your  │
└────────┘  agent subdomains      │        │ + SQLite│  sock  │  apps) │
                                   └──────────┘        └────────┘
```

- **Caddy** — reverse proxy, automatic Let's Encrypt, dynamic per-agent routes via its admin API
- **Frontend** — React 18 + Vite, served by nginx, lazy-loaded terminal bundle
- **Backend** — Node.js/Express, Docker via dockerode, state in SQLite, token auth

## API Overview

| Area | Endpoints |
| --- | --- |
| Agents | `GET/POST /api/agents`, `GET/PUT/DELETE /api/agents/:id`, `/start`, `/stop`, `/redeploy`, `/logs`, `/terminal` (WS) |
| Observability | `GET /api/agents/:id/stats`, `GET /api/agents/:id/uptime`, `GET /api/events` |
| Templates | `GET /api/templates`, `GET /api/templates/:id`, `GET /api/runtimes` |
| Providers | `GET/POST /api/providers`, `PUT/DELETE /api/providers/:id`, `/test`, `/models` |
| Domains & TLS | `GET /api/domains`, `DELETE /api/domains/:id`, `GET /api/certificates` |
| System | `GET /api/system/stats`, `/status`, `/version`, `/check-update`, `/upgrade-log`, `POST /api/system/upgrade`, `/api/docker/prune`, `GET /api/docker/cleanup-history` |
| Auth | `GET/POST /api/setup`, `POST /api/login`, Bearer token for everything else |

Full list in [`backend/server.js`](backend/server.js).

## Development

```bash
# Rebuild and restart after changes. GIT_COMMIT is baked into the backend image
# at build time — without it the panel reports its version as "unknown".
docker compose build --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) backend frontend
docker compose up -d

# Logs
docker compose logs -f backend
```

See [AGENTS.md](AGENTS.md) for architecture details and build conventions, [docs/MANUAL.md](docs/MANUAL.md) for the user manual (providers, guardrails, operations), and [BACKLOG.md](BACKLOG.md) for the roadmap.

## Troubleshooting

Every entry here is a failure that actually happened, with the check that told us
what it really was. The theme: **measure the thing, don't infer it.**

### A hostname answers, but with nothing

An empty `200` is the answer Caddy gives when it has *no route* for that hostname.
A status-code check calls that healthy, so check the size too:

```bash
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' https://your-agent.example.com/
```

`200 0` means no route. The panel re-checks its routes every minute and restores
missing ones, so this should heal itself — if it does not, the hostname probably
belongs to no agent.

### A hostname answers 502

The route exists and points at a container Caddy cannot reach. For a compose
guest this is almost always the network: compose recreates its containers on
`up`, and a recreated container comes back on the stack's own networks only.

```bash
docker inspect <the target container> --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
```

The panel rejoins compose guests to its network every minute. A route that looks
perfect over a lost network is a 502 that no route check would catch — which is
why the membership is re-checked and not just the route.

### A hostname answers 308 or 404

Nothing is routed there yet. With a Cloudflare Tunnel, check that the hostname
exists as a public hostname on the tunnel (`HTTP` → `agenthotel-caddy:80`) — a
wildcard covers every future guest, but only use one on a zone you are willing to
route entirely here.

### An agent is unhealthy right after a deploy

Give it a minute. Hermes takes ~30 seconds from container start to listening, and
answers 502 until then; its log says `HERMES_DASHBOARD_READY port=9119` when it is
up. The health sweep corrects itself on the next pass.

### A compose stack's database fails to initialise

Symptom: `psql: .../roles.sql: could not read from input file: Is a directory`.
The Docker daemon resolves a stack's bind mounts **on the host**, not inside the
panel — so a checkout that exists only in the panel's own volume is invisible
there, and Docker silently creates an empty directory where the file should be.
Checkouts therefore live at `/var/lib/agenthotel/checkouts`, mounted at the same
path on both sides. If you moved it, move it back.

### An agent cannot reach its model

The model id picks the provider: the prefix is part of the name, so
`openai/gpt-5.6-luna` and `openrouter/...` go to different places. Hermes also
declines a model with less than 64k context at deploy rather than failing later.
If a provider was added *after* the agent, redeploy it — keys are injected on
redeploy, and only into slots that are empty.

Check what the container actually got:

```bash
docker exec <container> env | grep -E 'API_KEY|MODEL'
```

### Logged out of an agent's dashboard after every redeploy

Hermes signs dashboard sessions with a key it generates per process unless one is
configured. The panel now generates `HERMES_DASHBOARD_BASIC_AUTH_SECRET` per agent
and keeps it in the agent's config; agents created before that get one by being
redeployed once on a current panel.

### Careful with what you print

`curl -w '%{url_effective}'` prints the URL **including any credentials you passed
with `-u`**. Two of this project's secrets ended up in a transcript that way. Print
the status code and the byte count; they answer the question without carrying the
password along.

## Trademarks

AgentHotel deploys upstream projects' own container images, and the fleet and
template cards show each project's own logo so you can tell one guest from
another at a glance. The OpenClaw, Hermes and Odysseus names and marks belong to
their respective projects and are used here only to identify the software the
panel runs — the same way an app catalogue lists what it can install. AgentHotel
is not affiliated with or endorsed by any of them.

Logos live in `frontend/public/logos/` and are bundled rather than hotlinked, so
the panel makes no third-party requests. If you maintain one of these projects
and would rather your mark were not used, open an issue and it comes out.

## License

MIT covers AgentHotel's own code. The bundled logos are the property of their
respective projects and are not covered by it.

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
| **The ledger** | Health, uptime, resource use and events — from the UI or over MCP. |

Running AI agents on your own server otherwise means hand-rolled Docker commands, manual reverse-proxy config, and API keys copy-pasted into env files. AgentHotel removes all of that.

## Features

### Agent Management
- **Five runtimes** — Hermes, OpenClaw, Odysseus, generic Docker App, and full Docker Compose deployments
- **Quick Start** — API keys are injected automatically from your configured providers (OpenAI, Anthropic, OpenRouter, Gemini, DeepSeek, Groq, xAI, Mistral, or any OpenAI-compatible endpoint like vLLM)
- **Tabbed agent view** — Overview, Logs, Console, Environment, Credentials and Settings in one place
- **Start / Stop / Redeploy / Delete** from the dashboard, with one-click Open on the agent's URL
- **Web terminal** — full TTY shell into any container via WebSocket + xterm.js

### Template Library
- **Browsable library** — every deployable runtime as a card with its category, tags, default image and port, filtered by search, category or tag
- **Template detail page** — what the template is, what to do after deployment, benefits, features, upstream links, changelog, and the exact config fields the deploy form will ask for
- **Data-driven** — presentation lives in `templates/<id>/meta.yaml`, so a new template needs no frontend change; edits are picked up without restarting the backend

### Deploy Anything
- **Docker App runtime** — deploy any Docker image with port, env vars and volume mounts
- **Compose runtime** — paste a `docker-compose.yml` with env-var editor and YAML validation

### Domains & TLS
- **Automatic HTTPS** — Caddy issues and renews Let's Encrypt certificates for every agent subdomain
- **Live domains view** — real container status, orphaned-route detection and cleanup
- **Certificates panel** — issuer, validity dates, SANs and fingerprints, read live from Caddy's cert store

### Providers & Models
- **Multi-provider system** — add providers once, keys are injected into new agents automatically (and into existing agents on redeploy); every provider gets its own slug-based env vars (`Hetzner` → `HERTZNER_API_KEY` / `HERTZNER_BASE_URL` / `HERTZNER_MODELS`) alongside the canonical slots. **OpenClaw** turns every configured provider into a selectable provider in its model picker, with its model list; Hermes and Odysseus are limited to one active provider at a time by the apps themselves (custom endpoints work via `OPENAI_BASE_URL` / `LLM_HOST` overrides)
- **Provider testing** — list available models and test them per provider, right from the UI

See the [Providers & Models manual chapter](docs/MANUAL.md#providers--models) for the full injection rules and per-runtime behavior.

### Observability & System
- **Dashboard** — app-centric cards with live status, system CPU/RAM/disk stats, auto-refresh; fleet search, status filter and sorting for larger installations
- **Resource guardrails** — the panel can never be frozen out by its own fleet: every agent gets a CPU cap (default 1 core, `CPU_LIMIT`) and RAM cap (default 1024 MB, `MEMORY_LIMIT_MB`), low cpu-shares (256) and a high OOM-kill priority, while the panel containers run at 2048 shares with `oom_score_adj: -500`. Shares only matter under saturation, so agents still use all idle capacity — but the panel always stays responsive, no reboot needed. Host-wide defaults via `DEFAULT_AGENT_CPU` / `DEFAULT_AGENT_MEM_MB`
- **Serialized deploys** — one build/deploy at a time, so concurrent deploys can't saturate the host
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

On a fresh VPS (Ubuntu/Debian), as root:

```bash
git clone https://github.com/magnusfroste/agenthotel.git
cd agenthotel
./install.sh        # installs Docker, then:
docker compose up -d
```

Open `http://your-server-ip`, create your admin account, set your panel domain — and deploy your first agent.

Requirements: Docker + ports 80/443 free. The `install.sh` script handles Docker installation via the official apt repository.

## Recommended Hardware

The panel itself is light — 1 vCPU / 1GB RAM runs it fine. What matters is what you run on top of it:

- **2 vCPU / 4GB** — panel plus one or two agents. Each Hermes or OpenClaw agent typically needs ~0.5–1GB RAM of its own.
- **4 vCPU / 8GB** — a comfortable fit for a handful of agents.
- **8 vCPU / 16GB+** — many agents, or a heavier observability stack.

The built-in observability (per-agent stats, uptime checks, activity log) is intentionally lightweight and adds no meaningful overhead. If you outgrow it on a bigger host, layer on Prometheus/Grafana/Loki — they run fine side by side as Docker App deployments.

## Runtimes

| Runtime | What it is |
| --- | --- |
| **Hermes** | NousResearch Hermes agent, pre-configured with provider auto-detection |
| **OpenClaw** | OpenClaw persistent agent |
| **Odysseus** | Self-hosted AI workspace with browser tooling |
| **Docker App** | Any Docker image, with env vars and volumes |
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

Tools: `list_agents`, `create_agent`, `delete_agent`, `redeploy_agent`, `get_agent_logs`, `system_status`, `list_runtimes`, `list_templates`, `get_template`.

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

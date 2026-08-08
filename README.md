# AgentPanel

**Inspired by Easypanel — spin up your agents, monitor and observe.**

AgentPanel is a self-hosted control panel for AI agents and Docker apps. Point it at a VPS, and you get one-click agent deployment with automatic HTTPS, live logs, web terminals, domain management and provider-aware API key injection — all from a clean web UI, and all scriptable through an MCP server.

## Why AgentPanel?

Running AI agents on your own server usually means hand-rolled Docker commands, manual reverse-proxy config, and API keys copy-pasted into env files. AgentPanel removes all of that:

- **Spin up** an agent in seconds — pick a runtime, name it, done. HTTPS and routing are automatic.
- **Monitor** everything from one dashboard — status, resource usage, logs, domains and certificates, live.
- **Observe & control** — open a web terminal into any container, edit environment variables, redeploy, or let your own AI tools manage the panel over MCP.

## Features

### Agent Management
- **Five runtimes** — Hermes, OpenClaw, Odysseus, generic Docker App, and full Docker Compose deployments
- **Quick Start** — API keys are injected automatically from your configured providers (OpenAI, Anthropic, OpenRouter, Gemini, DeepSeek, Groq, xAI, Mistral, or any OpenAI-compatible endpoint like vLLM)
- **Tabbed agent view** — Overview, Logs, Console, Environment, Credentials and Settings in one place
- **Start / Stop / Redeploy / Delete** from the dashboard, with one-click Open on the agent's URL
- **Web terminal** — full TTY shell into any container via WebSocket + xterm.js

### Deploy Anything
- **Docker App runtime** — deploy any Docker image with port, env vars and volume mounts
- **Compose runtime** — paste a `docker-compose.yml` with env-var editor and YAML validation

### Domains & TLS
- **Automatic HTTPS** — Caddy issues and renews Let's Encrypt certificates for every agent subdomain
- **Live domains view** — real container status, orphaned-route detection and cleanup
- **Certificates panel** — issuer, validity dates, SANs and fingerprints, read live from Caddy's cert store

### Providers & Models
- **Multi-provider system** — add providers once, keys are injected into new agents automatically
- **Provider testing** — list available models and test them per provider, right from the UI

### Observability & System
- **Dashboard** — app-centric cards with live status, system CPU/RAM/disk stats, auto-refresh
- **Per-agent resource stats** — live CPU, memory and network usage per container, refreshed every 5s on the agent's Overview tab
- **Uptime monitoring** — HTTPS checks every minute for running agents with a domain, 24h/7d percentages and a 50-check history strip, with `agent.up`/`agent.down` events on state transitions
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
git clone https://github.com/magnusfroste/agentpanel.git
cd agentpanel
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

AgentPanel exposes an MCP endpoint so your own agents can manage the platform:

```json
{
  "mcpServers": {
    "agentpanel": {
      "url": "https://panel.yourdomain.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

Tools: `list_agents`, `create_agent`, `delete_agent`, `redeploy_agent`, `get_agent_logs`, `system_status`, `list_runtimes`.

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
| Providers | `GET/POST /api/providers`, `PUT/DELETE /api/providers/:id`, `/test`, `/models` |
| Domains & TLS | `GET /api/domains`, `DELETE /api/domains/:id`, `GET /api/certificates` |
| System | `GET /api/system/stats`, `/status`, `/version`, `/check-update`, `POST /api/docker/prune`, `GET /api/docker/cleanup-history` |
| Auth | `GET/POST /api/setup`, `POST /api/login`, Bearer token for everything else |

Full list in [`backend/server.js`](backend/server.js).

## Development

```bash
# Rebuild and restart after changes
docker compose build backend frontend
docker compose up -d

# Logs
docker compose logs -f backend
```

See [AGENTS.md](AGENTS.md) for architecture details and build conventions, and [BACKLOG.md](BACKLOG.md) for the roadmap.

## License

MIT

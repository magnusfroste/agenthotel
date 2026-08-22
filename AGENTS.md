# AgentHotel - Agent Instructions

## Architecture

Three-container system managed by docker-compose:
- **backend** (Node.js/Express): Manages AI agent containers via Docker API (dockerode), stores state in SQLite
- **frontend** (React/Vite): Served by nginx, talks to backend via `/api/*`
- **caddy**: Reverse proxy, routes panel traffic and dynamically manages agent subdomain routes

Backend requires `/var/run/docker.sock` to create/manage agent containers.

The backend also runs with `pid: host` + `privileged: true` so the Server Console page can `nsenter` into the host's namespaces (PID 1) and run commands on the VPS host (privileged is required because AppArmor/seccomp otherwise block the namespace switch); the docker.sock mount already grants host-root equivalence, so this adds no real privilege.

## Resource Guardrails

The panel is self-protecting (no Docker Swarm — deliberately, plain Docker only):
- Panel containers (backend/frontend/caddy) run with `cpu_shares: 2048` and `oom_score_adj: -500`
- Agent containers are created with `cpu_shares: 256`, `OomScoreAdj: 500`, `PidsLimit: 512`, plus CPU/RAM caps (defaults 1 core / 1024 MB, overridable per agent via `CPU_LIMIT` / `MEMORY_LIMIT_MB` in the agent config, host-wide via `DEFAULT_AGENT_CPU` / `DEFAULT_AGENT_MEM_MB`)
- Shares only matter under CPU saturation, so agents use all idle capacity but can never starve the panel

## Critical Build Details

**Dockerfiles use `npm install`, not `npm ci`** - No lock files are committed. This is intentional so the install script works on fresh VPS without pre-generated lock files. Do not change to `npm ci` without understanding this tradeoff.

Backend Dockerfile: `npm install --omit=dev`
Frontend Dockerfile: `npm install` then `npm run build`

## Caddy Configuration

Caddy uses JSON config (`docker/caddy.json`), loaded via `caddy run --config /etc/caddy/caddy.json`. Uses `caddy:2` (full image, not alpine) because the alpine variant lacks the `letsencrypt` TLS module required for automatic HTTPS.

Backend dynamically adds/removes agent routes via Caddy admin API:
- Add: `POST http://caddy:2019/config/apps/http/servers/srv0/routes` with `@id: "agent-${domain}"`
- Remove: `DELETE http://caddy:2019/id/agent-${domain}`

## Runtime Plugins

Backend supports four agent runtimes in `backend/plugins/`:
- `hermes`: NousResearch Hermes agent
- `openclaw`: OpenClaw persistent agent
- `odysseus`: Self-hosted AI workspace
- `docker-app`: Generic Docker image deployment

Each runtime has a template in `templates/<runtime>/Dockerfile` (except docker-app which pulls images directly).

**Template images are only built once** — deploy reuses `<runtime>-agenthotel:latest` if it exists. After changing a template Dockerfile (e.g. the openclaw entrypoint that generates `openclaw.json` from `<SLUG>_API_KEY` / `<SLUG>_BASE_URL` / `<SLUG>_MODELS` env triplets), remove the image (`docker rmi <runtime>-agenthotel:latest`) and redeploy the agent to rebuild.

## Template Library

`GET /api/templates` and `/api/templates/:id` (plus the `list_templates` / `get_template` MCP tools) are served by `backend/lib/templates.js`.

The **runtime plugins drive the list** — a runtime without a `meta.yaml` still appears, using the plugin's own name and description. `templates/<id>/meta.yaml` only adds presentation: `name`, `category`, `icon`, `color`, `description`, `instructions`, `benefits`, `features`, `links`, `changeLog`, `tags`. The `icon` is a name resolved to a Lucide component in `frontend/src/lib/templateIcons.js`, so adding a template needs no frontend change.

**`plugin.configFields` is the single source of truth for configuration.** meta.yaml files used to carry a parallel `schema:` block that had already diverged from the real field names (`hermesModel` vs `HERMES_MODEL`); those blocks are gone. If the schema-driven deploy form on the backlog gets built, generate it from `configFields` — they are already typed (`text`/`password`/`number`/`textarea`, with `required`, `default`, `placeholder`). Never reintroduce a second config definition.

Parsed meta.yaml is cached per file and invalidated on mtime, so editing a template on the host shows up without restarting the backend. A malformed meta.yaml logs `[Templates] Failed to parse …` and falls back to plugin metadata — one broken file never takes the library down.

## Persistent Web Terminal

The Console tab's shell runs inside a tmux session (`tmux new -A -s agenthotel`),
so it lives in the container rather than on the WebSocket. Closing the tab,
navigating away, reloading or a network blip no longer kills the shell or
whatever is running in it — reconnecting reattaches to the same prompt with its
scrollback intact. A redeploy still ends it, since the container is replaced.

tmux is configured to be invisible rather than to expose itself:

- `status off` — no tmux chrome; it reads as a plain shell
- `prefix None` — **do not change this.** The default prefix is Ctrl-B, which is
  readline's cursor-left; stealing it breaks line editing in every shell session
- `mouse on` — tmux's alternate screen disables xterm.js scrollback, so the
  wheel has to scroll tmux's own history instead
- `history-limit 10000` — bounded, so a long-lived session cannot grow without
  limit in container memory

The config is written to `/tmp/.agenthotel-tmux.conf` at connect time rather
than baked into the images, so it also applies to any docker-app image that
happens to ship tmux. When tmux is absent — the normal case for arbitrary
docker-app bases — the handler falls back to the previous `bash -i` / `sh -i`
behaviour, so nothing regresses. `tmux` is installed in the hermes, openclaw and
odysseus templates.

Consequence worth knowing: a forgotten session keeps running. That is the point,
but a runaway command will keep consuming the agent's CPU allowance with nobody
attached; the resource caps bound it and the health check surfaces the fallout.

## Install Script

`install.sh` installs Docker via official apt repository (not `curl | sh`), following Easypanel's pattern. It performs pre-flight checks (root, ports 80/443 free, not in container). **No parameters required** - just run as root.

## Authentication & Setup Flow

Following Easypanel's pattern, the panel uses a web-based setup flow:

1. **First visit via IP** - User accesses `http://server-ip`
2. **Setup page** - Creates admin account (email + password, min 8 chars)
3. **Login** - Subsequent visits require authentication
4. **Token-based auth** - JWT-like tokens stored in localStorage, sent via `Authorization: Bearer <token>` header or `?token=` query param for WebSocket

Backend stores in SQLite `settings` table:
- `admin_email`, `admin_password_hash`, `admin_password_salt`, `auth_token`

Endpoints:
- `GET /api/setup` - Returns `{configured: boolean}`
- `POST /api/setup` - Creates admin account, returns token
- `POST /api/login` - Validates credentials, returns token
- All `/api/agents/*` routes require auth via `requireAuth` middleware

## Local Development

No test suite, linting, or CI exists. To test changes:
```bash
# Rebuild and restart containers
docker compose build
docker compose up -d

# Check logs
docker compose logs -f backend
docker compose logs -f caddy
```

Backend runs on port 8080 internally, exposed via Caddy on 80/443.

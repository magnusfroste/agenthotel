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

**Dockerfiles use `npm install`, not `npm ci`.** `backend/package-lock.json` and `frontend/package-lock.json` are committed — CI installs from them with `npm ci` — but the images deliberately do not, so a fresh VPS install never fails on a lock file that drifted from `package.json`. Do not switch the Dockerfiles to `npm ci` without weighing that.

Backend Dockerfile: `npm install --omit=dev`
Frontend Dockerfile: `npm install` then `npm run build`

## Caddy Configuration

Caddy uses JSON config (`docker/caddy.json`), loaded via `caddy run --config /etc/caddy/caddy.json`. Uses `caddy:2` (full image, not alpine) because the alpine variant lacks the `letsencrypt` TLS module required for automatic HTTPS.

Backend dynamically adds/removes agent routes via Caddy's admin API, which listens **only on a Unix socket** (`unix//run/caddy-admin/admin.sock`) in the `caddy-admin` volume that Caddy and the backend mount, and nothing else. **Never put it back on TCP** (`0.0.0.0:2019` or any port): guests share Caddy's Docker network, and an unauthenticated admin API there let any guest rewrite every route, including the panel's own (security sweep, 2026-09-30). Every call goes through `caddyFetch` in `backend/lib/caddyAdmin.js`:
- Add: `POST /config/apps/http/servers/srv0/routes` with `@id: "agent-${domain}"`
- Remove: `DELETE /id/agent-${domain}`

The panel route carries security headers (`X-Frame-Options`, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy`) and is re-created each minute if Caddy lost it.

## Runtime Plugins

Backend supports seven runtimes in `backend/plugins/`:
- `hermes`: NousResearch Hermes agent
- `openclaw`: OpenClaw persistent agent
- `odysseus`: Self-hosted AI workspace
- `docker-app`: Generic Docker image deployment
- `git-app`: Builds a repository's Dockerfile (how reel-studio and Lobby deploy)
- `git-compose`: Runs a repository's compose file, for stacks that mount their own files (SkillHub)
- `compose`: A compose file given as text

Templates in `templates/<id>/meta.yaml` with a `deploy:` block are recipes on top of these runtimes (`runtime: docker-app | compose | git-app | git-compose`), with `secrets:` generated per deploy.

Providers come in two kinds, decided by name (`backend/lib/builtinProviders.js`): a **built-in** (OpenAI, OpenRouter, Anthropic, …) hands a guest only its key, `<SLUG>_API_KEY`; an **own endpoint** also hands over `<SLUG>_BASE_URL` and `<SLUG>_MODELS`. Agents name models as `provider/model` — a bare name lets Hermes guess the vendor from it.

Each runtime has a template in `templates/<runtime>/Dockerfile` (except docker-app which pulls images directly).

**A rebuild removes the image it replaces** (`backend/lib/replacedImages.js`). `ensureAgentImage` notes the image id the tag pointed to before the build; once the agent's new container has settled healthy (six good health checks in a row, 15 min at most), that image is removed — never forced, and only when no container, running or stopped, still uses it. A Git App rebuilds `agenthotel-<id>:latest` on every redeploy, and six reel-studio redeploys (~2.5 GB each) filled a 38 GB disk before this (2026-10-09). A template image `<runtime>-agenthotel:latest` is shared, so the old one is kept while any other agent of that runtime still runs it, and removed by the deploy that moves the last one off. A failed removal is logged and never fails the deploy; a deploy that never settles keeps the old image. The list is in memory, so a panel restart forgets it and the manual prune reclaims the rest. compose and git-compose run `up -d` without `--build`, so they never retag and are not covered.

**Overlapping or back-to-back rebuilds of one agent never lose an image** (2026-10-09: reel-studio redeployed from the button and over MCP a minute apart, same commit; the MCP path ran outside the deploy queue, both builds read the same "previous" image, and the first build's 2.5 GB image was never retired). Every deploy path — REST create/redeploy/`PUT /api/agents/:id`, and the MCP `create_agent`/`set_agent_env`/`redeploy_agent` tools — goes through `enqueueDeploy`, and MCP `redeploy_agent` *is* `redeployAgent`. `replacedImages.rebuilt()` retires both what the tag pointed at before the build and the last image the panel built under that tag, and each deploy releases only what was retired up to its own build (`mark()`), so an earlier deploy settling never frees a later build's rollback image. An image its tag points at again is never removed. A redeploy asked for while an identical one (same agent, same config, same rebuild flag) is queued joins it; one asked for while it is running joins it only when the running build's commit is what `GIT_REF` names now (git-app `remoteRevision`, `git ls-remote`) or the agent reads no repository (`backend/lib/redeployGate.js`).

**An upgrade never cuts a deploy off silently** (`backend/lib/deploysInFlight.js`). Every deploy runs inside the backend, so recreating it kills a build part-way (2026-10-09: an OpenClaw build died at step 7/18, no image, the guest left "missing: container not found"). `POST /api/system/upgrade` answers 409 naming the agents mid-deploy (rows in `creating`/`redeploying`, plus the `buildProgress` step) unless the body has `force: true`; `GET /api/system/deploys` is what the Upgrade confirm dialog reads to offer *Upgrade anyway* or wait. At start, rows a restart left mid-deploy are not resumed: a guest whose old container still runs goes back to `running`, any other is `failed` with health `interrupted: interrupted by a panel restart — redeploy to finish`, which the health sweep keeps until a container exists. Builds run with `forcerm`, and stopped non-agent containers (an interrupted build's intermediate) are pruned at that start.

**The health sweep never judges a deploy whose build is running** (`sweepInFlight` in `backend/lib/deploysInFlight.js`). A `creating`/`redeploying` row with a live `buildProgress` entry keeps its status and gets health `building: step 10/18` (2026-10-09: a 28-minute OpenClaw build showed FAILED from minute 15). The 15-minute escape hatch counts from the status write or the end of the build, whichever is later, so a deploy that died with no build running is still judged; a failed build is judged at once, and with no container its health is `missing: build failed: <error>`. Deploys run one at a time (`enqueueDeploy`), and `deployQueue` holds each agent's place: a deploy waiting behind another's long build gets health `queued: waiting for 1 deploy ahead`, is never judged, and its 15 minutes start when its turn comes.

**Template images are only built once** — deploy reuses `<runtime>-agenthotel:latest` if it exists. After changing a template Dockerfile (e.g. the openclaw entrypoint that generates `openclaw.json` from `<SLUG>_API_KEY` / `<SLUG>_BASE_URL` / `<SLUG>_MODELS` env triplets), remove the image (`docker rmi <runtime>-agenthotel:latest`) and redeploy the agent to rebuild.

## Template Library

`GET /api/templates` and `/api/templates/:id` (plus the `list_templates` / `get_template` MCP tools) are served by `backend/lib/templates.js`.

The **runtime plugins drive the list** — a runtime without a `meta.yaml` still appears, using the plugin's own name and description. `templates/<id>/meta.yaml` only adds presentation: `name`, `category`, `icon`, `color`, `description`, `instructions`, `benefits`, `features`, `links`, `changeLog`, `tags`. The `icon` is a name resolved to a Lucide component in `frontend/src/lib/templateIcons.js`, so adding a template needs no frontend change.

**`plugin.configFields` is the single source of truth for configuration.** meta.yaml files used to carry a parallel `schema:` block that had already diverged from the real field names (`hermesModel` vs `HERMES_MODEL`); those blocks are gone. If the schema-driven deploy form on the backlog gets built, generate it from `configFields` — they are already typed (`text`/`password`/`number`/`textarea`, with `required`, `default`, `placeholder`). Never reintroduce a second config definition.

Parsed meta.yaml is cached per file and invalidated on mtime, so editing a template on the host shows up without restarting the backend. A malformed meta.yaml logs `[Templates] Failed to parse …` and falls back to plugin metadata — one broken file never takes the library down.

## Chat (ACP)

The Chat page (top bar → Chat, `frontend/src/components/Chat.jsx`) talks to
agents over the Agent Client Protocol (https://agentclientprotocol.com) — one,
two or four panes, and "Send to all" asks every open agent the same thing.
A runtime opts in with `acp: { command, cwd }` in its plugin (hermes:
`hermes acp`, openclaw: `openclaw acp`, run as `terminalUser`); `/api/runtimes`
reports it, and agents without it are not offered.

Each pane is a WebSocket to `/api/agents/:id/acp`, which starts the ACP command
in the agent's container with `docker exec` (no TTY) and moves JSON-RPC lines
both ways (`backend/lib/acpBridge.js`). Messages that arrive before the process
is up are queued — the browser sends `initialize` the moment the socket opens.
The protocol itself lives in the browser (`frontend/src/lib/acpClient.js`):
initialize, session/new (authenticating with the agent's configured method if
it asks), session/prompt, session/cancel, permission requests as buttons. The
client offers no filesystem or terminal of its own; the agent works with its
own tools in its own container. Every pane is a process (`hermes acp` is a full
Hermes, 200-300 MB), so sessions are capped at 4 per agent and 8 in total, and a
session ends with its socket: stdin closes, then SIGTERM by host pid after 3 s.

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

1. **First visit via IP** - User accesses `http://server-ip/?setup=<code>`, the link `install.sh` prints
2. **Setup page** - Creates admin account (email + password, min 8 chars) **and requires the one-time setup code** generated at first boot (`agenthotel setup-code` shows it). Without it, the first stranger to reach a fresh panel on port 80 became admin — root on the host. The code is deleted once the admin exists
3. **Login** - Subsequent visits require authentication
4. **Token-based auth** - JWT-like tokens stored in localStorage, sent via `Authorization: Bearer <token>` header or `?token=` query param for WebSocket

Backend stores in SQLite `settings` table:
- `admin_email`, `admin_password_hash`, `admin_password_salt`, `auth_token`

Endpoints:
- `GET /api/setup` - Returns `{configured, codeRequired}`
- `POST /api/setup` - Creates admin account given `setupCode`, returns token; throttled
- `POST /api/login` - Validates credentials, returns token
- All `/api/agents/*` routes require auth via `requireAuth` middleware

## Local Development

There is a test suite (`backend/test/*.test.js`, `node:test`) and GitHub Actions runs it on every push (`.github/workflows/test.yml`). Run it before committing — no host Node needed:
```bash
docker run --rm -v $PWD:/src:ro node:22-alpine sh -c "apk add -q python3 make g++ >/dev/null; cp -r /src /w && cd /w/backend && npm ci --silent && npm test"
```
To test changes in the running panel:
```bash
# Rebuild and restart containers. GIT_COMMIT is a build arg baked into the
# backend image (ARG -> ENV in backend/Dockerfile) and is what
# /api/system/version and /api/system/check-update report — always pass it, or
# the panel reports its version as "unknown".
docker compose build --build-arg GIT_COMMIT=$(git rev-parse --short HEAD)
docker compose up -d

# Check logs
docker compose logs -f backend
docker compose logs -f caddy
```

The backend does not listen on the Docker network. In compose (`BACKEND_SOCKET` set) it answers on a Unix socket, `/run/agenthotel/backend.sock`, in the `agenthotel-run` volume that only Caddy and the backend mount, and on `127.0.0.1:8080` inside its own container for the upgrade's readiness check. Guests share the network with Caddy and must never reach the API except through Caddy — do not add a network listener, and do not add an `/api` proxy to the frontend's nginx. Without `BACKEND_SOCKET` (development) it listens on `0.0.0.0:8080` as before.

## Panel layout

The chrome follows OpenRouter's split (`frontend/src/App.jsx`). The **sidebar**
runs the full height with the brand on top, level with the bar; the **top bar**
starts where it ends, and
holds what you work with — Fleet, Templates, Connect (wiring your own AI
agents to the hotel over MCP), Docs — and, on the right, *New
agent* (Agent / From a template / Compose), the light/dark/system switch and
the account menu (Profile, Settings, copy host IP, log out). The **sidebar**
holds what you look after: the agents, then Infrastructure (Providers,
Domains, Certificates, Console, System), and the version in its
footer. A new page goes in one of those two places, not both.

Settings (in the account menu) is only your own choices — security and
notifications. A setting about the installation lives on its page as a
`SettingCard` (`frontend/src/components/SettingCard.jsx`, saving only its own
keys): the panel domain on Domains, the certificate e-mail on Certificates,
the Docker network and backup/migration (`InstanceBackup.jsx`) on System. The theme is
`frontend/src/lib/theme.js`, applied in `main.jsx` before the first render so
the login page follows it too; `system` tracks `prefers-color-scheme` live.

## Secrets on screen

Any element that can show a secret — a key, token, password, a credentials
value, MCP server headers, a compose .env, logs, the terminal — carries a
`data-secret` attribute. It does nothing in the panel; it is what a screen
recording blurs: reel-studio's `start_session(mask=["[data-secret]",
"input[type=password]"])` keeps every marked element unreadable from the first
frame. A new component that renders a secret must add it, or a demo video of
that page shows the secret.

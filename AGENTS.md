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

**Every guest gets the visitor's address as `X-Real-IP`.** Agent routes set it from Caddy's `{http.vars.client_ip}`, and `srv0` reads `X-Forwarded-For` strictly (`client_ip_headers`, `trusted_proxies_strict: 1` — in `docker/caddy.json`, and set at start by `realClientIp()` so an upgrade needs no Caddy restart): the right-most address that is not a trusted proxy. Behind the tunnel that is the visitor, not cloudflared; behind NetBird, not the mesh proxy; reached directly, the connection's own address, whatever the visitor sends. A guest that logs or throttles by address should read `X-Real-IP` (AgentReports: `TRUSTED_PROXY_HEADER=X-Real-IP`). A guest on the shared Docker network is itself a trusted hop and can claim any address — the network is shared, so a hostile guest could reach the other guest's port directly anyway.

The panel route carries security headers (`X-Frame-Options`, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy`) and is re-created each minute if Caddy lost it.

## Runtime Plugins

Backend supports seven runtimes in `backend/plugins/`:
- `hermes`: NousResearch Hermes agent
- `openclaw`: OpenClaw persistent agent
- `odysseus`: Self-hosted AI workspace
- `docker-app`: Generic Docker image deployment
- `git-app`: Builds a repository's Dockerfile (how Take — AgentTake, formerly reel-studio — and Lobby deploy)
- `git-compose`: Runs a repository's compose file, for stacks that mount their own files (SkillHub)
- `compose`: A compose file given as text

Templates in `templates/<id>/meta.yaml` with a `deploy:` block are recipes on top of these runtimes (`runtime: docker-app | compose | git-app | git-compose`), with `secrets:` generated per deploy.

Providers come in two kinds, decided by name (`backend/lib/builtinProviders.js`): a **built-in** (OpenAI, OpenRouter, Anthropic, …) hands a guest only its key, `<SLUG>_API_KEY`; an **own endpoint** also hands over `<SLUG>_BASE_URL` and `<SLUG>_MODELS`. Agents name models as `provider/model` — a bare name lets Hermes guess the vendor from it.

Each runtime has a template in `templates/<runtime>/Dockerfile` (except docker-app which pulls images directly).

**A rebuild removes the image it replaces** (`backend/lib/replacedImages.js`). `ensureAgentImage` notes the image id the tag pointed to before the build; once the agent's new container has settled healthy (six good health checks in a row, 15 min at most), that image is removed — never forced, and only when no container, running or stopped, still uses it. A Git App rebuilds `agenthotel-<id>:latest` on every redeploy, and six reel-studio redeploys (~2.5 GB each) filled a 38 GB disk before this (2026-10-09). A template image `<runtime>-agenthotel:latest` is shared, so the old one is kept while any other agent of that runtime still runs it, and removed by the deploy that moves the last one off. A failed removal is logged and never fails the deploy; a deploy that never settles keeps the old image. The list is in memory, so a panel restart forgets it and the manual prune reclaims the rest. compose and git-compose run `up -d` without `--build`, so they never retag and are not covered.

**Overlapping or back-to-back rebuilds of one agent never lose an image** (2026-10-09: reel-studio redeployed from the button and over MCP a minute apart, same commit; the MCP path ran outside the deploy queue, both builds read the same "previous" image, and the first build's 2.5 GB image was never retired). Every deploy path — REST create/redeploy/`PUT /api/agents/:id`, and the MCP `create_agent`/`set_agent_env`/`redeploy_agent` tools — goes through `enqueueDeploy`, and MCP `redeploy_agent` *is* `redeployAgent`. `replacedImages.rebuilt()` retires both what the tag pointed at before the build and the last image the panel built under that tag, and each deploy releases only what was retired up to its own build (`mark()`), so an earlier deploy settling never frees a later build's rollback image. An image its tag points at again is never removed. A redeploy asked for while an identical one (same agent, same config, same rebuild flag) is queued joins it; one asked for while it is running joins it only when the running build's commit is what `GIT_REF` names now (git-app `remoteRevision`, `git ls-remote`) or the agent reads no repository (`backend/lib/redeployGate.js`).

**An upgrade never cuts a deploy off silently** (`backend/lib/deploysInFlight.js`). Every deploy runs inside the backend, so recreating it kills a build part-way (2026-10-09: an OpenClaw build died at step 7/18, no image, the guest left "missing: container not found"). `POST /api/system/upgrade` answers 409 naming the agents mid-deploy (rows in `creating`/`redeploying`, plus the `buildProgress` step) unless the body has `force: true`; `GET /api/system/deploys` is what the Upgrade confirm dialog reads to offer *Upgrade anyway* or wait. At start, rows a restart left mid-deploy are not resumed: a guest whose old container still runs goes back to `running`, any other is `failed` with health `interrupted: interrupted by a panel restart — redeploy to finish`, which the health sweep keeps until a container exists. Builds run with `forcerm`, and stopped non-agent containers (an interrupted build's intermediate) are pruned at that start.

**The health sweep never judges a deploy whose build is running** (`sweepInFlight` in `backend/lib/deploysInFlight.js`). A `creating`/`redeploying` row with a live `buildProgress` entry keeps its status and gets health `building: step 10/18` (2026-10-09: a 28-minute OpenClaw build showed FAILED from minute 15). The 15-minute escape hatch counts from the status write or the end of the build, whichever is later, so a deploy that died with no build running is still judged; a failed build is judged at once, and with no container its health is `missing: build failed: <error>`. Deploys run one at a time (`enqueueDeploy`), and `deployQueue` holds each agent's place: a deploy waiting behind another's long build gets health `queued: waiting for 1 deploy ahead`, is never judged, and its 15 minutes start when its turn comes.

**Every deploy is recorded with its full log** (`backend/lib/deployLog.js`). `enqueueDeploy(work, agentId, { kind, trigger, config })` writes a `deployments` row (queued → running → succeeded / failed; a restart marks one cut off `interrupted`) and a log file per deploy under `/data/deploy-logs/<id>.log`. The deploy's work runs in an AsyncLocalStorage context and console output made inside it is copied into its log, so deploy code narrates itself with plain `console.log`; docker build output is attributed by agent id (`noteBuildEvent`), and runtime plugins that run compose call `deployLog.note()`. Secret-looking config values are masked before a line is written, and the viewer is `data-secret`. Logs cap at 5 MB, 30 deploys are kept per agent. The agent page's **Deployments** tab lists them and follows a running one by polling `GET /api/agents/:id/deployments/:deployId/log?offset=`; Redeploy switches to it. Agents read the same over MCP with `get_deploy_log`. A new deploy path must go through `enqueueDeploy` with an agent id, or it is neither queued nor logged.

**A Git App can be rolled back to a commit it ran before** (`backend/lib/rollback.js`, `POST /api/agents/:id/rollback {deploymentId}`, the *Roll back* button on a past deploy in the Deployments tab). A Git App deploy records the full sha it was built from (`prepareBuild` returns `commitFull`; deploys before 2026-10-28 kept seven characters and are refused with a reason, since `git fetch` takes a full sha). A rollback is `redeployAgent(id, { ref: sha, kind: 'rollback' })`: one deploy built from that commit, through the same queue and log, while the saved config keeps its `GIT_REF`, so the next redeploy follows the branch again and the Fleet's update marker shows the guest is behind until then.

**Every guest's memory is backed up every night** (`backend/lib/backups.js`, System → Backups, 2026-10-28). At the configured hour (UTC, `backup_hour`, checked every ten minutes, once a day) each guest gets `/data/backups/<name>/<stamp>/`: `agent.json` (the export's manifest, environment and keys included, mode 600) and one `<volume>.tar.gz` per volume, written by a helper container straight into the panel's data volume while every running container that mounts those volumes is paused (`containersUsing`, found by volume, so compose stacks pause too) and unpaused in a `finally`. The newest `backup_keep_local` stay on the host. With an S3 bucket (`backup_s3_*`: any S3 API, path-style; Hetzner Object Storage, R2, Backblaze, MinIO) each backup is uploaded and the bucket keeps `backup_keep_remote`. The secret (`backup_s3_secret_key`) is never returned by `/api/settings` or `/api/backups`; the card sees its last four. A guest mid-deploy is skipped that night; an upgrade asked for while a backup runs answers 409 (it would recreate the process that unpauses guests), and at start `thawPausedGuests()` unpauses any container mounting an `agenthotel-` volume that a cut-off backup left paused; a failed guest or upload is in the event log and the notification. **Restore** (`POST /api/agents/:id/restore {stamp}`) backs the guest up as it is first, stops it, replaces each volume's contents from the backup, and starts it (`startAgentRuntime`); a backup of an earlier guest with the same name is refused (import it instead). Backups of deleted guests stay on the host and are listed.

**Every copy of a volume is checked against its source** (`backend/lib/volumeCensus.js`, 2026-10-29). Moving "magnus" reported "3 volume(s) restored" while its 1.1 GB `/opt/data` arrived as one cache file (the TTY bug in `lib/volumeTar.js`), because nothing compared what left with what arrived. A census is a volume's file count, byte total (hard links once) and symlink count (sockets, fifos and directories are not counted: tar skips sockets, which a live Hermes home has), taken in a helper container with busybox `find`/`stat`/`awk`, and of an archive from its own `tar tv` listing. An **export** tars every volume and checks each archive against its volume *before* the zip starts streaming (so a mismatch is an error response, not a truncated download) and ships `volumes/census.json`; an **import** checks each unpacked volume against it and rolls the whole import back on a mismatch (an export from an older hotel has no census and is unpacked unchecked, said in the log). A **backup** takes the census while the guest is still paused, checks the `.tar.gz`, and records `census` and `verifiedAt` in `agent.json` (the Backups card shows *verified*); a **restore** checks each volume after unpacking and does not start the guest on a mismatch. A copy that does not match is never reported as done.

**An agent can move to another hotel** (`backend/lib/transfers.js`), which is AgentHotel's answer to lock-in: its memory is the harness's own files, and they go with it. Hotel A issues a one-time transfer URL (`POST /api/agents/:id/transfer`, or Export → *Move to another hotel*, or MCP `create_transfer`): valid one hour, spent by its first pull, only a hash stored. Hotel B fetches it server to server (`POST /api/agents/import-from`, Import Agent → *From another hotel*, or MCP `import_from_hotel` + `get_import_status`), in the background, so an agent's gigabytes never pass through a browser or Cloudflare's 100 MB upload limit. `GET /api/transfer/:token` is the only unauthenticated agent route — the ticket is the credential, throttled per address. With data, the pull stops the agent on A at that moment (`stopOnPull`, default), so it never runs in two hotels; it stays on A, stopped, until deleted. Export and the pull share `writeAgentExport`; upload and pull share `importAgentZip`, which arrives stopped and rolls back fully on failure.

**A Git App build never reads its checkout's `.git`** (`backend/lib/buildContext.js`). The panel packs the build context itself (tar-fs), so a repository's `.dockerignore` only applies after every file was already read. After a fetch, git may start `gc --auto` detached and prune loose objects while the context is being packed: agent-take's deployment 54 failed with `ENOENT … lstat '.git/objects/be/…'` and an identical retry a minute later succeeded (2026-10-27). `prepareBuild` now returns `exclude: [<checkout>/.git]` (the commit reaches the image as the `GIT_SHA` build arg), and every git command in a checkout, Git App's and `lib/gitCheckout.js`'s, runs with `NO_DETACHED_GC` (`-c gc.autoDetach=false -c maintenance.autoDetach=false`), so the cleanup still runs, but inside the git call and before the build starts.

**Build cache lives in untagged images.** With Docker's containerd image store (Docker 29), the classic builder the panel uses (`docker.buildImage`, "Step n/m") caches each step as an untagged intermediate image, and `--cache-from` fails on that store. The daily cleanup therefore prunes only untagged images older than a week (`pruneImages({ filters: { until: ['168h'] } })`); replaced agent images are still removed at once by `replacedImages`. Do not run `docker image prune` by hand after a deploy, or the next rebuild starts from scratch.

**Template images are only built once** — deploy reuses `<runtime>-agenthotel:latest` if it exists. After changing a template Dockerfile (e.g. the openclaw entrypoint that generates `openclaw.json` from `<SLUG>_API_KEY` / `<SLUG>_BASE_URL` / `<SLUG>_MODELS` env triplets), remove the image (`docker rmi <runtime>-agenthotel:latest`) and redeploy the agent to rebuild.

**The Fleet and the sidebar mark agents that could be updated** (`backend/lib/agentUpdates.js`, `GET /api/agents/updates`, `frontend/src/components/UpdateDot.jsx`): a quiet dot beside the name, the details in its tooltip. A Git App compares the commit of its last succeeded deploy with what its ref names now (`remoteRevision`, `git ls-remote`); a template runtime (Hermes, OpenClaw) is behind when the panel holds a newer image of it (redeploy) or upstream published a newer base (rebuild — needs the base image pulled locally to tell). docker-app and compose show nothing: no reliable "latest" to compare. Cached 15 minutes on the server, invalidated whenever a deploy finishes; the browser looks again every five, and at once when a card's deploy settles. Each Fleet card has a Redeploy button (blue when its agent is marked, a rebuild when the marker says so), so an update is one click instead of a visit to the agent's page; the request lasts as long as the deploy, so the card shows the build and a toast reports the end.

**An uptime alert is an outage, not a blip** (`backend/lib/uptimeAlerts.js`, 2026-10-28). Every running guest's domain is probed once a minute; a guest is *down* after three failed probes in a row and *back up* on the first good one, a guest waiting in `deployQueue` does not count its failures, and when three or more guests change state in the same sweep the notification is one message naming them (the host or its network, not the guests). Before this, the first failed probe sent "down" and the next minute "back up": a redeploy's seconds of 502 reached the operator's phone, and the full disk of 2026-10-20 sent one message per guest. Every change still goes into the event log per guest.

## Template Library

`GET /api/templates` and `/api/templates/:id` (plus the `list_templates` / `get_template` MCP tools) are served by `backend/lib/templates.js`.

The **runtime plugins drive the list** — a runtime without a `meta.yaml` still appears, using the plugin's own name and description. `templates/<id>/meta.yaml` only adds presentation: `name`, `category`, `icon`, `color`, `description`, `instructions`, `benefits`, `features`, `links`, `changeLog`, `tags`. The `icon` is a name resolved to a Lucide component in `frontend/src/lib/templateIcons.js`, so adding a template needs no frontend change.

**`plugin.configFields` is the single source of truth for configuration.** meta.yaml files used to carry a parallel `schema:` block that had already diverged from the real field names (`hermesModel` vs `HERMES_MODEL`); those blocks are gone. If the schema-driven deploy form on the backlog gets built, generate it from `configFields` — they are already typed (`text`/`password`/`number`/`textarea`, with `required`, `default`, `placeholder`). Never reintroduce a second config definition.

**The library takes agents and the tools agents use, nothing else** (Magnus, 2026-10-27: "a hotel for agents — their luggage of tools is welcome too, but only if an agent can use them"). A template with a `deploy:` block that is not an agent itself carries `agentUse:` — how an agent reaches it (MCP address, where its key comes from) — shown as *How agents use it* on the template page; `templates.test.js` fails on one without it. CONTRIBUTING.md (*What belongs in the library*) and the template-request issue form say the same to contributors.

A docker-app template has the same tools as a git-app one: `envFile` with `${DOMAIN}` and generated `secrets:`, a `healthcheck`, and `volumes:` — named volumes only (`n8n:/home/node/.n8n` becomes `agenthotel-<id>-n8n`); a host path is dropped, since a template is installed by people who never read it.

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
Hermes, 200-300 MB), so sessions are capped at 4 per agent and 8 in total, and
none starts while the host has under 400 MB available.

A chat survives a reload, a visit to another page or a network blip. A closed
socket *detaches* the session: the process keeps running for 2 minutes (longer
while a turn is in progress, 15 at most), and a pane that reconnects with the
session's key (`?resume=`, from the bridge's `{"panel":{"type":"session"}}`
message) gets the same process back; a reply that finished meanwhile is
reported with `turn_done`. Past that the pane restores the conversation in a
new process with ACP `session/load` — each pane remembers `{agentId,
sessionId, bridgeKey}` in localStorage `chat.sessions`. Cloudflare closes a WebSocket idle for 100 s, so the
backend pings every 25 s and the browser sends `{"panel":"ping"}` every 30 s
(dropped, not counted as activity); a pane whose socket drops anyway
reconnects by itself, up to three times. An attached session
idle for 30 minutes with no turn running is ended (`idle`), and the pane picks
up where it left off when you next write. New chat and closing the pane send
`{"panel":"end"}`, which ends the process at once: stdin closes, then SIGTERM by
host pid after 3 s.

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

## NetBird

The hotel can join a NetBird mesh (`backend/lib/netbird.js`, System → NetBird): the European alternative to the Cloudflare Tunnel, and a private network. The panel runs `netbirdio/netbird` as `agenthotel-netbird`, like `cloudflared`, but with `NetworkMode: host` (NET_ADMIN, SYS_ADMIN, SYS_RESOURCE, `/dev/net/tun`), so the hotel's mesh address is the host and NetBird reverse-proxy services point at this peer, port 80 — one origin, Caddy routes on Host. Identity lives in the `agenthotel-netbird` volume (`/var/lib/netbird`); a new key or management URL starts a fresh peer. NetBird Cloud is the default (`https://api.netbird.io:443`, no `NB_MANAGEMENT_URL`); self-hosted sets it. Settings: `netbird_setup_key` (secret, shown as its last four), `netbird_management_url`, `netbird_hostname`. The mesh range `100.64.0.0/10` is in Caddy's `trusted_proxies` (`docker/caddy.json`, and patched in at start), and while NetBird is configured `rateLimit.setMeshTrusted(true)` makes the throttle take the hop before a mesh-range proxy in `X-Forwarded-For`. A NetBird reverse-proxy service needs **Pass Host Header** on (Advanced Settings), or Caddy gets the peer's address as Host and 308s to `https://100.x…`; the panel answers on extra names through `panel_domain_aliases` (Domains → *Also answers on*), which `panelHostnames()` adds to the panel route's host match. Verified on panel.froste.eu 2026-10-14: NetBird's proxy sends `X-Forwarded-For: <visitor>` and `X-Forwarded-Proto: https`.

**Guests are published automatically** (`backend/lib/netbirdPublish.js`, the *Publish every guest* part of the NetBird card) — only while NetBird is configured, publishing is on (`netbird_publish`) and a NetBird API token is stored (`netbird_api_token`, tried before it is saved). For each guest domain the panel keeps one reverse-proxy service: this peer (found by `GET /api/peers?ip=`), port 80, `pass_host_header: true`. A guest under a custom domain validated in NetBird keeps its own name; any other gets `<domain-with-dashes>.<free domain>` (`reel-froste-eu.eu1.netbird.services`), which `agentAliases()` adds to its Caddy route. Wildcards are not published. The ids of the services the panel created are in `netbird_published`; **only those are ever updated or deleted** — a hand-made service (the panel's own) is never touched, even when it claims a guest's name, and that guest is reported instead. `plan()` is pure and tested. The minute loop calls NetBird only when the set of guest domains changed or ten minutes passed. Switching off, or *Leave and forget*, deletes the panel's services. `GET /api/settings` no longer returns the tunnel token or the NetBird credentials.

## Install Script

`install.sh` installs Docker via the official apt repository (not `curl | sh`). It performs pre-flight checks (root, ports 80/443 free, not in container). **No parameters required** - just run as root.

## Authentication & Setup Flow

The panel uses a web-based setup flow:

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
the account menu. The **sidebar**
holds what you look after: the guests (agents and the tools they use, one list, each named by its template — *Take*, *Reports*, *Hermes Agent* — from the `template` column, `lib/agentTemplate.js`; guests deployed before it are matched once at start by repository or image), then Infrastructure (Providers,
Domains, Certificates, Console, System, Settings), and in its footer the host
IP (one click copies it, for a DNS A record) above the version. A new page goes
in one of those two places, not both.

The account menu is only **you**: Profile (e-mail, password, and on it how
long your sign-in lasts) and Log out (2026-10-27; Settings and the host IP
used to be there too). **Settings**, in the sidebar, is the hotel's own: the
API rate limit and where its alerts go. A setting about one part of the
installation lives on that part's page as a `SettingCard`
(`frontend/src/components/SettingCard.jsx`, saving only its own keys): the
panel domain on Domains, the certificate e-mail on Certificates, the Docker
network and backup/migration (`InstanceBackup.jsx`) on System, the sign-in
timeout on Profile. The theme is
`frontend/src/lib/theme.js`, applied in `main.jsx` before the first render so
the login page follows it too; `system` tracks `prefers-color-scheme` live.

## Secrets on screen

Any element that can show a secret — a key, token, password, a credentials
value, MCP server headers, a compose .env, logs, the terminal — carries a
`data-secret` attribute. It does nothing in the panel; it is what a screen
recording blurs: Take's (AgentTake, formerly reel-studio) `start_session(mask=["[data-secret]",
"input[type=password]"])` keeps every marked element unreadable from the first
frame. A new component that renders a secret must add it, or a demo video of
that page shows the secret.

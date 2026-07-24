# AgentPanel - Agent Instructions

## Architecture

Three-container system managed by docker-compose:
- **backend** (Node.js/Express): Manages AI agent containers via Docker API (dockerode), stores state in SQLite
- **frontend** (React/Vite): Served by nginx, talks to backend via `/api/*`
- **caddy**: Reverse proxy, routes panel traffic and dynamically manages agent subdomain routes

Backend requires `/var/run/docker.sock` to create/manage agent containers.

## Critical Build Details

**Dockerfiles use `npm install`, not `npm ci`** - No lock files are committed. This is intentional so the install script works on fresh VPS without pre-generated lock files. Do not change to `npm ci` without understanding this tradeoff.

Backend Dockerfile: `npm install --omit=dev`
Frontend Dockerfile: `npm install` then `npm run build`

## Caddy Configuration

Caddy uses JSON config (`docker/caddy.json`), loaded via `caddy run --config /etc/caddy/caddy.json`. The `caddy:2-alpine` image does not include the `letsencrypt` TLS module - rely on `automatic_https: {}` instead of explicit TLS policies.

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

## Install Script

`install.sh` installs Docker via official apt repository (not `curl | sh`), following Easypanel's pattern. It performs pre-flight checks (root, ports 80/443 free, not in container). Supports interactive, argument, or environment variable input.

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

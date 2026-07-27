# AgentPanel — Session Status (2026-07-27)

## Vad som åstadkoms denna session

### 1. Hermes chat fungerar end-to-end (HUVUDMÅL)
Den stora vinsten: **Hermes-agenten kan nu chatta direkt** utan "Unknown provider"/"Context length exceeded"-fel.

**Rotorsak till alla tidigare fel:** Hermes-image:n bakar `provider: auto` + OpenRouter base_url i config.yaml, och `"openai"` är INTE ett giltigt providernamn (bara `auto`/`custom`/`openrouter`/`anthropic`).

**Lösningen som FUNGERAR:** `provider: auto` + `base_url: https://api.openai.com/v1` + bare model-namn, **utan** `api_mode` och **utan** `custom_providers`. Hermes auto-detectar providern från base_url-hosten (`api.openai.com` → `openai`) och resolver därifrån modellens context-längd och API-mode själv.

**Config-patching:** server.js patchar `model:`-blocket i `/opt/data/config.yaml` (base64-kodat, bevarar terminal/browser/compression-sektioner) EFTER nätverk+route, sedan `SIGHUP` på gateway-processen (s6 auto-restartar). `pkill` och `s6-rc` via exec fungerade inte (bryter nätverk resp. inte i PATH).

### 2. Provider-injection fixad
server.js injicerade API-nycklar baserat på `provider.type` (alla var `openai`) → OpenRouter vann OpenAI-slotten. Fixat: name-baserad mappning (`PROVIDER_ENV_MAP`) där varje provider får sin egen env-var. Custom OpenAI-kompatibla providers (DGX1, vLLM) faller back till OPENAI-slots.

### 3. Live domäner & certifikat från Caddy
- **Certifikat:** Läser riktiga Let's Encrypt leaf-cert från Caddys cert-store via docker exec + parsa PEM med `crypto.X509Certificate` (issuer, dates, SANs, fingerprint). Filtrerar bort intermediate/root-certs. Den gamla `/pki/certificates/local`-endpointen visade bara interna CA-cert.
- **Domäner:** Live container-status via `docker.listContainers`, orphaned-route-detektering (container borta men route kvar), klickbara URL:er.
- **DELETE /api/domains/:id** för att rensa orphaned routes från UI.

### 4. Easypanel-inspirerad UX
- **AgentDetail:** Tabbad vy (Overview / Logs / Console / Environment / Credentials / Settings). Environment = key-value editor med add/remove + Save & Deploy. Konsoliderar EditAgent.
- **Dashboard:** App-centrerade kort med klickbar URL, status-badge, inline Open/Start-Stop/Delete. Auto-refresh.
- **CreateAgent:** Visuell runtime-väljare med ikoner (Easypanel-style) istället för dropdown.
- **Domains:** Klickbara URL:er, orphaned-badge med Remove-knapp.

## Commits (pushade till origin/main)
- `c58947f` fix: hermes provider config - env-only, name-based injection
- `5e61406` feat: live domains & certificates from Caddy
- `13e6f5d` feat: Easypanel-style tabbed agent view + live domains
- `37ee0bf` feat: app-centric dashboard with quick actions
- `754708d` feat: visual runtime picker for Create Agent
- `2a4d18b` fix: hermes chat works end-to-end (provider: auto + URL detection)

## Nuvarande state
- **panel.froste.eu** → AgentPanel (HTTP 200)
- **hermes.froste.eu** → Hermes dashboard (HTTP 302, login-sida)
- **Hermes chat** → fungerar (`hermes -z "say PONG"` → `PONG`, modell gpt-5.4)
- 4 LE-cert (panel, claw, claw3, hermes), alla giltiga till okt 2026
- Backend: Node 22, docker-cli installerat, daily cleanup aktiverad

## Hermes-dashboard inloggning
- URL: https://hermes.froste.eu/login
- Användarnamn: `admin`
- Lösenord: `agentpanel` (sätts via `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD`)
- Credentials visas i portalen: Agents → hermes → Credentials-tab

## Nyckelkommandon
```bash
# Auth-token
docker exec agentpanel-backend node -e "const db=require('better-sqlite3')('/data/agentpanel.db'); console.log(db.prepare(\"SELECT value FROM settings WHERE key='auth_token'\").get().value)"

# Testa hermes-chatt
docker exec agentpanel-hermes-hermes-<ID> hermes -z "say PONG"

# Kontrollera hermes config
docker exec agentpanel-hermes-hermes-<ID> head -4 /opt/data/config.yaml

# Backend-loggar
docker compose logs -f backend

# Bygg om efter ändringar
docker compose build backend && docker compose up -d backend
cd frontend && npm run build && docker compose build frontend && docker compose up -d frontend
```

## Viktiga tekniska lärdomar
1. **Hermes provider-routning:** `provider: auto` + rätt `base_url` > explicit `provider: custom/openai`. Hermes känner igen providern via URL-host.
2. **`api_mode: chat_completions` orsakar `session_id`-fel** med OpenAI — låt hermes auto-välja.
3. **`custom_providers` + `context_length`** fungerar INTE i v0.19.0 vid preflight → "Context length exceeded". Använd `provider: auto` istället.
4. **gpt-4o avvisar `reasoning.effort`** → använd gpt-5.4 som default för hermes.
5. **dockerode exec före network.connect** bryter nätverket — gör exec/patch EFTER network+route.
6. **Caddy LE-cert** lagras i `/data/caddy/certificates/acme-v02.../<domain>/` — inte i admin-API:et.

## Kända begränsningar / Nästa steg
- Agent-status kan visa "creating" en stund efter skapande (SIGHUP-reload tar ~8s)
- Dashboard-login är separat från panel-login ( BASIC_AUTH, inte synkad)
- Compose-runtime finns men kan förbättras med bättre YAML-editor
- Template library (Easypanel-style grid med meta.yaml) är backlog

# AgentPanel - Easypanel-liknande plattform för AI-agenter

AgentPanel är en adminpanel för att hantera AI-agenter (OpenClaw, Hermes, Odysseus) och Docker Compose-applikationer, inspirerad av Easypanel.

## Funktioner

### Agent Management
- **Skapa agenter** med olika runtimes (OpenClaw, Hermes, Odysseus)
- **Auto-injection** av API-nycklar från providers
- **Default modell** sätts automatiskt (gpt-4o)
- **Start/Stop/Redeploy** agenter via dashboard
- **Terminal access** till containrar via WebSocket

### Docker Compose Support
- **Klistra in docker-compose.yml** direkt i UI
- **Environment variables** med bulk import
- **Preview** av konfiguration innan deploy
- **Validering** av YAML-syntax

### Provider System
- **Multi-provider stöd** (OpenAI, Anthropic, OpenRouter, etc.)
- **Auto-injection** av API-nycklar till agenter
- **Test-funktion** för att verifiera providers

### System Management
- **System stats** (CPU, RAM, Disk)
- **Daily Docker Cleanup** (automatisk rensning)
- **SSL Certificates** via Let's Encrypt
- **MCP Server** för extern agent-administration

## Installation

```bash
# Klona repo
git clone https://github.com/magnusfroste/agentpanel.git
cd agentpanel

# Starta plattformen
docker compose up -d

# Konfigurera via web UI
# Gå till https://panel.dindomän.se
```

## Användning

### Skapa en Agent

1. Gå till **Create Agent** i sidebar
2. Välj runtime (OpenClaw, Hermes, Odysseus)
3. Ange namn och domän
4. Aktivera **Quick Start** för auto-konfiguration
5. Klicka **Create Agent**

Agenten får automatiskt:
- API-nycklar från konfigurerade providers
- Default modell (gpt-4o)
- Gateway-token för access
- Caddy-rutt för domänen

### Docker Compose Deployment

1. Gå till **Create Agent**
2. Välj runtime: **Docker Compose**
3. Klistra in din `docker-compose.yml`
4. Lägg till environment variables (individuellt eller bulk)
5. Klicka **Deploy Compose**

Exempel docker-compose.yml:
```yaml
version: '3.8'
services:
  web:
    image: nginx:alpine
    ports:
      - "80:80"
    environment:
      - NGINX_HOST=${NGINX_HOST}
```

### Hermes - Två Sätt att Köra

#### 1. Native Agent
```bash
# Via AgentPanel UI
Runtime: hermes
Domain: hermes.dindomän.se
Quick Start: enabled
```
- Bygger custom image med config.yaml
- Integrerat med provider-system
- Auto-injection av API-nycklar

#### 2. Docker Compose
```bash
# Klona hermes-easy
git clone https://github.com/magnusfroste/hermes-easy.git

# Via AgentPanel UI
Runtime: compose
Compose YAML: (klistra in från hermes-easy/docker-compose.yml)
Environment: (klistra in från hermes-easy/example.env)
```
- Använder original imagen
- Enklare setup
- Full kontroll via compose-fil

### Provider Configuration

1. Gå till **Providers** i sidebar
2. Klicka **Add Provider**
3. Ange namn, typ, base URL och API-nyckel
4. Testa med **Test** knappen

Providers injiceras automatiskt till nya agenter.

### Terminal Access

1. Gå till en agent i dashboard
2. Klicka på agenten för detaljer
3. Scrolla till **Terminal** sektionen
4. Klicka **Connect** för att öppna terminal

Terminalen ger full shell-access till containern.

## API Endpoints

### Agents
- `GET /api/agents` - Lista alla agenter
- `POST /api/agents` - Skapa agent
- `DELETE /api/agents/:id` - Ta bort agent
- `POST /api/agents/:id/start` - Starta agent
- `POST /api/agents/:id/stop` - Stoppa agent
- `POST /api/agents/:id/redeploy` - Redeploya agent
- `GET /api/agents/:id/logs` - Hämta loggar

### Providers
- `GET /api/providers` - Lista providers
- `POST /api/providers` - Skapa provider
- `PUT /api/providers/:id` - Uppdatera provider
- `DELETE /api/providers/:id` - Ta bort provider
- `POST /api/providers/:id/test` - Testa provider

### System
- `GET /api/system/stats` - System statistik
- `POST /api/docker/prune` - Docker cleanup
- `GET /api/certificates` - SSL certifikat
- `GET /api/system/version` - Versionsinformation

### MCP
- `POST /mcp` - MCP endpoint för extern administration

## MCP Integration

AgentPanel exponerar en MCP-server som låter externa agenter administrera plattformen:

```json
{
  "mcpServers": {
    "agentpanel": {
      "url": "https://panel.dindomän.se/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      }
    }
  }
}
```

Tillgängliga MCP-verktyg:
- `list_agents` - Lista alla agenter
- `create_agent` - Skapa agent
- `delete_agent` - Ta bort agent
- `redeploy_agent` - Redeploya agent
- `system_status` - System status
- `list_runtimes` - Lista tillgängliga runtimes

## Arkitektur

```
┌─────────────┐
│   Caddy     │  Reverse proxy, SSL termination
└──────┬──────┘
       │
┌──────┴──────┐
│  Frontend   │  React/Vite admin UI
└──────┬──────┘
       │
┌──────┴──────┐
│   Backend   │  Node.js/Express API
└──────┬──────┘
       │
┌──────┴──────┐
│   SQLite    │  State storage
└─────────────┘
       │
┌──────┴──────┐
│   Docker    │  Agent containers
└─────────────┘
```

## Utveckling

```bash
# Backend
cd backend
npm install
npm run dev

# Frontend
cd frontend
npm install
npm run dev

# Rebuild containers
docker compose build
docker compose up -d
```

## Backlog

Se [BACKLOG.md](BACKLOG.md) för planerade funktioner.

## License

MIT

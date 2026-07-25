# AgentPanel Backlog

## Template System (Easypanel-inspiration)

### Vision
Skapa ett template-system som liknar Easypanel för bättre igenkänning:
- Använda `meta.yaml` format för template-metadata (likt Easypanel)
- Varje template har: name, description, instructions, schema, benefits, features, tags
- Standardiserad struktur som gör det enkelt att lägga till nya templates
- Admin-gränssnitt som liknar Easypanel's template-browser

### Nuvarande struktur
Varje template i `templates/` har:
- `meta.yaml` - Metadata och konfigurationsschema (Easypanel-format)
- `template.json` - Legacy JSON-format (fasas ut)
- `Dockerfile` - Docker-byggfil
- `README.md` - Dokumentation

### Funktioner att implementera

#### 1. Template Library (Admin UI)
- Visa alla templates i ett grid/list-vy
- Filter på tags (AI, Self-Hosted, etc.)
- Preview av template-detaljer
- One-click deploy från template

#### 2. Template Schema
- JSON Schema-baserat konfigurationsformulär
- Auto-generera UI från schema
- Validering av användarinput
- Default-värden och beskrivningar

#### 3. Custom Templates
- Importera från Git URL
- Pasta docker-compose.yml
- Importera från lokal fil
- Preview innan deployment

#### 4. Template Marketplace (framtid)
- Dela templates med community
- Installera templates från marketplace
- Rate och review templates

### Implementation

#### Backend
- Läs templates från `templates/` katalogen
- API endpoints:
  - `GET /api/templates` - lista alla templates
  - `GET /api/templates/:id` - hämta template-detaljer
  - `POST /api/templates/import` - importera template
- Parse meta.yaml och generera schema

#### Frontend
- Template library page (likt Easypanel)
- Template detail page med schema-formulär
- Deploy modal med konfigurationsformulär
- Tags och filter

#### MCP Tools
- `list_templates` - lista templates
- `get_template` - hämta template-detaljer
- `deploy_from_template` - deploya från template

### Prioritet
- **Hög**: Admin UI för template library
- **Medium**: Schema-baserat konfigurationsformulär
- **Låg**: Template marketplace

### Inspiration
- Easypanel's template system (meta.yaml + index.ts)
- Coolify's application templates
- Dokku's buildpacks

## Nuvarande status
- ✅ OpenClaw fungerar (med rätt nätverk och env vars)
- ⚠️ Hermes behöver mer arbete (gateway run command, auth)
- ✅ System stats (CPU, RAM, disk) i dashboard
- ✅ Docker prune functionality
- ✅ MCP tools för agent administration
- ✅ Caddy routing fixad

## Terminal/CLI Access till Containrar

### Problem
Terminal-funktionen i AgentDetail-vyn fungerar inte korrekt. Behöver kunna:
1. Öppna CLI/terminal direkt till agent-containrar
2. Köra kommandon inuti containern
3. Felsöka problem med agenter
4. Installera paket eller göra konfigurationsändringar

### Krav
- WebSocket-baserad terminal (xterm.js)
- Stöd för interaktiva kommandon
- Korrekt hantering av stdin/stdout/stderr
- TTY-stöd för full-screen applikationer (vim, htop, etc.)
- Autentisering via befintlig token-mekanism

### Implementation
- Backend: `/api/agents/:id/terminal` WebSocket endpoint (finns redan men fungerar inte)
- Frontend: xterm.js terminal-komponent (finns redan men ansluter inte korrekt)
- Docker: `docker exec` med TTY och attach

### Prioritet
**Hög** - Kritiskt för felsökning och administration

---

## Nästa steg
1. Fixa terminal/CLI access till containrar
2. Fixa Hermes gateway mode
3. Verifiera claw.froste.eu och hermes.froste.eu fungerar
4. Påbörja template system implementation

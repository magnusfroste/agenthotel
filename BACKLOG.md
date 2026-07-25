# AgentPanel Backlog

## ✅ Implementerade Funktioner

### Core Features
- ✅ **Agent Management** - Skapa, starta, stoppa, ta bort agenter
- ✅ **Quick Start Mode** - Auto-inject API-nycklar från providers
- ✅ **Docker Compose Runtime** - Deploya från docker-compose.yml
- ✅ **System Stats** - CPU, RAM, disk visning i dashboard
- ✅ **Docker Prune** - Rensa oanvända resurser
- ✅ **MCP Server** - Fullständig MCP-integration för agent administration
- ✅ **Caddy Routing** - Automatisk routing med HTTPS
- ✅ **Credentials Display** - Visa tokens/lösenord i agent-vy

### Easypanel-inspirerade Funktioner
- ✅ **Console** - Server CLI för att köra kommandon på VPS
- ✅ **Certificates Panel** - Visa SSL-certifikat med utgångsdatum
- ✅ **Domains Panel** - Visa domän-mapping (extern domän → intern container:port)
- ✅ **Profile** - Admin kan ändra email och lösenord
- ✅ **Dark Mode Toggle** - I sidebar (☀️/🌙)
- ✅ **Start/Stop Agents** - Spara CPU/RAM genom att stoppa agenter
- ✅ **IP & Version Display** - Visa serverns IP och version i sidebar
- ✅ **Upgrade Button** - Uppgradera AgentPanel direkt från UI
- ✅ **Docs Link** - Länk till GitHub-repo i sidebar
- ✅ **Active Agents List** - Visa alla aktiva agenter i sidebar med status

### System Control
- ✅ **Restart Panel** - Starta om AgentPanel
- ✅ **Restart Docker** - Starta om Docker-tjänsten
- ✅ **Update Panel** - Git pull + rebuild + restart
- ✅ **Reboot Server** - Starta om hela VPS:en
- ✅ **Version Check** - Kolla om ny version finns tillgänglig

### Providers & API Keys
- ✅ **Provider System** - Hantera AI-leverantörer (OpenAI, Anthropic, etc.)
- ✅ **Auto-inject API Keys** - Quick Start injicerar nycklar automatiskt
- ✅ **Credentials in UI** - Visa API-nycklar i agent-detaljer

---

## ⏳ Pågående / Att Fixa

### Terminal/CLI Access till Containrar
**Status:** ✅ Implementerad

**Funktioner:**
- WebSocket-baserad terminal med xterm.js
- Interaktiva kommandon i agent-containrar
- Full TTY-stöd för shell-sessioner
- Autentisering via token i query parameter
- Korrekt hantering av stdin/stdout/stderr

**Implementation:**
- Backend: `/api/agents/:id/terminal` WebSocket endpoint
- Frontend: xterm.js terminal-komponent i AgentDetail-vyn
- Docker: `docker exec` med TTY och attach
- Auth: Manuell token-validering i WebSocket-handler (kringgår requireAuth middleware)

**Fixat:**
- requireAuth middleware fungerade inte för WebSocket - ersatt med manuell auth
- Stream-hantering med explicita data/end/error events
- Shell fallback till `/bin/sh` om `/bin/bash` saknas

**Prioritet:** Hög ✅ Klar

### Daily Docker Cleanup
**Status:** ✅ Implementerad

**Funktioner:**
- Automatisk daglig rensning (var 24:e timme)
- Tar bort dangling images, stopped containers, unused networks, unused volumes
- Loggar alla cleanup-resultat till databas
- Visa cleanup-historik i System-vyn (senaste 10 körningar)
- Manuell cleanup-knapp för att köra rensning on-demand
- Visar antal borttagna resurser och återvunnet utrymme

**Implementation:**
- Backend: Scheduled task med setInterval (24h)
- API: `/api/docker/cleanup-history` för att hämta historik
- API: `/api/docker/prune` loggar nu till databas
- Frontend: Tabell i System-vyn som visar historik
- Database: cleanup_logs tabell med alla körningar

**Prioritet:** Medium ✅ Klar

---

## 📋 Template System (Framtida)

### Vision
Skapa ett template-system som liknar Easypanel för bättre igenkänning:
- Använda `meta.yaml` format för template-metadata
- Varje template har: name, description, instructions, schema, benefits, features, tags
- Standardiserad struktur som gör det enkelt att lägga till nya templates
- Admin-gränssnitt som liknar Easypanel's template-browser

### Nuvarande Struktur
Varje template i `templates/` har:
- `meta.yaml` - Metadata och konfigurationsschema (Easypanel-format)
- `template.json` - Legacy JSON-format (fasas ut)
- `Dockerfile` - Docker-byggfil
- `README.md` - Dokumentation

### Funktioner att Implementera

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

#### 4. Template Marketplace (Framtid)
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

---

## 🎯 Nästa Steg (Prioriterade)

1. **Fixa Terminal/CLI** - Få container-terminal att fungera korrekt
2. **Daily Docker Cleanup** - Implementera automatisk rensning
3. **Template Library UI** - Bygga admin-gränssnitt för templates
4. **Template Marketplace** - Dela templates med community (långsiktigt)

---

## 📊 Statistik

**Totalt implementerade funktioner:** 25+
**Pågående:** 2
**Framtida:** Template system (4 delar)

**Senaste uppdatering:** 2026-07-25

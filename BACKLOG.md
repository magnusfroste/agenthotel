# AgentPanel Backlog

## Template System (Easypanel-inspiration)

### Vision
Skapa ett template-system liknande Easypanel där användare kan:
1. Välja från fördefinierade templates (OpenClaw, Hermes, Odysseus, etc.)
2. Ladda templates direkt från Git-repositories
3. Pasta egen docker-compose.yml för custom deployments
4. Konfigurera templates via UI istället för att redigera filer

### Funktioner att implementera

#### 1. Template Library
- Fördefinierade templates för populära AI-agenter
- Varje template har:
  - Dockerfile eller image reference
  - Standard environment variables
  - Konfigurerbara fält (API keys, models, etc.)
  - Volumes och ports
  - Health checks

#### 2. Custom Templates
- Importera från Git URL
- Pasta docker-compose.yml
- Importera från lokal fil
- Preview innan deployment

#### 3. Template Editor
- Redigera Dockerfile
- Redigera environment variables
- Redigera volumes och ports
- Spara som custom template

#### 4. Template Marketplace (framtid)
- Dela templates med community
- Installera templates från marketplace
- Rate och review templates

### Implementation

#### Backend
- `templates` table i SQLite
- API endpoints:
  - `GET /api/templates` - lista alla templates
  - `POST /api/templates` - skapa template
  - `PUT /api/templates/:id` - uppdatera template
  - `DELETE /api/templates/:id` - ta bort template
  - `POST /api/templates/import` - importera från Git/compose
- Template parsing logic
- Git clone/pull functionality

#### Frontend
- Template library page
- Template editor page
- Import modal (Git URL, paste compose, upload file)
- Template preview before deployment

#### MCP Tools
- `list_templates` - lista templates
- `create_template` - skapa template
- `import_template` - importera template
- `deploy_from_template` - deploya från template

### Prioritet
- **Hög**: Grundläggande template library med fördefinierade templates
- **Medium**: Custom template import (Git, paste)
- **Låg**: Template marketplace

### Inspiration
- Easypanel's template system
- Coolify's application templates
- Dokku's buildpacks

## Nuvarande status
- ✅ OpenClaw fungerar (med rätt nätverk och env vars)
- ⚠️ Hermes behöver mer arbete (gateway run command, auth)
- ✅ System stats (CPU, RAM, disk) i dashboard
- ✅ Docker prune functionality
- ✅ MCP tools för agent administration
- ✅ Caddy routing fixad

## Nästa steg
1. Fixa Hermes gateway mode
2. Verifiera claw.froste.eu och hermes.froste.eu fungerar
3. Påbörja template system implementation

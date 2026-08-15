# AgentHotel Template System

## Översikt
Template-systemet gör det möjligt att standardisera deployment av olika AI-agenter trots att de har olika krav och konfigurationer.

## Struktur
Varje agent-typ har en underkatalog med följande filer:

```
templates/
├── openclaw/
│   ├── template.json      # Metadata och konfigurationsdefinition
│   ├── Dockerfile         # Docker-byggfil
│   └── README.md          # Dokumentation
├── hermes/
│   ├── template.json
│   ├── Dockerfile
│   └── README.md
└── odysseus/
    ├── template.json
    ├── Dockerfile
    └── README.md
```

## template.json
Definierar metadata och konfigurationsfält för varje agent-typ:

```json
{
  "id": "openclaw",
  "name": "OpenClaw",
  "description": "Persistent AI agent with gateway, tools and browser",
  "version": "1.0.0",
  "defaultImage": "ghcr.io/openclaw/openclaw:latest",
  "defaultPort": 18789,
  "configFields": [
    {
      "key": "OPENCLAW_GATEWAY_TOKEN",
      "label": "Gateway Token",
      "type": "password",
      "required": false,
      "autoGenerate": true
    },
    {
      "key": "OPENCLAW_MODEL_PRIMARY",
      "label": "Primary Model",
      "type": "text",
      "default": "openai/gpt-4.1"
    }
  ],
  "providers": ["openai", "anthropic", "openrouter"],
  "volumes": ["/home/node/.openclaw", "/home/node/.cache"],
  "healthCheck": {
    "path": "/healthz",
    "port": 18789,
    "interval": 30
  }
}
```

## Config Fields Typer
- `text` - Vanlig text input
- `password` - Dolt fält, auto-genereras om `autoGenerate: true`
- `select` - Dropdown med `options` array
- `number` - Numeriskt värde
- `textarea` - Fler-rads text

## Providers
Agenter kan använda delade API-nycklar från providers-systemet:
- `openai` - OpenAI API
- `anthropic` - Anthropic API
- `openrouter` - OpenRouter API
- `custom` - Custom OpenAI-compatible endpoint

## Lägga till ny agent-typ
1. Skapa underkatalog: `templates/min-agent/`
2. Skapa `template.json` med metadata och configFields
3. Skapa `Dockerfile` för att bygga imagen
4. Skapa `README.md` med dokumentation
5. Lägg till plugin i `backend/plugins/min-agent.js`
6. Restart backend för att ladda ny plugin

## Admin Interface
Gå till `https://panel.froste.eu/admin/templates` för att:
- Visa alla tillgängliga templates
- Redigera template-konfiguration
- Lägga till nya templates
- Testa templates

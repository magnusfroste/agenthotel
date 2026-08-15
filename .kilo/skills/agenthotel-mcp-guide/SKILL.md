---
name: agenthotel-mcp-guide
description: Komplett guide för att använda AgentHotel MCP - verktyg, arbetsflöden och exempel
---

# AgentHotel MCP Guide

## Vad är MCP?
MCP (Model Context Protocol) är ett protokoll som låter AI-agenter interagera med externa system. AgentHotel MCP ger dig full kontroll över hela panelen via standardiserade verktygsanrop.

## Konfiguration
MCP-servern körs som en lokal subprocess och kommunicerar via stdio. Konfigurationen finns i `kilo.json`:

```json
{
  "mcp": {
    "agenthotel": {
      "type": "local",
      "command": ["node", "server.js"],
      "workdir": "./backend/mcp",
      "environment": {
        "AGENTHOTEL_URL": "http://localhost",
        "AGENTHOTEL_TOKEN": "<auth-token>"
      },
      "enabled": true
    }
  }
}
```

## Alla tillgängliga verktyg

### Agent-hantering
- `agenthotel_list_agents` - Lista alla agenter
- `agenthotel_create_agent` - Skapa ny agent
- `agenthotel_get_agent_status` - Hämta agentstatus
- `agenthotel_get_agent_logs` - Hämta agentloggar
- `agenthotel_update_agent` - Uppdatera agentkonfiguration
- `agenthotel_redeploy_agent` - Omplacera agent
- `agenthotel_delete_agent` - Ta bort agent
- `agenthotel_list_runtimes` - Lista tillgängliga runtimes

### Provider-hantering
- `agenthotel_list_providers` - Lista AI-leverantörer
- `agenthotel_create_provider` - Skapa leverantör
- `agenthotel_update_provider` - Uppdatera leverantör
- `agenthotel_delete_provider` - Ta bort leverantör

### System
- `agenthotel_get_settings` - Hämta inställningar
- `agenthotel_update_settings` - Uppdatera inställningar
- `agenthotel_docker_prune` - Rensa Docker-resurser

## Arbetsflöden

### 1. Skapa en OpenClaw-agent med domän

**Steg 1: Kolla tillgängliga runtimes**
```javascript
agenthotel_list_runtimes()
```

**Steg 2: Skapa agenten**
```javascript
agenthotel_create_agent({
  name: "claw",
  runtime: "openclaw",
  domain: "claw.froste.eu",
  config: {
    OPENAI_API_KEY: "sk-...",
    OPENCLAW_MODEL_PRIMARY: "openai/gpt-4.1",
    OPENCLAW_GATEWAY_TOKEN: "valfritt-token"
  }
})
```

**Steg 3: Verifiera status**
```javascript
agenthotel_get_agent_status({ id: "openclaw-claw-1234567890" })
```

**Steg 4: Kolla loggar om något går fel**
```javascript
agenthotel_get_agent_logs({ 
  id: "openclaw-claw-1234567890", 
  tail: 50 
})
```

### 2. Skapa en Hermes-agent

```javascript
agenthotel_create_agent({
  name: "hermes",
  runtime: "hermes",
  domain: "hermes.froste.eu",
  config: {
    OPENAI_API_KEY: "sk-...",
    HERMES_MODEL: "openai/gpt-4.1"
  }
})
```

### 3. Uppdatera API-nyckel för en agent

```javascript
agenthotel_update_agent({
  id: "openclaw-claw-1234567890",
  config: {
    OPENAI_API_KEY: "ny-api-nyckel"
  }
})
```
**OBS:** Detta stoppar och omplacerar agenten.

### 4. Omplacera en agent som fastnat

```javascript
agenthotel_redeploy_agent({ id: "openclaw-claw-1234567890" })
```

### 5. Ta bort en agent

```javascript
agenthotel_delete_agent({ id: "openclaw-claw-1234567890" })
```
Detta stoppar containern, tar bort den, och raderar Caddy-routen.

### 6. Hantera providers

**Skapa provider:**
```javascript
agenthotel_create_provider({
  name: "OpenAI",
  type: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-...",
  models: ["gpt-4", "gpt-4-turbo", "gpt-3.5-turbo"]
})
```

**Uppdatera provider:**
```javascript
agenthotel_update_provider({
  id: "provider-123",
  apiKey: "ny-nyckel"
})
```

### 7. Systemunderhåll

**Kolla inställningar:**
```javascript
agenthotel_get_settings()
```

**Ändra panel-domän:**
```javascript
agenthotel_update_settings({
  panel_domain: "panel.froste.eu"
})
```
**Viktigt:** Uppdatera DNS först!

**Rensa Docker:**
```javascript
agenthotel_docker_prune()
```
Returnerar hur mycket utrymme som frigjordes.

## Runtime-specifika konfigurationer

### OpenClaw
**Obligatoriska fält:** Inga (OPENCLAW_GATEWAY_TOKEN genereras automatiskt)

**Valfria fält:**
- `OPENCLAW_MODEL_PRIMARY` - Primär modell (default: "openai/gpt-4.1")
- `OPENAI_API_KEY` - OpenAI API-nyckel
- `ANTHROPIC_API_KEY` - Anthropic API-nyckel
- `OPENROUTER_API_KEY` - OpenRouter API-nyckel
- `ZAI_API_KEY` - Z.ai API-nyckel
- `OPENCLAW_ZAI_BASE_URL` - Z.ai base URL override
- `OPENCLAW_MODEL_FALLBACKS` - Fallback-modeller (comma-separerade)

**Default port:** 18789

### Hermes
**Obligatoriska fält:**
- `OPENAI_API_KEY` - OpenAI API-nyckel (required)

**Valfria fält:**
- `OPENAI_BASE_URL` - Custom base URL
- `HERMES_MODEL` - Modell (default: "openai/gpt-4.1")
- `OPENROUTER_API_KEY` - OpenRouter API-nyckel
- `ANTHROPIC_API_KEY` - Anthropic API-nyckel
- `GEMINI_API_KEY` - Gemini API-nyckel
- `DEEPSEEK_API_KEY` - DeepSeek API-nyckel
- `GROQ_API_KEY` - Groq API-nyckel

**Default port:** 3000

### Odysseus
**Obligatoriska fält:**
- `ODYSSEUS_ADMIN_PASSWORD` - Admin-lösenord (required)

**Valfria fält:**
- `OPENAI_API_KEY` - OpenAI API-nyckel
- `LLM_HOST` - LLM host
- `AUTH_ENABLED` - Auth enabled ("true"|"false", default: "true")

**Default port:** 7000

### Docker App
**Obligatoriska fält:**
- `IMAGE` - Docker image (required)

**Valfria fält:**
- `PORT` - Container port (default: 80)
- `VOLUMES` - Volumes (host:container per rad)
- `CUSTOM_ENV` - Extra env vars (KEY=VALUE per rad)

## Felsökning via MCP

### Agent startar inte
1. Kolla status: `agenthotel_get_agent_status({ id: "..." })`
2. Kolla loggar: `agenthotel_get_agent_logs({ id: "...", tail: 100 })`
3. Försök omplacera: `agenthotel_redeploy_agent({ id: "..." })`

### Domän fungerar inte
1. Verifiera att agenten har domän satt: `agenthotel_list_agents()`
2. Kolla att DNS-pekar till serverns IP
3. Kolla Caddy-loggar: `docker logs agenthotel-caddy`

### API-nyckel fungerar inte
1. Uppdatera nyckeln: `agenthotel_update_agent({ id: "...", config: { OPENAI_API_KEY: "ny" } })`
2. Verifiera att nyckeln är korrekt
3. Kolla agentloggar för felmeddelanden

## Bästa praxis

1. **Använd alltid domän** när du skapar agenter - ger automatisk HTTPS
2. **Spara agent-ID:n** - behövs för alla uppdateringar
3. **Kolla loggar vid problem** - ger detaljerad information
4. **Uppdatera DNS före domänändring** - annars misslyckas certifikat
5. **Kör docker_prune regelbundet** - håller systemet rent
6. **Testa agenter efter skapande** - verifiera att allt fungerar

## Exempel: Komplett arbetsflöde

```javascript
// 1. Skapa OpenClaw-agent
const result = await agenthotel_create_agent({
  name: "assistant",
  runtime: "openclaw",
  domain: "assistant.froste.eu",
  config: {
    OPENAI_API_KEY: "sk-...",
    OPENCLAW_MODEL_PRIMARY: "openai/gpt-4.1"
  }
});

const agentId = result.id;

// 2. Vänta några sekunder, kolla sedan status
await agenthotel_get_agent_status({ id: agentId });

// 3. Om status är "running", testa att nå domänen
// (manuellt i browser eller med curl)

// 4. Om problem, kolla loggar
await agenthotel_get_agent_logs({ id: agentId, tail: 50 });

// 5. Om behöver omplacera
await agenthotel_redeploy_agent({ id: agentId });

// 6. När agenten fungerar, spara ID för framtida användning
```

## Viktigt att tänka på

- Alla MCP-anrop är asynkrona och returnerar promises
- Agent-ID:n har formatet `{runtime}-{name}-{timestamp}`
- Domäner kräver att DNS är korrekt konfigurerad
- HTTPS-certifikat begärs automatiskt via Let's Encrypt
- Volumes skapas automatiskt baserat på Dockerfile
- Agenter startas med `unless-stopped` restart policy

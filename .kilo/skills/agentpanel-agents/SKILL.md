---
name: agentpanel-agents
description: Hantera AI-agenter i AgentPanel - skapa, lista, uppdatera, ta bort, deploya om
---

# AgentPanel Agent Administration

## Översikt
Denna skill ger dig verktyg för att administrera AI-agenter i AgentPanel via MCP.

## Tillgängliga MCP-verktyg

### list_agents
Lista alla agenter i systemet.
```
Användning: agentpanel_list_agents
Returnerar: Array av agentobjekt med id, name, runtime, domain, status, config
```

### create_agent
Skapa en ny agent.
```
Parametrar:
- name (string, required): Agentens namn
- runtime (string, required): "openclaw", "hermes", "odysseus", eller "docker-app"
- domain (string, optional): Domän för agenten (t.ex. "claw.froste.eu")
- image (string, optional): Custom Docker image
- port (number, optional): Custom port
- config (object, optional): Runtime-specifik konfiguration

Exempel:
agentpanel_create_agent({
  name: "claw",
  runtime: "openclaw",
  domain: "claw.froste.eu",
  config: {
    OPENAI_API_KEY: "sk-...",
    OPENCLAW_MODEL_PRIMARY: "openai/gpt-4.1"
  }
})
```

### get_agent_status
Hämta status och hälsa för en agent.
```
Parametrar:
- id (string, required): Agent ID

Returnerar: status (running/stopped/not_found), health, startedAt
```

### get_agent_logs
Hämta loggar från en agent.
```
Parametrar:
- id (string, required): Agent ID
- tail (number, optional): Antal rader att returnera (default: 100)

Returnerar: Loggtext
```

### update_agent
Uppdatera agentkonfiguration.
```
Parametrar:
- id (string, required): Agent ID
- config (object, optional): Uppdaterad konfiguration
- domain (string, optional): Ny domän

OBS: Detta kommer att stoppa och omplacera agenten.
```

### redeploy_agent
Omplacera en agent med nuvarande konfiguration.
```
Parametrar:
- id (string, required): Agent ID

Användning: När en agent behöver startas om eller har fastnat.
```

### delete_agent
Ta bort en agent.
```
Parametrar:
- id (string, required): Agent ID

OBS: Detta stoppar containern, tar bort den, och raderar Caddy-routen.
```

### list_runtimes
Lista tillgängliga runtimes och deras konfigurationsfält.
```
Returnerar: Array av runtime-objekt med id, name, description, defaultImage, defaultPort, configFields
```

## Runtime-specifika konfigurationer

### OpenClaw
Configfält:
- OPENCLAW_GATEWAY_TOKEN (password, auto-genereras om ej angivet)
- OPENCLAW_MODEL_PRIMARY (text, default: "openai/gpt-4.1")
- OPENAI_API_KEY (password)
- ANTHROPIC_API_KEY (password)
- OPENROUTER_API_KEY (password)
- ZAI_API_KEY (password)
- OPENCLAW_ZAI_BASE_URL (text)
- OPENCLAW_MODEL_FALLBACKS (text, comma-separerade)

Default port: 18789

### Hermes Agent
Configfält:
- OPENAI_API_KEY (password, required)
- OPENAI_BASE_URL (text)
- HERMES_MODEL (text, default: "openai/gpt-4.1")
- OPENROUTER_API_KEY (password)
- ANTHROPIC_API_KEY (password)
- GEMINI_API_KEY (password)
- DEEPSEEK_API_KEY (password)
- GROQ_API_KEY (password)

Default port: 3000

### Odysseus
Configfält:
- OPENAI_API_KEY (password)
- LLM_HOST (text)
- AUTH_ENABLED (select: "true"|"false", default: "true")
- ODYSSEUS_ADMIN_PASSWORD (password, required)

Default port: 7000

### Docker App
Configfält:
- IMAGE (text, required)
- PORT (number, default: 80)
- VOLUMES (textarea, host:container per rad)
- CUSTOM_ENV (textarea, KEY=VALUE per rad)

## Arbetsflöde

1. **Skapa agent med domän:**
   ```
   agentpanel_create_agent({
     name: "minagent",
     runtime: "openclaw",
     domain: "minagent.froste.eu",
     config: { ... }
   })
   ```

2. **Kontrollera status:**
   ```
   agentpanel_get_agent_status({ id: "agent-id" })
   ```

3. **Visa loggar vid problem:**
   ```
   agentpanel_get_agent_logs({ id: "agent-id", tail: 50 })
   ```

4. **Uppdatera konfiguration:**
   ```
   agentpanel_update_agent({
     id: "agent-id",
     config: { OPENAI_API_KEY: "ny-nyckel" }
   })
   ```

5. **Ta bort agent:**
   ```
   agentpanel_delete_agent({ id: "agent-id" })
   ```

## Viktigt att tänka på

- Agenter med domän får automatisk HTTPS via Let's Encrypt
- Caddy-routning hanteras automatiskt
- Volumes skapas automatiskt baserat på Dockerfile VOLUME-directiv
- Agenter startas med `unless-stopped` restart policy
- Alla API-nycklar lagras i agentens config (JSON i databasen)

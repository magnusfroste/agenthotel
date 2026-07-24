---
name: agentpanel-providers
description: Hantera AI-leverantörer (providers) i AgentPanel - skapa, lista, uppdatera, ta bort
---

# AgentPanel Provider Administration

## Översikt
Denna skill ger dig verktyg för att administrera AI-leverantörer i AgentPanel via MCP.

## Tillgängliga MCP-verktyg

### list_providers
Lista alla konfigurerade AI-leverantörer.
```
Användning: agentpanel_list_providers
Returnerar: Array av provider-objekt med id, name, type, baseUrl, apiKey, models
```

### create_provider
Skapa en ny AI-leverantör.
```
Parametrar:
- name (string, required): Leverantörens namn
- type (string, required): Typ (t.ex. "openai", "anthropic", "custom")
- baseUrl (string, optional): Base URL för API:et
- apiKey (string, optional): API-nyckel
- models (array, optional): Lista över tillgängliga modeller

Exempel:
agentpanel_create_provider({
  name: "OpenAI",
  type: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-...",
  models: ["gpt-4", "gpt-4-turbo", "gpt-3.5-turbo"]
})
```

### update_provider
Uppdatera en befintlig leverantör.
```
Parametrar:
- id (string, required): Provider ID
- name (string, optional): Nytt namn
- type (string, optional): Ny typ
- baseUrl (string, optional): Ny base URL
- apiKey (string, optional): Ny API-nyckel
- models (array, optional): Uppdaterad modellista

Exempel:
agentpanel_update_provider({
  id: "provider-id",
  apiKey: "ny-api-nyckel"
})
```

### delete_provider
Ta bort en leverantör.
```
Parametrar:
- id (string, required): Provider ID

OBS: Detta påverkar inte befintliga agenter som använder leverantören.
```

## Arbetsflöde

1. **Skapa leverantör:**
   ```
   agentpanel_create_provider({
     name: "Min OpenAI",
     type: "openai",
     baseUrl: "https://api.openai.com/v1",
     apiKey: "sk-..."
   })
   ```

2. **Lista alla leverantörer:**
   ```
   agentpanel_list_providers()
   ```

3. **Uppdatera API-nyckel:**
   ```
   agentpanel_update_provider({
     id: "provider-id",
     apiKey: "ny-nyckel"
   })
   ```

4. **Lägg till modeller:**
   ```
   agentpanel_update_provider({
     id: "provider-id",
     models: ["gpt-4", "gpt-4-turbo"]
   })
   ```

5. **Ta bort leverantör:**
   ```
   agentpanel_delete_provider({ id: "provider-id" })
   ```

## Viktigt att tänka på

- API-nycklar lagras i klartext i databasen (bör förbättras i framtiden)
- Modeller kan specificeras manuellt eller hämtas dynamiskt från leverantörens API
- Base URL behövs för custom endpoints eller proxys
- Provider-type används för att identifiera leverantörstyp i UI

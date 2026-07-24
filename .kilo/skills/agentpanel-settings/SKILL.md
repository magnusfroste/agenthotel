---
name: agentpanel-settings
description: Hantera AgentPanel-inställningar och systemunderhåll
---

# AgentPanel Settings & Maintenance

## Översikt
Denna skill ger dig verktyg för att administrera AgentPanel-inställningar och utföra systemunderhåll via MCP.

## Tillgängliga MCP-verktyg

### get_settings
Hämta aktuella panel-inställningar.
```
Användning: agentpanel_get_settings
Returnerar: Objekt med inställningar (exkluderar känslig data som lösenordshash och auth_token)

Exempel return:
{
  "admin_email": "admin@example.com",
  "panel_domain": "panel.froste.eu"
}
```

### update_settings
Uppdatera panel-inställningar.
```
Parametrar:
- panel_domain (string, optional): Panelens domän

OBS: När panel_domain ändras, uppdateras Caddy-routningen automatiskt och Let's Encrypt-certifikat begärs.

Exempel:
agentpanel_update_settings({
  panel_domain: "panel.froste.eu"
})
```

### docker_prune
Rensa oanvända Docker-resurser.
```
Användning: agentpanel_docker_prune
Returnerar: Objekt med resultat:
{
  "success": true,
  "results": {
    "containers": [...],
    "containersSpaceReclaimed": 1234567,
    "images": [...],
    "imagesSpaceReclaimed": 9876543,
    "networks": [...],
    "volumes": [...],
    "volumesSpaceReclaimed": 456789
  },
  "totalSpaceReclaimed": 11558899,
  "totalSpaceReclaimedMB": "11.02"
}
```

## Inställningar

### panel_domain
- Panelens domän (t.ex. "panel.froste.eu")
- Kräver att DNS-pekar till serverns IP
- Let's Encrypt-certifikat begärs automatiskt
- Ändring uppdaterar Caddy-routning

### admin_email
- Administratörens e-postadress
- Sätts vid första setup och kan inte ändras via API

## Systemunderhåll

### Docker Prune
Används för att frigöra diskutrymme genom att ta bort:
- Stoppade containrar som inte använts
- Dangling images (taglösa)
- oanvända nätverk
- oanvända volumes

**Varning:** Detta tar bort resurser som inte används av running containrar.

## Arbetsflöde

1. **Visa aktuella inställningar:**
   ```
   agentpanel_get_settings()
   ```

2. **Ändra panel-domän:**
   ```
   agentpanel_update_settings({
     panel_domain: "newpanel.froste.eu"
   })
   ```
   OBS: Uppdatera DNS först!

3. **Rensa Docker:**
   ```
   agentpanel_docker_prune()
   ```
   Används regelbundet för att hålla systemet rent.

## Systeminformation

- **Backend:** Node.js/Express på port 8080 (internt)
- **Frontend:** React/Vite, serveras via nginx
- **Caddy:** Reverse proxy, hanterar HTTPS och routing
- **Databas:** SQLite (`/data/agentpanel.db`)
- **Docker:** Hanterar agent-containers via dockerode

## Felsökning

### Panel inte tillgänglig
1. Kolla att Caddy kör: `docker ps | grep caddy`
2. Kolla Caddy-loggar: `docker logs agentpanel-caddy`
3. Verifiera DNS-pekar till serverns IP

### Backend problem
1. Kolla backend-loggar: `docker logs agentpanel-backend`
2. Verifiera att `/var/run/docker.sock` är monterad
3. Kolla att databasen är åtkomlig

### HTTPS-certifikat
- Let's Encrypt begärs automatiskt vid domänändring
- Kan ta några minuter att propagera
- Kolla Caddy-loggar för status

# AgentHotel Manual

Hands-on documentation for running AgentHotel day to day. For architecture and build conventions, see [AGENTS.md](../AGENTS.md); for the roadmap, see [BACKLOG.md](../BACKLOG.md).

## Providers & Models

Providers are configured once in the panel (**Providers** page) and shared by all agents. A provider has a name, a protocol type (currently OpenAI-compatible), a base URL, an API key, and an optional model list (fetch models from the provider or add them manually; use **Test** to verify a model actually responds).

### How providers reach agents

On agent creation — and again on every redeploy — AgentHotel injects provider credentials as environment variables. Injection only fills *missing* keys, so manual edits on an agent's Environment tab are never overwritten.

Two tiers of env vars are injected per provider:

1. **Slug vars** — every provider gets its own variables derived from its name:
   a provider named `Hetzner` becomes `HETZNER_API_KEY`, `HETZNER_BASE_URL` and `HETZNER_MODELS` (comma-separated). Rename a provider and the variable names change accordingly on the next redeploy.
2. **Canonical slots** — well-known providers (OpenAI, OpenRouter, Anthropic, Gemini, DeepSeek, Groq, xAI, Mistral) additionally fill their conventional variables (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, …), which many agent frameworks read natively. A custom OpenAI-compatible provider only claims the `OPENAI_*` slots if no real OpenAI provider exists.

If no model is configured, agents default to `openai/gpt-5.3` (OpenClaw) / `openai/gpt-5.4` (Hermes) when an OpenAI key is present, falling back to the OpenRouter equivalents.

### Per-runtime provider support

| Runtime | What you get |
| --- | --- |
| **OpenClaw** | Every configured provider becomes a **selectable provider in the model picker**, with its model list from the panel. Set the primary model via `OPENCLAW_MODEL_PRIMARY` (`provider/model`, e.g. `hertzner/Kimi-K2.7-Code`) and optional `OPENCLAW_MODEL_FALLBACKS`. |
| **Hermes** | All canonical provider keys are injected, and Hermes reads them at runtime — switch between them with `/model` in the console. A private endpoint is written into `custom_providers` in config.yaml and appears there under its own name too, alongside the hosted ones, so it does not displace them. See [Private models](#private-models). |
| **Odysseus** | One provider at a time (an Odysseus limitation): `OPENAI_API_KEY` + `LLM_HOST`. |
| **Docker App / Git App / Compose** | Provider credentials are **not** injected by default: these runtimes host arbitrary images, and a tool checked in from a repository has no business holding your whole provider wallet. Set `INJECT_PROVIDER_ENV=true` on the guest to opt in — then most OpenAI-compatible apps read `OPENAI_API_KEY` / `OPENAI_BASE_URL`, which you can point at any provider. |

### Using a custom provider (example: Hetzner)

1. Add the provider in the panel: base URL `https://inference.hetzner.com/api/v1`, your API key, fetch the model list.
2. Redeploy the agent (or create a new one) — `HERTZNER_API_KEY`, `HERTZNER_BASE_URL`, `HERTZNER_MODELS` are injected.
3. **OpenClaw**: pick a Hetzner model in the UI, or set `OPENCLAW_MODEL_PRIMARY=hertzner/<model>` on the Environment tab and redeploy.
4. **Hermes**: nothing to do by hand — set `default_provider` in Settings, or set `HERMES_MODEL=hertzner/<model>` on the Environment tab, and the endpoint is written into `custom_providers` for you.
5. **Odysseus / generic apps**: point the agent at Hetzner with `OPENAI_API_KEY=<hetzner key>` and `OPENAI_BASE_URL=https://inference.hetzner.com/api/v1` on the Environment tab, then choose a model.

### Notes

- API keys are visible in the panel (agent → Credentials/Environment) — treat panel access as root-equivalent.
- Template images are built once per runtime; after upgrading AgentHotel, remove `openclaw-agenthotel:latest` and redeploy to pick up entrypoint changes.
- Model ids may contain slashes and may repeat the provider's name (`unsloth/Qwen3.8-...` on a provider called `unsloth`). Write the id exactly as the provider's model list reports it; the panel resolves the prefix against that list rather than guessing.

## Private models

Running the whole fleet against inference you host yourself is the point of this
panel, and it takes one setting.

### Adding the endpoint

Under **Providers**, add your endpoint with its base URL (usually ending in
`/v1`) and an API key — set one even if the server ignores it, since several
clients refuse to send a request without it. Then use **Fetch models**: the
panel asks the server directly and lists each model with the context window it
reports.

Read that list before going further. It is where a mismatch shows up while it is
still cheap.

### Making it the fleet default

Set `default_provider` in Settings to the provider's name. New agents then pick
their model from it before any hosted provider, and each runtime is configured
for it automatically:

- **Hermes** gets a `custom_providers` entry in its `config.yaml`, keyed to the
  env var the panel injects. The endpoint appears under its own name in `/model`
  alongside `openai-api` and `OpenRouter`, so you can switch between them live.
- **OpenClaw** gets every configured provider written into `openclaw.json`, each
  with its own base URL and model list.
- **Odysseus** manages endpoints in its own admin UI; the panel injects the key
  but does not configure the endpoint for it.

If the named default cannot serve a model, the panel uses another provider and
records a `provider.fallback` event. That is deliberate: an operator who points
the fleet at their own hardware does it so the traffic stays there, and silently
routing it to a hosted API is the one failure they must not discover afterwards.

### Context windows

Hermes refuses any model whose context window is under 64,000 tokens — its own
system prompt with tools and skills is around 23,000, and the floor is its rule,
not a consequence of prompt size. OpenClaw's prompt is comparable.

Local servers frequently default to a much smaller window. A model loaded at
8,192 fails both runtimes, in different and confusing ways: hermes refuses to
start, while openclaw retries into a streaming response whose HTTP status is 200
with the error inside the body.

So load the model with **at least 64K context** on your server. The panel checks
this for you where it can — a runtime declaring `minContextTokens` will decline a
model that reports less, rather than selecting one that cannot run. Models that
report no window at all are still tried, because a llama.cpp-style server reports
nothing while a model is loading and excluding on ignorance would lock out an
endpoint for being mid-restart.

### When a model is loaded on demand

Some servers unload an idle model and answer later requests with
`No model loaded`. Enable the server's model auto-switch, or keep the model
pinned, or the panel will pass over that provider through no fault of its own.

## Putting agents to work

Creating an agent is checking a guest in. The point is handing it a job — from
the UI, or over MCP with `ask_agent` so an external AI can dispatch work without
touching the panel by hand.

### Give it its secrets first, in the config

Anything the agent needs to authenticate with — an API token for a tool, a
service password — belongs on the agent's **Environment** tab (or, over MCP,
`set_agent_env`), not in the task message.

Env vars are re-injected on every redeploy and survive restarts. A token handed
over in a chat message lives only as long as that conversation: the agent will
use it happily, then lose it the next time it restarts and fail with an
authentication error that looks like a broken tool. Two agents given the same
job differed in exactly this way — the one with the token in its config kept
working, the one told the token in a message did not.

`set_agent_env` applies the values by redeploying the agent, which replaces its
container — volume data persists, but anything running inside it stops. Set the
variables before dispatching work, not during it. Pass `apply: false` to store
them for the next redeploy without disturbing a running agent, and `null` as a
value to remove one. It reports variable names only, never their values, so a
secret never lands in the calling agent's transcript.

### Dispatching

`ask_agent` runs synchronously by default and returns the agent's reply. For
work that outlives a request, set `background: true`: the call returns
immediately and the agent keeps going on its own.

A background agent is not fire-and-forget. You can look in while it works:

| Want to see | Use |
| --- | --- |
| What the container printed | `get_agent_logs` |
| Files it has written, exit codes, its own state | `exec_in_agent` |
| Whether it is healthy, and what the host thinks | `health_check`, `get_agent_stats`, `get_events` |

Because the same MCP endpoint exposes both the agent and the observability
tools, a supervising agent can cross-check the two: correlate what an agent
claims it did against what the host actually recorded — restarts, memory
pressure, events — and draw its own conclusion about whether the work is really
progressing or the room is on fire.

### Correcting an agent mid-run

Send another `ask_agent`. It arrives as a new message in the same conversation,
so the agent keeps its context and applies the correction. This is the normal
way to unblock one that has gone down a wrong path — diagnose with
`exec_in_agent`, then tell it what you found.

### Hosting the tools yourself

An agent with no tools cannot do much, and the tools it calls are usually
ordinary web services. The **Git App** runtime checks one in from its
repository: AgentHotel clones the repo, builds the Dockerfile and runs the
result as a guest with a domain, TLS, resource caps and persistent volumes —
the same room any agent gets.

This exists because a great many useful apps ship a Dockerfile and no
published image. Docker App can only run an image that already exists; Git App
builds one.

| Field | Meaning |
| --- | --- |
| `GIT_REPO` | Repository URL (`https://…` or `git@…`) |
| `GIT_REF` | Branch, tag or commit sha — defaults to `main` |
| `GIT_SUBDIR` | Build context, when the Dockerfile is not at the repository root |
| `PORT` | The port the container listens on |

Redeploying is how you pick up new commits: each redeploy fetches the ref again
and rebuilds, with Docker's layer cache making it cheap when nothing changed.
`VOLUME` lines in the Dockerfile become named volumes automatically, so data
survives the rebuild. The image is tagged per agent, so two Git App guests
built from different repositories never collide.

Once the tool is running, `set_agent_env` is what connects the two: give the
agents its URL and token, and the hotel is not just housing them but equipping
them.

Building an arbitrary repository means running its build on the host. That is
worth stating plainly, though it does not lower the existing bar — the panel
already holds the Docker socket and is root-equivalent, so panel access is the
security boundary either way.

### Handing an agent an external MCP tool

Agents given a remote MCP endpoint will often write their own client for it from
the tool list. That works, but a handful of transport details are invisible from
the tool list and cost an agent a long detour if it has to discover them by
trial. Put them in the task message up front:

- **The exact URL, including the trailing slash or its absence.** Servers
  commonly answer `/mcp` and redirect `/mcp/` with an empty 307 — which reads as
  a hang, not an error.
- **The auth header**, naming the env var you set above.
- **`Accept: application/json, text/event-stream`.** Responses are usually SSE
  (`event: message` / `data: {json}`), so the agent must parse the `data:` line
  rather than the body as a whole.
- **The session handshake.** `initialize` returns an `Mcp-Session-Id` *response*
  header that must be echoed as a *request* header on every later call.

Two further failure modes worth recognising, because neither looks like what it
is:

- **A Cloudflare-fronted endpoint may reject the agent's HTTP client** — Python's
  default `urllib` User-Agent can draw a `403 Error 1010 (Access denied)`. That
  is bot protection, not authentication; a bad token fails differently. Fix it on
  the Cloudflare side, or send a normal browser User-Agent. Do not "solve" it by
  turning the proxy off: if the hostname fronts a Cloudflare Tunnel, the origin
  is reachable *only* through the proxy, and disabling it takes the whole service
  offline.
- **Hitting the origin directly may return `421 Invalid Host header`.** MCP
  servers commonly allow only their canonical hostname as DNS-rebinding
  protection. Use the public name for MCP; the origin URL is for eyeballing the
  app in a browser.

## Cloudflare Tunnel

The normal way in needs three things to be true: ports 80 and 443 free and
reachable, a DNS record pointing at this host, and Let's Encrypt able to
validate. A tunnel removes all three — `cloudflared` dials out, so nothing is
exposed inbound and no certificate is issued locally. It also works behind NAT,
which puts AgentHotel on hardware with no public address at all.

Enable it under **System → Cloudflare Tunnel**: paste the tunnel token from
Cloudflare and press Start. The panel runs `cloudflared` as a container it
manages itself — nothing to install on the host. The token is stored like any
other secret, shown only as its last four characters, and kept when the tunnel
is stopped so switching it back on does not mean pasting it again.

### One origin for everything

Caddy is not replaced. The tunnel points at it, and Caddy routes on the `Host`
header exactly as it does for a direct request. So every public hostname you add
in Cloudflare gets the **same** service URL:

| Public hostname | Service |
| --- | --- |
| `panel.example.com` | `http://agenthotel-caddy:80` |
| `hermes.example.com` | `http://agenthotel-caddy:80` |
| `reel-studio.example.com` | `http://agenthotel-caddy:80` |

There is no port mapping and no container name to keep track of. Add one public
hostname per guest, point them all at that one string, and the hostnames match
themselves.

The prerequisite is that the guest has a domain set in the panel — that is what
creates its Caddy route. A public hostname with no matching route reaches Caddy
and gets nothing back.

### Things that bite

- **Keep the records proxied.** A tunnel is reachable only through Cloudflare.
  Switching a hostname to DNS-only makes it resolve to an unroutable address and
  the guest disappears entirely — not just slower, gone.
- **Give the switch time.** Moving a hostname from an A record to the tunnel
  works immediately from a fresh resolver, but a browser that has already
  visited it can hold the old answer for a while and report the site as down.
  Check with `curl` before believing the browser: if curl gets a 200 and the
  browser does not, the change is fine and the client is behind.
- **Pick one path per hostname.** An A record pointing straight at the host and a
  tunnel CNAME both work, and running both makes it impossible to tell which
  route a broken request took. Once a hostname is on the tunnel, 80 and 443 can
  be closed in the firewall — that is the point.
- **Cloudflare's bot protection can reject an agent's HTTP client**, with a 403
  `Error 1010` that looks like an auth failure and is not. See
  [Handing an agent an external MCP tool](#handing-an-agent-an-external-mcp-tool).
- **A guest behind the tunnel sees plain HTTP.** TLS terminates at the
  Cloudflare edge and `cloudflared` speaks HTTP to Caddy, so an app that builds
  absolute URLs — canonical tags, sitemaps, OAuth redirects, password-reset
  links — would advertise `http://`. Caddy is configured to trust the
  forwarded headers from the container network, so guests receive
  `X-Forwarded-Proto: https` and get this right without knowing about the
  tunnel. Worth knowing because the symptom hides: Cloudflare rewrites `href`
  attributes to https and leaves `meta content` alone, so a canonical link can
  look correct while an `og:url` beside it is wrong.
- **An MCP server may answer `421 Invalid Host header`** if it validates the
  hostname, so the tunnel must pass the public name through rather than an
  internal one.

## Resource Guardrails

Agents can never starve the panel or freeze the host:

- Every agent gets a CPU cap (default 1 core) and RAM cap (default 1024 MB), low CPU shares (256), a PID limit (512) and high OOM-kill priority.
- Panel containers run at 2048 CPU shares with `oom_score_adj: -500` — under load the panel always wins, and the kernel OOM-kills a runaway agent before touching the panel.
- CPU shares only matter under saturation; agents freely use idle capacity.
- Per agent: set `CPU_LIMIT` (cores) / `MEMORY_LIMIT_MB` on the Environment tab, applied on redeploy. Host-wide defaults: `DEFAULT_AGENT_CPU` / `DEFAULT_AGENT_MEM_MB` in the backend environment.
- Limits apply to containers created after the change — redeploy existing agents to enforce them.

## Operations

- **Backups / migration** — System page: full instance export/import, or per-agent zip export (optionally including volume data; stop the agent first for a consistent copy).
- **Updates** — the sidebar offers an Upgrade button when the running commit differs from `main`. It runs `git pull && docker compose build && docker compose up -d` on the host, in the checkout the panel was started from, and the panel restarts into the new image (progress: `GET /api/system/upgrade-log`, or `/var/log/agenthotel-upgrade.log` on the host). Requires the host access the panel already uses for the Server Console; without it the button reports the ssh command to run instead.
- **Routing survives a Caddy restart** — Caddy holds its routes in memory
  (they are added over its admin API at deploy, not written to `caddy.json`),
  so anything that restarts it drops every guest at once. Routes are rebuilt at
  panel startup and re-checked each minute, so a restart heals itself in under
  a minute. Worth knowing because the failure is invisible to a status check:
  with no matching route Caddy answers an **empty 200**, so every hostname
  looks healthy while serving nothing. Measure the response size, not the code.
- **Cleanup** — daily automatic Docker prune (agent volumes are never touched); history on the System page.
- **Alerts** — webhook (Slack/Discord) or Telegram notifications for agent down/recovered and host disk/memory thresholds.

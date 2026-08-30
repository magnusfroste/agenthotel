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
| **Docker App / Compose** | Env vars are injected but usage is up to the image — most OpenAI-compatible apps read `OPENAI_API_KEY` / `OPENAI_BASE_URL`, which you can point at any provider. |

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
- **Cleanup** — daily automatic Docker prune (agent volumes are never touched); history on the System page.
- **Alerts** — webhook (Slack/Discord) or Telegram notifications for agent down/recovered and host disk/memory thresholds.

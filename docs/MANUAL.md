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
| **Hermes** | All canonical provider keys are injected, and Hermes reads them at runtime — you can switch between those providers with `hermes model`; config.yaml only sets the default. Custom endpoints (e.g. Hetzner) work one at a time via the `OPENAI_API_KEY` + `OPENAI_BASE_URL` override, which by nature points at a single endpoint. |
| **Odysseus** | One provider at a time (an Odysseus limitation): `OPENAI_API_KEY` + `LLM_HOST`. |
| **Docker App / Compose** | Env vars are injected but usage is up to the image — most OpenAI-compatible apps read `OPENAI_API_KEY` / `OPENAI_BASE_URL`, which you can point at any provider. |

### Using a custom provider (example: Hetzner)

1. Add the provider in the panel: base URL `https://inference.hetzner.com/api/v1`, your API key, fetch the model list.
2. Redeploy the agent (or create a new one) — `HERTZNER_API_KEY`, `HERTZNER_BASE_URL`, `HERTZNER_MODELS` are injected.
3. **OpenClaw**: pick a Hetzner model in the UI, or set `OPENCLAW_MODEL_PRIMARY=hertzner/<model>` on the Environment tab and redeploy.
4. **Hermes / Odysseus / generic apps**: point the agent at Hetzner by setting `OPENAI_API_KEY=<hetzner key>` and `OPENAI_BASE_URL=https://inference.hetzner.com/api/v1` on the Environment tab, then choose a model.

### Notes

- API keys are visible in the panel (agent → Credentials/Environment) — treat panel access as root-equivalent.
- Template images are built once per runtime; after upgrading AgentHotel, remove `openclaw-agenthotel:latest` and redeploy to pick up entrypoint changes.

## Resource Guardrails

Agents can never starve the panel or freeze the host:

- Every agent gets a CPU cap (default 1 core) and RAM cap (default 1024 MB), low CPU shares (256), a PID limit (512) and high OOM-kill priority.
- Panel containers run at 2048 CPU shares with `oom_score_adj: -500` — under load the panel always wins, and the kernel OOM-kills a runaway agent before touching the panel.
- CPU shares only matter under saturation; agents freely use idle capacity.
- Per agent: set `CPU_LIMIT` (cores) / `MEMORY_LIMIT_MB` on the Environment tab, applied on redeploy. Host-wide defaults: `DEFAULT_AGENT_CPU` / `DEFAULT_AGENT_MEM_MB` in the backend environment.
- Limits apply to containers created after the change — redeploy existing agents to enforce them.

## Operations

- **Backups / migration** — System page: full instance export/import, or per-agent zip export (optionally including volume data; stop the agent first for a consistent copy).
- **Updates** — System page checks for new versions and can upgrade in place (git pull + rebuild).
- **Cleanup** — daily automatic Docker prune (agent volumes are never touched); history on the System page.
- **Alerts** — webhook (Slack/Discord) or Telegram notifications for agent down/recovered and host disk/memory thresholds.

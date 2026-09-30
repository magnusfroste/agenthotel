# The 90-second demo

The video at the top of the README. One story, told in the order someone new
would live it: a server, your own model, an agent, a second agent, and the two of
them sharing what they know. Every step is a real feature, and every timing below
was measured on a real host in September 2026 — the cuts are marked, not hidden.

**The one-line pitch it has to earn:** *Your own GPU. Your own agents. A memory
they share.*

---

## Before you record

Get these ready off camera. Each would otherwise be dead air, or a secret on
screen.

- [ ] **A fresh VPS**, Ubuntu. 4 GB runs it; 8 GB keeps two agents and SkillHub
      out of swap, which shows on camera as stutter. Shot 1 installs on it for real.
- [ ] **Your model server reachable from that VPS** — a DGX Spark, or any
      vLLM / llama.cpp / Ollama endpoint. Not
      `localhost`: the panel reaches it from the server, not from your laptop.
- [ ] **Two hostnames pointing at the VPS** for the agents, e.g. `ada.` and
      `grace.` under a domain you own. A third, `memory.`, for SkillHub.
- [ ] **SkillHub already deployed** from Templates. It takes ~3½ minutes and
      shows nothing worth watching; shot 5 opens with it running.
- [ ] **The Hermes image already built once.** The first agent builds it (9½
      minutes measured); every later agent starts in about a second. Deploy a
      throwaway agent beforehand and delete it.
- [ ] **A browser profile with nothing in it** — no bookmarks bar, no other tabs,
      no password manager popping up over the login form.
- [ ] **Screen at 1920×1080, browser zoom 125%.** Monospace ids must be legible
      on a phone.

### Never on screen

This project leaked more than one secret into a transcript. Don't repeat it on
video, where it cannot be taken back.

- The **API key** field when adding the model — paste it off camera, or blur.
- The **Credentials** tab of any agent.
- The **MCP token** on the System page.
- A terminal showing `.env`, `auth.json`, or `docker inspect`.
- The setup link from shot 1, until the admin account exists.

---

## The shots

Times are the finished video. *(cut)* marks where real time is skipped — say so
with a small on-screen "sped up", never a seamless edit.

### 1 · Install — 0:00–0:10

**Screen:** a terminal on the fresh VPS.

```bash
git clone https://github.com/magnusfroste/agenthotel.git && cd agenthotel && ./install.sh
```

*(cut — about 10 minutes: Docker, the images, the panel)* → the banner
`Installation Complete!` and the setup link under it → the browser on the
panel's setup page, the code already filled in.

The link's code is spent the moment the admin is created, but blur it anyway:
until then it is the one thing that makes the panel yours.

**Voice:** "One command on a fresh server. That's the whole install."

### 2 · Your own model — 0:10–0:28

**Screen:** Providers → **Add your own model**. Type the base URL *without* `/v1`:

```
https://gpu.example.com
```

(your own server's address — the example is a placeholder)

Key pasted off camera. **Find models.**

It answers with `/v1 added`, the model, and **262k context**. Type the name
`dgxspark` and hold for a second on the hint underneath:

> An agent will use `dgxspark/glm-5.3-flash`.

**Add.**

**Voice:** "Point it at your own GPU. It asks the server what it runs, checks the
model is big enough for an agent, and tells you exactly what to write."

*Why this shot:* it is the one r/LocalLLaMA will stop scrolling for. Leaving off
`/v1` on purpose shows the panel meeting people where they are.

### 3 · An agent on it — 0:28–0:40

**Screen:** Templates → Hermes → Deploy. Name `ada`, domain `ada.<yours>`, model
`dgxspark/glm-5.3-flash` (paste it from the Providers card — the click-to-copy is
worth one second of screen time). Deploy.

*(cut — ~30 seconds, the image is already built)* → the agent, **running · healthy**.

**Voice:** "An agent, on your hardware, with its own address."

### 4 · Does it work? — 0:40–0:50

**Screen:** Ada's overview → **Test this agent** → **Test**. Let the counter run
for two or three seconds on camera, then *(cut)* to:

> ✓ The model answered in 15.0s. Chat will work.

**Voice:** "One click tells you it actually works — before your first
conversation does."

### 5 · A memory they share — 0:50–1:05

**Screen:** a second agent, `grace`, already deployed the same way. On Ada's
overview, the **Shared memory — SkillHub** card → **Connect**. The result:

> ✓ Connected as `agent_01`… SkillHub says: *"agent": "agent_01" — Verified by the
> gateway from your API key.*

Cut to Grace → **Connect** → `agent_02`.

**Voice:** "Connect them to SkillHub in one click. Each gets its own identity —
SkillHub knows who wrote what."

### 6 · The payoff — 1:05–1:25

**Screen:** Ada's chat. Type:

> Save this to SkillHub as a public note: we ship the public beta on 14 November,
> signed off after the pricing review.

It answers that it saved the note. *(cut — ~25 seconds while the note is
indexed)*

Grace's chat. Type — and make the audience notice there is **no word in common**:

> When does the product go live for customers?

Grace searches SkillHub and answers **14 November**, citing the note from Ada.

**Voice:** "Different words, same meaning. Grace found what Ada wrote — the way a
colleague would."

*Measured at the store level:* the question above finds the note by meaning with
similarity 0.47, the next-best hit at 0.25, and keyword search does not find it at
all. Rehearse the agent-level version once before recording: a model can decide to
answer from its own head instead of searching. If Grace does that, add "check
SkillHub" to the question — honest, and it still makes the point.

### 7 · Close — 1:25–1:30

**Screen:** the dashboard: both agents and SkillHub green. Fade to:

> **AgentHotel** — self-hosted, MIT
> github.com/magnusfroste/agenthotel

**Voice:** "AgentHotel. Your agents, your models, your server."

---

## After recording

- Export at 1080p; a GIF of shots 2 and 6 for the README header, where video does
  not autoplay.
- Title for the post: *Show HN: AgentHotel — run AI agents on your own GPU, with
  a memory they share.*
- Delete the rehearsal note from SkillHub if the recording host is one you keep.

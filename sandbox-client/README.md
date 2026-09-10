# Sandbox client — the hardened Docker sandbox

This is the **sandbox-client** piece of `docker-agentic-harness-sandbox` (see [the root README](../README.md) for how it relates to the **server** in [`../server/`](../server/) and the Docker-free **[`../native-client/`](../native-client/)**). Run agentic coding tools — OpenCode, OMP, and more — inside a single hardened Docker container with a **browser-based terminal** (WeTTY over HTTPS). It talks to a running server (yours, in `../server/`, or someone else's) over the network — no inference stack runs in this container. No cloud API keys required.

Access the terminal from any browser — desktop or mobile — at `https://<host>:1111`. tmux keeps the agent session alive across reconnects: close the tab, come back later, reattach.

A companion **image upload page** runs on `https://<host>:1112`. Paste a screenshot with Ctrl+V, drag-and-drop, or use the file picker — the image is saved to `workspace/uploads/` and the page gives you the exact path to paste into the terminal.

---

## Table of Contents

- [A hardened Docker harness for agentic coding tools](#a-hardened-docker-harness-for-agentic-coding-tools)
  - [Table of Contents](#table-of-contents)
  - [Prerequisites](#prerequisites)
  - [Directory Structure](#directory-structure)
  - [Get, Build \& Run](#get-build--run)
  - [Verify Everything Works](#verify-everything-works)
    - [OpenCode](#opencode)
    - [OMP](#omp)
  - [Usage Tips](#usage-tips)
    - [Working with files](#working-with-files)
    - [Resetting sandbox state](#resetting-sandbox-state)
    - [Tool selection](#tool-selection)
    - [Session management](#session-management)
    - [Uploading screenshots and images](#uploading-screenshots-and-images)
    - [Image analysis with Claude Code](#image-analysis-with-claude-code)
    - [Running one-shot tasks (headless)](#running-one-shot-tasks-headless)
    - [Modes (OpenCode)](#modes-and-initial-token-overhead)
    - [Context window awareness](#context-window-awareness)
  - [Troubleshooting](#troubleshooting)
  - [Security Notes](#security-notes)
  - [Included Software](#included-software)
  - [Build Argument](#build-argument)
  - [Using Tools and Skills](#using-tools-and-skills)
    - [Commands](#commands)
    - [Skills](#skills)


## Prerequisites

- Docker + Docker Compose installed on your machine
- A running server (see [`../server/`](../server/), yours or someone else's) exposing a LiteLLM
  endpoint and a searXNG endpoint reachable from this machine
- `LITELLM_UPSTREAM` and `SEARXNG_URL` set to that server's addresses (see `.env.example`)

> **How this works:** The agent tools running inside this container are clients to a server —
> possibly on another machine entirely — which is itself a client to an inference backend (vLLM,
> llama.cpp, SGLang, ...). This container has no direct access to any model weights; all inference
> goes through the server's API endpoints. If a tool ever needs to identify which model it is
> using, it must look it up via the API or a web search based on the model id from the catalog
> (`config/models/models.yml`).

### Configuring your models

Models are configured **inside the browser terminal**, not in `.env`: open the session, pick
**model configuration** on the first screen, and the wizard walks you through it. Until a brain is
assigned the menu shows the wizard in red and blocks sessions, so nobody runs into gateway errors
first. A vision model is optional (without one, images are dropped with a note).

This catalog is owned entirely by this client — nothing on the server side reads or needs it.

The wizard manages one file — `config/models/models.yml` (the catalog; start from
`config/models/models.example.yml`, hand-editing is fine too):

- **add server** — name + OpenAI-compatible base URL (`http://host:port/v1`); the wizard calls
  `GET /v1/models`, lists what the server serves, and you pick which models to *keep* (`1,3` or
  `all`). **Every server you add is talked to directly, at its own address — full stop.** That's
  real freedom of choice: mix your own server's brain model with a raw vLLM box you happen to have
  access to, with someone else's whole server, whatever combination you want, and each request for
  each model goes exactly where you told it to, not funneled through one "main" address.
  - **The recommended default** is to add ONE server pointing at the same address you set
    `LITELLM_UPSTREAM` to — your own server transparently reports every real model it actually
    serves (even across several nodes; see `../server/README.md`), so this one entry is usually all
    you need, context window included: `GET /v1/models` alone can't carry that (fixed by the OpenAI
    spec to id/object/created/owned_by, on any OpenAI-compatible server), so the wizard also checks
    your server's `/model/info` — a LiteLLM-specific endpoint that does report it (see
    `../server/scripts/render-litellm-config.sh`) — and uses whichever answers.
  - **A raw vLLM/llama.cpp/SGLang address directly** — only if you can actually reach that box
    yourself. Claude talks to it directly too; `claude-shim` (`scripts/claude-shim.js`) translates
    Anthropic↔OpenAI on the fly since a raw model server doesn't speak Claude's wire format itself
    — text, images, tool calls, thinking, streaming, all translated both ways. Its own `/v1/models`
    already reports context directly, so discovery works the same way.
  - **A separate full server stack** (someone else's `../server/`, or a second one of your own) —
    the wizard detects this automatically (probes `/model/info`) and marks it so Claude talks to it
    with raw, untranslated bytes, since it already speaks Claude's wire format itself.
  - Always manual either way: "can it see images?" (never reported by any endpoint).
- **assign roles** — exactly one **brain** (the primary) and optionally one **vision** (handles
  image requests; may be the brain itself if it can see; must be marked vision-capable). Every
  other model in the catalog stays known and selectable in the tools (`/model <id>` in Claude
  Code, the opencode and OMP pickers).
- **edit / delete server**, **RESET catalog** (backup kept next to the file), **write & exit**.

Nothing needs a restart. On write, the wizard regenerates the tool configs (opencode, OMP —
one provider per server), and `claude-shim` resolves every alias (`brain`, `vision`, `opus`,
`sonnet`, `haiku`, or a raw model id) against the catalog on each request — re-reading the file
whenever it changes, no server involvement needed.

Verify a server is reachable before adding it:

```bash
curl http://<host>:<port>/v1/models
```

---

## Directory Structure

This is the `sandbox-client/` directory of the monorepo (see [`../README.md`](../README.md)). After
cloning, it already contains this layout:

```
sandbox-client/
├── Dockerfile
├── compose.yml             ← defines the `sandbox` service
├── start.sh
├── includes/               ← entrypoint function library, one file per concern (sourced from /includes/ at start)
│   ├── colors.sh           ← colorful echo helpers (e/ei/ew/ee/es) shared by all shell scripts
│   ├── security.sh         ← root requirement + PUID/PGID validation
│   ├── model.sh            ← reads the model catalog roles (for analyze-image); warns if not configured
│   ├── user.sh             ← agent user/group creation, UID/GID realignment, ownership fixes
│   ├── config.sh           ← Claude config sync, tool-config rendering from the catalog (render-models), mcp.json render, opencode auth link
│   ├── tools.sh            ← workspace check + agent-tool discovery/validation (TOOLS, DEFAULT_TOOL)
│   └── services.sh         ← process supervisor + upload server, claude-shim and WeTTY startup
├── scripts/                ← runtime + maintenance scripts (baked into the image)
│   ├── entrypoint.sh       ← container startup manager: sources includes/, runs setup, execs WeTTY
│   ├── agent-session.sh    ← per-browser-connection: privilege drop, tmux session, tool selection
│   ├── agent-task.sh       ← one-shot headless Claude task as the agent user (/usr/local/bin/agent-task)
│   ├── claude-shim.js      ← Claude→server rewrite proxy: image hoisting, vision reroute, AND catalog
│   │                         alias resolution + multi-server dispatch (127.0.0.1:4001, pure Node.js stdlib)
│   ├── upload-server.js    ← image upload companion server (port 1112, pure Node.js stdlib)
│   ├── model-config.sh     ← the model-config wizard (/usr/local/bin/model-config)
│   ├── render-models.sh    ← catalog → tool configs (/usr/local/bin/render-models)
│   ├── analyze-image.js    ← headless vision call helper (/usr/local/bin/analyze-image)
│   └── reset-sandbox.sh    ← wipe generated state from ./workspace and ./data
├── patches/                ← one-off scripts applied to WeTTY at image build time, not present at runtime
│   ├── wetty-clipboard.js  ← adds OSC 52 support so in-container copy actions reach the browser clipboard
│   ├── wetty-font.js       ← default font stack with symbol coverage for Claude Code's marker glyphs
│   ├── wetty-csp.js        ← allows the upload-server iframe to load inside WeTTY without being browser-blocked
│   └── wetty-html.js       ← injects the upload overlay panel (toggle button + slide-in drawer) into WeTTY's page
├── tests/                  ← unit tests (run at image build — a failing test aborts the build)
│   ├── test-claude-shim.js       ← image hoisting, vision routing, class slots, catalog resolution + dispatch (build-time)
│   └── test-wetty-clipboard.js   ← exercises the OSC 52 handler injected into WeTTY's bundle (build-time)
├── config/
│   ├── opencode/
│   │   ├── opencode.json   ← opencode agent config TEMPLATE (providers/model/searxng filled from the catalog by render-models)
│   │   ├── AGENTS.md       ← global sandbox rules for opencode (mounted read-only)
│   │   ├── auth.json       ← opencode provider auth tokens (mounted read-only) — edit before use
│   │   ├── agents/         ← opencode subagent definitions
│   │   ├── commands/       ← slash commands available inside opencode
│   │   └── skills/         ← reusable skill definitions for opencode
│   ├── omp/
│   │   ├── AGENTS.md       ← sandbox rules for omp (mounted read-only)
│   │   ├── config.yml      ← OMP model role TEMPLATE (roles/context filled from the catalog)
│   │   ├── models.yml      ← OMP provider/model TEMPLATE (providers filled from the catalog)
│   │   ├── mcp.json        ← OMP's searxng MCP server TEMPLATE (SEARXNG_URL filled in at container start)
│   │   └── settings.json   ← OMP settings
│   ├── claude/
│   │   ├── settings.json   ← Claude Code settings (env, model, ANTHROPIC_BASE_URL → shim)
│   │   ├── CLAUDE.md       ← global sandbox rules for Claude Code
│   │   ├── claude.json     ← first-run state: dark mode, workspace trust, API key accepted
│   │   └── agents/         ← Claude Code subagents synced into ~/.claude/agents
│   ├── tmux.conf           ← window-size latest (dynamic per-client resize) + OSC 52 clipboard forwarding
│   └── models/             ← the model catalog, owned entirely by this client: models.yml (yours,
│                              gitignored) + models.example.yml; managed by the wizard
├── data/                   ← tool session state, persisted across runs (opencode/, claude/)
└── workspace/              ← put your code projects here (uploads/ holds uploaded images)
```

See [`../server/README.md`](../server/README.md) for the server's own layout (litellm, reasoning-normalizer, searxng), and [`../ideas/`](../ideas/) for design notes shared across both.

---

## Get, Build & Run

```bash
# Get the code
git clone git@github.com:jammsen/docker-agentic-harness-sandbox.git

# Optional settings only (headroom profile, apt mirror, default tool) — models are configured
# in the browser terminal afterwards, see "Configuring your models"
cp .env.example .env

# Build and start in the background
./start.sh

# Force a full rebuild (no layer cache) — useful when the base image digest has been updated
./start.sh --no-cache
```

The container starts in the background (`docker compose up -d`). Open your browser at the URL printed by `start.sh`:

```
https://<your-server-ip>:1111
```

**First visit:** your browser will show a self-signed certificate warning. Accept it once ("Advanced → Proceed" on Chrome/Edge; on iOS Safari you must install the cert via Settings → General → VPN & Device Management). After that, the browser terminal opens directly — no login form.

The terminal runs `agent-session.sh`, which:
1. Drops privileges from root to the `agent` user
2. Offers a tmux session picker (create new or reattach to an existing session)
3. Shows a tool selection menu (opencode, omp, …)
4. Launches the chosen tool inside tmux — closing the browser tab **detaches** rather than kills the session

---

## Verify Everything Works

### OpenCode

Inside the OpenCode TUI:

1. Type `/model` — your model should appear under your provider name with an orange dot
2. Type `hello, what model are you?` — the response should mention your model ID
3. Check the status bar at the bottom — it should show your configured model, for example `Qwen3.6 35B A3B · vLLM`
4. Check the right panel — `$0.00 spent` confirms no cloud API is being used

### OMP

Inside the OMP session:

1. Run `omp status` or check the startup output — your provider and model should be listed
2. Send a message like `hello, what model are you?` — the response should mention your model ID
3. Confirm the provider is `vllm` and the response is served locally

---

## Usage Tips

### Working with files

Drop files into `./workspace/` on your host. They appear at `/home/agent/workspace/` inside the container. The active tool treats this directory as its working root; tool configs live under `/home/agent/.config/` and `/home/agent/.omp/` respectively.

```bash
# Copy a project into the sandbox
cp -r ~/myproject ./workspace/myproject
```

### Resetting sandbox state

Use `scripts/reset-sandbox.sh` only when you intentionally want to remove generated local state from `./workspace/` and `./data/`. It preserves the `.gitkeep` placeholders and requires typing `Yes, do as I say!` before deleting anything.

### Tool selection

After attaching to (or creating) a tmux session, the browser terminal presents a numbered menu. **Only one tool runs per tmux session** — select it and the agent starts.

The menu order and default are controlled by the `TOOLS` env var in `compose.yml`:

```yaml
environment:
  - TOOLS=opencode,omp   # first entry = default
```

Change the order or remove entries to customise what appears. The entrypoint validates each name against installed binaries and skips any that are missing.

To skip the menu entirely, use the `--tool` flag in `start.sh`:

```bash
./start.sh --tool omp
./start.sh --tool opencode
```

This passes `DEFAULT_TOOL` into the container and goes straight to that tool on every new browser connection.

### Session management

Each browser tab runs `agent-session.sh` independently. On connect, a session picker is shown:

```
Existing sessions:
  1. sandbox-started-2026-06-21-16:00:20  (Attached)  (default)
  2. Start a new session

Enter selection [1]:
```

- **Select an existing session** — tmux attach (multiattach by default) — multiple browser tabs/devices share the session, and `window-size latest` resizes it to whichever client was active last (phone and desktop each get a proper fit).
- **Start a new session** — creates a fresh tmux session with a new timestamped name and runs the tool selector again.
- **Close the browser tab** — detaches from tmux. The agent keeps running. Reopen the browser and reattach to continue where you left off.
- **Clipboard** — tmux forwards OSC 52 copies natively (`set-clipboard on`), so long copies are no longer capped at ~500 characters like under GNU screen.
- **First-ever connection** (no existing sessions) — the picker shows only "Start a new session". Press Enter or type `1` to start; any other input re-prompts.
- **Invalid input** — the picker re-prompts rather than silently defaulting.

#### Why two separate scripts?

`entrypoint.sh` and `agent-session.sh` have different lifetimes and different jobs:

- **`entrypoint.sh`** runs **once** at container startup as root. It owns all system-level work: UID/GID setup, chown, config sync, starting the supervised background services (upload server, claude-shim). It never drops to the agent user itself because it must stay alive as the process supervisor.
- **`agent-session.sh`** runs **once per browser tab**, spawned by WeTTY as root. Its first act is `gosu agent` — dropping privileges before doing anything else. By that point `entrypoint.sh` has already guaranteed the environment is correct, so no re-validation is needed. It only handles the session picker and tool selection.

The scripts look unbalanced because they serve different scopes: one-time system setup vs. per-connection user logic.

### Modes and initial token overhead

| Tool       | Mode    | Shortcut | Token overhead          | Best for                               | Notes                                                                                                     |
| ---------- | ------- | -------- | ----------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| OpenCode   | Build   | default  | ~10k tokens             | Agentic file editing, multi-step tasks |                                                                                                           |
| OpenCode   | Ask     | `tab`    | ~3–5k tokens            | Questions, code review, explanations   | Leaves significantly more room with a 32k context limit                                                   |
| Claude Code | Default | —       | ~27k tokens             | All tasks                              | ~2.5k system prompt + ~14–17k tool definitions; volatile across patch releases, grows with CLAUDE.md files |
| OMP        | Default | —        | Not publicly documented | All tasks                              | Single interactive session, no mode concept                                                               |

### Uploading screenshots and images

The container runs a companion upload server on port 1112 alongside the terminal. Open it at `https://<host>:1112` in any browser tab.

**Three ways to add an image:**

| Method | Steps |
|---|---|
| Clipboard paste | Take a screenshot (e.g. Win+Shift+S on Windows), switch to the upload tab, press **Ctrl+V** |
| Drag and drop | Drag an image file from your file manager onto the drop zone |
| File picker | Click the drop zone to open a standard file browser dialog |

After clicking **Upload**, the page shows:

```
Please post this path to your agent:
/home/agent/workspace/uploads/2026-06-21-14-30-00-a3f2.png
```

Copy the path and paste it into the terminal. The upload icon (↑) in the WeTTY sidebar links directly to the upload page.

Files are saved to `./workspace/uploads/` on your host (same mount as the workspace). Only PNG, JPEG, GIF, and WEBP are accepted; files are validated by magic bytes, not just filename extension. Maximum size is 50 MB. Filenames include a short random suffix to prevent collisions when multiple uploads land in the same second.

### Copying text to your clipboard

Copy actions inside the container (e.g. Claude Code's copy shortcuts) reach your browser clipboard via OSC 52 — WeTTY's terminal is patched for this at build time (`patches/wetty-clipboard.js`). Clipboard reads are deliberately not supported, only writes.

- **No size limit:** tmux (which wraps every session) forwards OSC 52 natively via `set-clipboard on` — long copies work (under GNU screen they were capped at ~500 characters).
- **Manual selection** as fallback: hold **Shift** while dragging to select, then **Ctrl+Shift+C** — works best while the agent is idle, since TUI redraws clear the selection.

---

### Image analysis with Claude Code

WeTTY is a browser terminal, so you **cannot paste a screenshot into the Claude Code console**. Instead:

1. Upload the image via the companion page (`https://<host>:1112`) — see [Uploading screenshots and images](#uploading-screenshots-and-images).
2. In the terminal, type the path and ask for analysis, e.g.:
   ```
   Analyse the image at /home/agent/workspace/uploads/2026-06-21-14-30-00-a3f2.png and describe what you see.
   ```
3. Claude Code uses its **Read tool** on that path. Read natively encodes the file and sends it to the model as a real image block — this is the only mechanism that delivers actual pixels. Do **not** ask the model to `base64`-encode the file by hand; raw base64 text is not an image and the model cannot see it.

**How the image actually reaches your model.** Claude Code speaks the Anthropic Messages API, while your server's vLLM speaks the OpenAI chat/completions API, so hops translate between them:

```
Claude Code ──Anthropic /v1/messages──▶ claude-shim (127.0.0.1:4001, this client)
            ──▶ your server's LiteLLM (LITELLM_UPSTREAM)
            ──▶ reasoning-normalizer (brain path only) ──▶ vLLM (/v1/chat/completions)
```

- **`claude-shim`** (`scripts/claude-shim.js`, started by the entrypoint) is a tiny pure-stdlib proxy, and does four things: (1) Claude Code's Read tool returns images inside Anthropic `tool_result` blocks, and LiteLLM drops images nested there when translating to chat/completions (OpenAI tool-role messages cannot carry images) — the shim lifts each image out into a normal user message before forwarding, the placement vLLM accepts. (2) it resolves the model catalog's aliases (`brain`, `vision`, `opus`, `sonnet`, `haiku`, a raw model id) to the real served model id — see "Configuring your models" above; your server no longer does this. (3) it dispatches every resolved model directly to its own server's address — never funneled through one "main" server. (4) for a plain (non-gateway) server — a raw vLLM/llama.cpp/SGLang box, not another full server stack — it translates Anthropic↔OpenAI both ways on the fly (text, images, tool calls, thinking, streaming), since that box doesn't speak Claude's wire format itself; a server marked as a full gateway gets raw, untranslated bytes instead. Both the shim and the upload server are supervised: if either crashes it restarts automatically (shim within 5 s, upload server within 30 s) without disrupting running agent sessions.
- **Your server's LiteLLM** translates Anthropic↔OpenAI and passes every model name through as `hosted_vllm/*` to its reasoning-normalizer (a static wildcard config). `hosted_vllm/` makes LiteLLM use chat/completions (the `openai/` prefix instead routes image requests through the OpenAI Responses API, which vLLM rejects).
- **Your server's `reasoning-normalizer`** sits between LiteLLM and vLLM. DeepSeek V4 Flash (and similar models) stream the last reasoning token and the first answer token in a single delta with no boundary between them; LiteLLM then misfiles that thinking token into a text block and Claude Code aborts the turn with *"Content block is not a thinking block"*. The normalizer splits any such fused delta into two, so the brain looks like a well-behaved reasoning model. It is a no-op for models that don't fuse the fields. See [`../server/README.md`](../server/README.md) and [`../ideas/deepseek-thinking-block-bug.md`](../ideas/deepseek-thinking-block-bug.md) for the full investigation.

The model answering the request must be **vision-capable** for any of this to return a real description — when the catalog's brain has `vision: false` the shim routes image requests to the vision role automatically, so it is the vision model you should test here. If images come back as generic hallucinations, confirm the model serves vision over chat/completions:

```bash
curl http://YOUR_VLLM_IP:8000/v1/chat/completions -H "Content-Type: application/json" -d '{
  "model": "YOUR_MODEL_ID",
  "messages": [{"role":"user","content":[
    {"type":"image_url","image_url":{"url":"https://a-z-animals.com/media/tiger_laying_hero_background.jpg"}},
    {"type":"text","text":"What animal is in this image?"}]}]}'
```

### Running one-shot tasks (headless)

Besides the interactive browser terminal, you can run a **single Claude Code task non-interactively** and capture its final answer on stdout — useful for scripting, cron jobs, or quick questions:

```bash
docker exec agentic-harness-sandbox agent-task "Summarise WORKLOG.md in 3 bullet points"

# pipe data in on stdin
echo "$LOGS" | docker exec -i agentic-harness-sandbox agent-task "What error repeats most in this log?"

# override the default autonomy (e.g. read-only planning)
docker exec agentic-harness-sandbox agent-task "Outline a refactor of foo.py" --permission-mode plan
```

`agent-task` (`scripts/agent-task.sh`, installed at `/usr/local/bin/agent-task`) wraps `claude -p` and runs the workspace as its project root. It **always drops root → `agent` via gosu** before launching Claude — see [Security Notes](#security-notes) — so a task can never run with more privilege than an interactive session, regardless of how it is invoked. By default it runs autonomously (`--permission-mode bypassPermissions`) because the container itself is the security boundary; pass your own `--permission-mode` to change that.

---

### Context window awareness

For OpenCode, the status bar shows `X tokens (Y% used)`. Build mode consumes ~10,000 tokens just for the system prompt before you type anything. For large codebases, open only the files you need or use Ask mode.

---

## Troubleshooting

**Browser shows "Session ended" immediately on connect**

A stale tmux session may be blocking attachment. Clean it up:

```bash
docker exec agentic-harness-sandbox su -s /bin/bash agent -c "tmux kill-server"
```

Then reconnect in the browser.

**Config not loading / provider picker appears on every launch**

```bash
docker exec agentic-harness-sandbox cat /home/agent/.config/opencode/opencode.json
```

If this returns an error, check that `docker compose` is run from the same directory as `compose.yml` and that `./config/opencode/opencode.json` exists.

**`GID already exists` error during build**

Ubuntu 26.04 ships with a default user at UID/GID 1000. The Dockerfile handles this by renaming the existing user instead of creating a new one. Ensure you are using the Dockerfile exactly as provided above.

**Model not responding / timeout**

```bash
# Test connectivity to your server from inside the running container
docker exec agentic-harness-sandbox curl -s $LITELLM_UPSTREAM/models
```

If this fails, your server is unreachable from this container — check `LITELLM_UPSTREAM` (see [`../server/README.md`](../server/README.md)) and that the server itself is up and can reach its own vLLM.

**[OpenCode] Tool calling loops or model halts mid-task**

Some local models can struggle with long agentic tool-use loops. Mitigations:

- Prefer **Ask mode** for questions and code review that don't require file editing
- For Build mode, give explicit step-by-step instructions rather than open-ended goals
- Keep tasks scoped to one file or one function at a time

---

## Security Notes

The container starts as root to handle setup (creating the user, fixing file ownership on mounted volumes). WeTTY also runs as root — this is required for WeTTY v3 to use local/command mode instead of SSH mode. The privilege drop happens inside `agent-session.sh` via `gosu agent` on every browser connection, before tmux or any agent tool starts. There is no way back to root after that point.

**Restrictions in place:**

- **Pinned base image digest** — the `FROM` line in the Dockerfile references `ubuntu:26.04` by its exact SHA-256 digest. This ensures every build uses bit-for-bit the same base layer regardless of what the upstream tag points to, preventing supply-chain attacks via tag mutation.
- **`umask 0027`** — files created by the entrypoint are not world-readable by default. Only the owning user and group can read them; others have no access.
- **PUID/PGID validation** — the entrypoint rejects non-positive-integer values immediately at startup, preventing misconfigured or injected UID/GID values from silently running the app as root.
- **`no-new-privileges`** — once the container drops to the unprivileged user, no process inside the container can ever gain more permissions, even if it tries to run a `sudo` binary or a binary with special file capabilities. The kernel enforces this hard, before any code in such a binary even runs.
- **`cap_drop: ALL`** — Linux capabilities are fine-grained units of root power (e.g. "change file ownership", "bind to privileged ports", "load kernel modules"). By default Docker grants containers a subset of these even without full root. Dropping all of them removes every one of those powers.
- **`cap_add: CHOWN, SETUID, SETGID, DAC_OVERRIDE`** — only the four capabilities the entrypoint actually needs for its setup phase are added back. Once `gosu` drops to the non-root user, the kernel automatically clears the effective capability set on the UID transition, and `no-new-privileges` blocks any path to reclaiming them.
- **`PUID` / `PGID`** — the in-container user is created at runtime with the same UID/GID as your host user. This ensures bind-mounted files in `./workspace` and `./data` have correct ownership on both sides of the mount.
- Bridge networking only — isolated from the host network
- Writable filesystem access is limited to `./workspace` and `./data` on the host. Config, commands, skills, and auth are mounted read-only.
- **`agent-task` preserves the privilege drop** — a plain `docker exec agentic-harness-sandbox claude ...` would run Claude as **root**, since the container's entrypoint runs as root and `exec` inherits that user. The `agent-task` wrapper instead re-execs itself under `gosu agent` before launching Claude — the same drop path browser sessions use — so one-shot tasks can never run with more privilege than an interactive session. With `no-new-privileges` + `cap_drop: ALL` in force, there is no path back to root afterwards.

**Port 1112 (image upload) assumes a trusted audience.** The upload server exposes unauthenticated list, upload, and delete operations — intentionally, to avoid requiring a separate login for every browser tab. This is a conscious tradeoff for the homelab/sandbox use case where the operator and user are the same trusted person. If you expose port 1112 to a wider network, anyone who can reach it can enumerate workspace paths, upload arbitrary files, and delete uploads. In that case, put a reverse proxy with authentication in front, or remove the port mapping from `compose.yml` entirely and access the upload page through a tunnel.

The model runs entirely on your local vLLM server. No data leaves your network.

## Included Software

All runtimes and tools are installed at **build time** under the `agent` user — the container starts instantly with no downloads at startup.

| Software | How installed | Purpose |
| --- | --- | --- |
| `opencode` | `opencode.ai/install` | Agentic coding tool with TUI — [opencode.ai](https://opencode.ai) |
| `omp` | `omp.sh/install` | Agentic coding tool (CLI) — [omp.sh](https://omp.sh) |
| `claude` | `claude.ai/install.sh` | Claude Code CLI — talks to your server's model through `claude-shim` + LiteLLM — [claude.com/claude-code](https://claude.com/claude-code) |
| `claude-shim.js` | bundled (Node.js stdlib) | Lifts images out of Claude Code `tool_result` blocks, resolves the model catalog, dispatches to your server (or another marked `anthropic: true`) — 127.0.0.1:4001 |
| `agent-task` | bundled | Run a one-shot headless Claude Code task as the `agent` user (`docker exec … agent-task "…"`) |
| `wetty` | npm global | Browser-based terminal over HTTPS (port 1111) — [npmjs.com/package/wetty](https://www.npmjs.com/package/wetty) |
| `upload-server.js` | bundled (Node.js stdlib) | Image upload companion page (port 1112) — drag-drop, Ctrl+V paste, file picker |
| `tmux` | apt | Session persistence + per-client dynamic resizing + OSC 52 clipboard — [github.com/tmux/tmux](https://github.com/tmux/tmux) |
| Node.js + npm | apt | Runtime for WeTTY; available in workspace for Node.js projects — [nodejs.org](https://nodejs.org) |
| Python (`uv`) | `astral.sh/uv` | General scripting in the workspace — [docs.astral.sh/uv](https://docs.astral.sh/uv/) |
| Rust (`rustup`) | `sh.rustup.rs` | General building in the workspace — [rustup.rs](https://rustup.rs) |
| `ripgrep` | apt | File search used by agent tools — [github.com/BurntSushi/ripgrep](https://github.com/BurntSushi/ripgrep) |
| `tzdata` | apt | Europe/Berlin timestamps — [packages.ubuntu.com](https://packages.ubuntu.com/search?keywords=tzdata) |
| `git` | apt | Version control inside the container — [git-scm.com](https://git-scm.com) |
| `gosu` | apt | Privilege drop from root to `agent` user — [github.com/tianon/gosu](https://github.com/tianon/gosu) |

Tool binaries are on `PATH` and their data directories (`CARGO_HOME`, `RUSTUP_HOME`) are pinned via environment variables so they survive the `HOME` redirect used to route session state to the mounted workspace.

## Build Argument

The only build argument is the Python version. Change it in `compose.yml` before building:

```yaml
# compose.yml
services:
  sandbox:
    build:
      context: .
      args:
        PYTHON_VERSION: "3.12"   # change to any version supported by uv
```

Then rebuild:

```bash
./start.sh --no-cache
```

---

## Using Tools and Skills

### Commands

Sandbox-wide commands and skills are mounted globally:

```yaml
- ./config/opencode/AGENTS.md:/home/agent/.config/opencode/AGENTS.md:ro
- ./config/opencode/commands:/home/agent/.config/opencode/commands:ro
- ./config/opencode/skills:/home/agent/.config/opencode/skills:ro
```

Note: `./config/opencode/AGENTS.md` is intentionally separate from `./config/opencode/opencode.json` — the AGENTS.md path is referenced in the opencode system prompt and must be mounted at its exact target location.

This makes the commands available regardless of which project under `./workspace/` you open. Project-specific commands, skills, and `AGENTS.md` files can still live inside the project directory.

`AGENTS.md` is intentionally short: it gives global orientation. Repeatable process requirements live directly in the commands, because local models follow concrete command workflows more reliably than broad standing instructions.

Available sandbox commands:

- `/refactor-audit <target>` — analyze refactor opportunities without editing files
- `/refactor-apply <approved scope>` — apply one focused approved refactor, verify it, and update `WORKLOG.md`
- `/git-commit` — review, document, and commit approved changes using Conventional Commits

### Skills

Skills are reusable on-demand capabilities for an agent. They use one directory per skill with a mandatory `SKILL.md`.

The included `write-worklog` skill provides a structured `WORKLOG.md` entry format for ad-hoc tasks. Command-driven workflows inline their own worklog format so they do not depend on automatic skill selection.

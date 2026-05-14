# OpenCode + vLLM (Gemma 4 26B MoE) — Docker Sandbox Setup

Run OpenCode as a sandboxed, non-root Docker container connected to a self-hosted vLLM inference server. No cloud API keys required.

***

## Prerequisites

- Docker + Docker Compose installed on your machine
- Access to a running vLLM server exposing an OpenAI-compatible API (e.g. `http://10.0.0.13:8000`)
- Your vLLM server must have the model loaded and `/v1/models` responding

Verify your vLLM is reachable before starting:
```bash
curl http://10.0.0.13:8000/v1/models
```
You should see your model ID in the response (e.g. `gemma4-26b-a4b`).

Use the exact `"id"` value from the response — e.g. `gemma4-26b-a4b`.

**Finding your context size:**
The `max_model_len` field in the `/v1/models` response is your context limit. Use that value for `"context"`.

***

## Directory Structure

Create the following layout on your machine:

```
opencode-sandbox/
├── Dockerfile
├── docker-compose.yml
├── config/
│   └── opencode.json
└── workspace/          ← put your code projects here
```

***

## Build & Run

```bash
# Build the image (takes ~2-3 minutes on first run)
docker compose build

# Launch OpenCode interactively
docker compose run --rm opencode
```

On first launch OpenCode opens the TUI. Press `/` to open the command palette.

***

## Verify Everything Works

Inside the TUI:

1. Press `/model` — your model should appear under your provider name with an orange dot
2. Type `hello, what model are you?` — the response should mention your model ID
3. Check the status bar at the bottom — it should show `Gemma 4 26B MoE · vLLM (Gemma4 local)`
4. Check the right panel — `$0.00 spent` confirms no cloud API is being used

***

## Usage Tips

### Working with files

Drop files into `./workspace/` on your host. They appear at `~/workspace/` inside the container. OpenCode operates within this directory and cannot access anything outside it.

```bash
# Copy a project into the sandbox
cp -r ~/myproject ./workspace/myproject
```

### Modes

| Mode | Shortcut | Token overhead | Best for |
|------|----------|----------------|----------|
| Build | default | ~10k tokens | Agentic file editing, multi-step tasks |
| Ask | `tab` | ~3-5k tokens | Questions, code review, explanations |

With a 32k context limit, **Ask mode** leaves significantly more room for your actual code and conversation.

### Context window awareness

The status bar shows `X tokens (Y% used)`. Build mode consumes ~10,000 tokens just for the system prompt before you type anything. For large codebases, open only the files you need or use Ask mode.

***

## Troubleshooting

**Config not loading / provider picker appears on every launch**

```bash
docker compose run --rm --entrypoint bash opencode -c \
  "cat /home/opencode/.config/opencode/opencode.json"
```

If this returns an error, check that `docker compose` is run from the same directory as `docker-compose.yml` and that `./config/opencode.json` exists.

**`GID already exists` error during build**

Ubuntu 26.04 ships with a default user at UID/GID 1000. The Dockerfile handles this by renaming the existing user instead of creating a new one. Ensure you are using the Dockerfile exactly as provided above.

**Model not responding / timeout**

```bash
# Test vLLM connectivity from inside the container
docker compose run --rm --entrypoint bash opencode -c \
  "curl -s http://YOUR_VLLM_IP:8000/v1/models"
```

If this fails, your vLLM IP is unreachable from the container. Use the actual host IP — not `localhost`.

**Tool calling loops or model halts mid-task**

This is a known Gemma 4 behavior with agentic tool use. Mitigations:
- Prefer **Ask mode** for questions and code review that don't require file editing
- For Build mode, give explicit step-by-step instructions rather than open-ended goals
- Keep tasks scoped to one file or one function at a time

***

## Security Notes

The container runs with the following restrictions:

- Non-root user (UID 1000)
- `no-new-privileges` — prevents privilege escalation via setuid binaries
- `cap_drop: ALL` — all Linux capabilities removed
- Bridge networking only — no host network access
- Filesystem access limited to `./workspace` on the host

The model runs entirely on your local vLLM server. No data leaves your network.
# OpenCode Sandbox Rules

You are running inside a hardened Docker sandbox. You are a client to a dedicated vLLM server accessible only via its API endpoint — you have no direct access to the model weights. If you need information about yourself (capabilities, training cutoff, context size, etc.), look it up online based on your model ID.

All projects are located under `/home/agent/workspace`. Work only inside this directory, with no exceptions, unless the user explicitly asks for access outside the sandbox.

When starting work in an existing project directory, check whether `WORKLOG.md` exists and read it for prior context. Commands that change files define their own required worklog steps; follow the command workflow exactly.

Create a new subdirectory under `/home/agent/workspace` only when the user asks for a new standalone task or project. If an existing project directory might match the request, ask the user to confirm whether to use it, and recommend a clear directory name before creating anything new. Do not create nested duplicate project directories.

Prefer focused changes over broad rewrites. Extend existing behavior through the smallest fitting change before replacing working code. Before large refactors, first produce a short audit and wait for the user to choose what should be changed.

## Sandbox Commands

Use the mounted sandbox commands for repeatable workflows when they fit the task:

- `/refactor-audit <target>`: inspect the named file, directory, symbol, or current git diff for refactor opportunities without editing files.
- `/refactor-apply <approved scope>`: apply one focused refactor after the user has approved the scope, then verify and update `WORKLOG.md`.
- `/git-commit`: review, document, and commit approved changes using Conventional Commits.

Do not treat commands as mandatory for every task. They are shortcuts for user-invoked workflows and should not replace direct, focused work when the user has already given a clear instruction.

## Using Playwright

Playwright with Chromium is pre-installed. Because this container runs with `cap_drop: ALL`, Chromium's built-in process sandbox cannot function — you **must** disable it or Chromium will refuse to start:

```typescript
// playwright.config.ts or inside test/script launch options
use: {
  launchOptions: {
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
},
```

Or when launching programmatically:

```typescript
const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
```

The browser binary is at `$PLAYWRIGHT_BROWSERS_PATH` (`/home/agent/.cache/ms-playwright`). Do not move or reinstall it — it is baked into the image.

## Running Background Servers

Port **3000** is the externally reachable port for agent-hosted servers. Port 1111 is reserved for the WeTTY browser terminal. If the user wants to expose a server (dev server, HTTP API, or any other service), bind it to `0.0.0.0:3000`.

**Always check before starting a server** — do not blindly launch a new process:

```bash
ss -tlnp | grep 3000
```

If something is already listening, do not start another instance. If the port is free, start the server with `nohup` so it survives the current shell invocation:

```bash
nohup <your server command> > /tmp/server.log 2>&1 & echo $! > /tmp/server.pid
```

Use `/tmp/server.log` for output and `/tmp/server.pid` to track the PID. To stop the server:

```bash
kill $(cat /tmp/server.pid) 2>/dev/null || true
```

After killing, verify the port is free before proceeding:

```bash
ss -tlnp | grep 3000 || echo "Port 3000 is free"
```

**Never use `lsof -i :<port>` to find or kill processes** — `lsof` network socket inspection hangs in this container due to capability restrictions. Always use the PID file to kill, and `ss` to verify.

**Never use `pkill -f` as a primary kill method** — many runtimes (Node.js, Python, Rust binaries, JVM) spawn child processes whose names do not match the original command. The PID file is the only reliable kill target.

Never use `&` alone without `nohup` for servers — background processes started without `nohup` may not survive shell resets.

## Web Search

`curl` and `wget` work fine for fetching a known URL directly. The built-in `webfetch` and `websearch` permissions are disabled. For search queries (no URL), use the `searxng_web_search` MCP tool — search engines block automated curl requests, so curl will return nothing useful on search pages. `web_url_read` is also available to fetch and convert a URL to markdown.

## Image Analysis

When asked to analyze or describe an image at a file path, run the `analyze-image` command and report its output:

```bash
analyze-image /path/to/image.png "your question or focus here"
```

Pass the user's intent as the second argument. If no specific focus is given, omit it and the default description prompt is used. Do not attempt to read the raw binary file, install packages, or write Python scripts to inspect the image. The `analyze-image` command handles vision analysis directly and returns a text description. This is the ONLY permitted vision path: never inline image bytes or base64 into the conversation — the vision model's context (131k) is far smaller than the brain's, and `analyze-image` keeps the conversation out of the vision call by design.

## Skills

Use the `write-worklog` skill only when a detailed `WORKLOG.md` entry is needed or the user asks for worklog formatting. For command-driven workflows, prefer the worklog format embedded in the command itself.

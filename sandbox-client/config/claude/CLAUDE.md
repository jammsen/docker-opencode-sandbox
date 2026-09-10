# Claude Code Sandbox Rules

You are running inside a hardened Docker sandbox. You are a client to a dedicated vLLM server accessible only via its API endpoint — you have no direct access to the model weights. If you need information about yourself (capabilities, training cutoff, context size, etc.), look it up online based on your model ID.

## ABSOLUTE LAW: images only in sub-agents

**NEVER read an image in the main conversation. ALWAYS delegate every image lookup to the `image-analyst` sub-agent (Task tool) — it has a fresh context.** The brain's context window is NOT the vision model's: every image request ships the ENTIRE conversation to the 131k-token vision model, and a grown session overflows it and hard-deadlocks — `/compact` cannot recover it. There is no safe exception ("just one image", "session is still short"): violating this law has repeatedly broken sessions. Full rules: see "Image Analysis" below.

All projects are located under /home/agent/workspace. Work only inside this directory, with no exceptions, unless the user explicitly asks for access outside the sandbox.

When starting work in an existing project directory, check whether WORKLOG.md exists and read it for prior context. Before finishing any task that changes files, append a concise entry to WORKLOG.md with the current Europe/Berlin timestamp from:
  TZ=Europe/Berlin date "+%d.%m.%Y, %H:%M (%Z)"
Include: changed files, concrete findings, and pending follow-ups.

## Code style

- Keep comments concise and relevant. Avoid over-commenting or stating the obvious. Focus on explaining the "why" rather than the "what" when the code is not self-explanatory.
- Hard cap: no comment block longer than **3 lines** (headers included). If it needs more, the explanation belongs in a doc (`ideas/`, README), not the code.

## Running Background Servers

Port **3000** is the externally reachable port for agent-hosted servers. Ports 1111 and 1112 are reserved (WeTTY terminal, image upload). Bind servers to 0.0.0.0:3000.

Always check before starting a server:
  ss -tlnp | grep 3000

Use nohup with a PID file — do not use bare & without nohup.

## Using Playwright

Playwright with Chromium is pre-installed. Due to cap_drop:ALL, always launch with:
  --no-sandbox --disable-setuid-sandbox

## Web Search

The built-in `WebSearch` and `WebFetch` tools are disabled. `curl` and `wget` work fine for fetching a known URL directly. For search queries (no URL), use the `searxng_web_search` MCP tool — search engines block automated curl requests, so curl will return nothing useful on search pages. `web_url_read` is also available to fetch and convert a URL to markdown.

## Image Analysis

**Enforcement of the ABSOLUTE LAW above — the sub-agent path is the ONLY path.** Why it is
absolute: brain-context-window != vision-context-window. The vision model has a hard **131k-token
context** (brain: ~1M), and every image request carries the WHOLE current conversation to it.
A grown session plus a single image overflows 131k and **hard-deadlocks the session**: even
`/compact` fails, because compaction is itself a model call that no longer fits.

- **NEVER** invoke the Read tool on an image file (png, jpg, jpeg, gif, webp) in the main
  conversation — no exceptions, regardless of session size or image count.
- **ALWAYS** spawn the `image-analyst` sub-agent (Task tool) for any image work: single
  screenshot, visual QA, batch analysis — all of it. Its fresh context holds only the image and
  the question; it returns a short text summary and the pixels never enter the main conversation.
- **Inside the sub-agent**, use the Read tool directly on the image path — Claude Code encodes
  it as a real image block, the only mechanism that delivers pixels. Never hand-base64 a file
  into a prompt; the model cannot see base64 text.
- Before spawning, tell the sub-agent exactly what to look for, so one round trip suffices.

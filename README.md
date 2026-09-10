# docker-agentic-harness-sandbox

Run agentic coding tools (Claude Code, OpenCode, OMP) against a self-hosted OpenAI-compatible model, with no cloud API keys.

This is a monorepo with three independent pieces. Run any combination, on the same machine or different ones:

- **[`server/`](server/)** — the inference-facing stack: LiteLLM, a reasoning-stream correctness fix, and a local searXNG for web search. Fronts your vLLM/llama.cpp/SGLang server(s). Reports the real models it actually serves (`GET /v1/models`) — a hand-maintained catalog, not a wildcard placeholder, so it stays honest even across multiple nodes/models.
- **[`sandbox-client/`](sandbox-client/)** — the hardened sandbox container: a browser-based terminal (WeTTY) running Claude Code / OpenCode / OMP. Points at a server's address; runs no inference stack itself.
- **[`native-client/`](native-client/)** — for someone who already runs Claude Code, OpenCode, and/or OMP locally and just wants to point them at a server, no Docker, no sandbox. A one-time bash setup script (installs a tool if missing, backs up existing config) plus a small standalone Node proxy needed only for Claude Code.

None of these assume another lives in the same repo checkout, on the same host, or belongs to the same person. A client (sandboxed or native) picks which of the server's real models is its brain/vision — that choice, and any mixing with a second server, is entirely client-side (see `sandbox-client/README.md` or `native-client/README.md`'s model setup).

## Quick start

```
server/          — cp .env.example .env, ./model-config.sh to set up your models, docker compose up -d
sandbox-client/  — cp .env.example .env, set LITELLM_UPSTREAM + SEARXNG_URL to the server's address, ./start.sh
native-client/   — ./setup.sh (point it at the server, pick your models), then ./start.sh
```

See each directory's own README for details, prerequisites, and troubleshooting.

## Design notes

Design investigations and drafts live in [`ideas/`](ideas/) — shared across all three pieces, since some (the reasoning-stream bug, the model catalog design) touch more than one side of the split.

## Testing

Each piece has its own build-time unit tests (`sandbox-client/tests/`, `server/tests/`). [`tests/integration/`](tests/integration/) holds the whole-chain checks that need both a server and a client running together — see its README for how to point them at a real split instead of one co-located dev setup.

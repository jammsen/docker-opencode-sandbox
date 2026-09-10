# Server — the inference-facing stack

This is the **server** half of `docker-agentic-harness-sandbox` (see [the root README](../README.md); clients live in [`../client/`](../client/) — the sandbox — and [`../native-client/`](../native-client/) — a bare native setup). It fronts your inference backend(s) (vLLM, llama.cpp, SGLang, ...) with LiteLLM + a small correctness fix, plus a local searXNG instance for web search. It **transparently reports the real models it serves** — `config/models.json` is a hand-maintained catalog of your actual hardware, and `GET /v1/models` reflects it honestly, not a wildcard placeholder. It has no concept of roles, aliases, or per-user preference (which model is "brain") — that's entirely the client's job (see `../client/README.md` or `../native-client/README.md`'s model setup). A client just needs your LiteLLM and searXNG addresses, plus the real model ids you report.

## Prerequisites

- Docker + Docker Compose
- One or more inference servers exposing an OpenAI-compatible API, each with a model already loaded and `/v1/models` responding

## Run it

```bash
cp .env.example .env
cp config/models.example.json config/models.json
# edit config/models.json to list your actual server(s)/node(s) and the model(s) each one serves
# — or use ./model-config.sh instead of hand-editing, see below

docker compose run --rm catalog-render   # renders litellm's config from models.json
docker compose up -d
```

### Configuring models with `./model-config.sh`

An interactive editor for `config/models.json`, run directly on this host (not in a container —
you already have the network access to probe your own vLLM/llama.cpp/SGLang boxes directly, unlike
a client stuck behind this server's published port). Same shape as the client's own wizard
(`../sandbox-client/scripts/model-config.sh`) but simpler: no roles, no aliases, nothing per-user — this
server doesn't have those concepts (see header above).

```bash
./model-config.sh
```

**add server** probes `GET <url>/models` directly and looks up the real context window itself —
you only pick which models to keep. **write & exit** validates and writes `config/models.json`,
then offers to render + restart litellm on the spot (and shows you the resulting `GET /v1/models`)
so the change actually takes effect (`reasoning-normalizer` re-reads the file on its own, no
restart needed there). This is the tool for reconfiguring your setup — e.g. going from one big
model to four smaller ones across two nodes — without hand-editing JSON or forgetting a step.

This starts `litellm` (published on `:4000`), `reasoning-normalizer`, `searxng` (published on `:8080`), and `valkey`. Give a client `LITELLM_UPSTREAM=http://<this-host>:4000` and `SEARXNG_URL=http://<this-host>:8080`.

Verify it's reachable, and that it's reporting your real models (not a wildcard):

```bash
curl http://<this-host>:4000/v1/models
```

## What runs here, and why

- **`catalog-render`** turns `config/models.json` into litellm's real `model_list` (`scripts/render-litellm-config.sh`, plain POSIX sh + jq/curl). One entry per real model id you listed, each routed through `reasoning-normalizer`. It's a one-shot, not a long-running service — run it with `docker compose run --rm catalog-render` (what `model-config.sh` does for you) whenever `config/models.json` changes, then restart litellm. It's deliberately not in litellm's `depends_on` and sits behind the `render` compose profile so a plain `docker compose up -d` never starts it: Compose's `up` has no `--rm`-for-services equivalent, so a service started that way would just sit there `Exited` forever in `docker ps -a` — `run --rm` is the actual mechanism for one-shot-and-gone.
- **`litellm`** translates Anthropic↔OpenAI and forwards each named model to `reasoning-normalizer`. Its config (`config/litellm-config.yaml`) is generated, not hand-edited — re-run `catalog-render` and restart litellm after editing `config/models.json` to regenerate it.
- **`reasoning-normalizer`** (`scripts/reasoning-normalizer.js`) does two jobs. (1) Fixes a real bug: some models (DeepSeek V4 Flash is the known case) stream the last "thinking" token and the first answer token in a single delta with no boundary between them. LiteLLM then misfiles that thinking token into a text block and Claude Code aborts the turn with *"Content block is not a thinking block"*. The normalizer splits any such fused delta into two; it's a no-op for models that don't do this. See [`../ideas/deepseek-thinking-block-bug.md`](../ideas/deepseek-thinking-block-bug.md) for the full investigation — as of Sept 2026 this is still not fixed upstream in either LiteLLM or Bifrost for every code path, so this stays load-bearing. (2) Routes each real model id to the right server/node per `config/models.json` — this is what lets one server genuinely front several models across several boxes (e.g. three models on a two-node cluster) through a single LiteLLM endpoint, with no restart needed when you edit the catalog.
- **What this server does NOT do**: aliases, roles ("brain"/"vision"), or anything per-user. A request must already name a real model id this server reports — an unresolvable one 404s, loudly, on purpose. That resolution (a client's personal choice of which real model is their "brain") happens client-side; see `../client/scripts/claude-shim.js` or `../native-client/claude-shim.js`.
- **`searxng`** + **`valkey`** — a local web-search backend for a client's tools (OMP's built-in search, `mcp-searxng`). Valkey is searXNG's own cache, nothing else uses it.
- **`headroom`** (optional, `profiles: ["headroom"]`) — a context-compression sidecar on the brain path. Off by default; see [`../ideas/headroom-spike-results.md`](../ideas/headroom-spike-results.md) before enabling it.

## Multiple clients, one server

Nothing here is per-client. Point as many clients as you want at the same `litellm:4000` / `searxng:8080` — there's no auth beyond whatever network-level access control you put in front of this stack (a firewall, Tailscale/Twingate ACLs, ...). Contention is first-come; there's no queue or quota machinery here on purpose.

> **Superseded (2026-08-18)** by the model catalog + wizard — `ideas/done/model-catalog.md`.
> The `MODEL_*` env contract described below no longer exists; models live in `config/models/models.yml`.

# Feature: Dynamic model configuration from compose.yml (feat/dynamic-models)

## Problem

The model was hardcoded in five places (`qwen3.6-35b` in
`config/litellm-config.yaml`, `config/omp/models.yml`, `config/omp/config.yml`,
`config/opencode/opencode.json`, plus a fallback in `scripts/analyze-image.js`),
and two of those configs also hardcoded the server IP — so the documented
"just set VLLM_URL" promise only covered claude/litellm, while opencode and OMP
kept talking to `10.0.0.13` no matter what.

Second problem: the new primary candidate (DeepSeek V4 Flash on the 2x DGX
Spark cluster) is **text-only** — `DeepseekV4ForCausalLM`, no vision keys in
its config. Pointing the sandbox at it breaks the whole image pipeline
(upload page → analyze, Claude Read-tool screenshots): LiteLLM would keep
claiming `supports_vision: true` and the model would hallucinate over pixels.

## What was built

One env contract in `compose.yml` (`x-model-env` anchor, values from `.env`),
consumed by everything:

```
MODEL_URL / MODEL_ID / MODEL_NAME / MODEL_CONTEXT / MODEL_MAX_TOKENS  = the brain
MODEL_VISION=true|false                                               = can the brain see?
VISION_MODEL_URL / _ID / _NAME / _CONTEXT / _MAX_TOKENS               = the eyes (default: same as brain)
```

- **Templating:** `config/{opencode,omp}` configs and `litellm-config.yaml`
  became templates. The sandbox entrypoint renders the tool configs with
  `envsubst` (explicit var list, so `"$schema"` etc. survive; needs
  `gettext-base`, added to the Dockerfile). The stock litellm image can't
  env-expand model names, so a small `sh -c` wrapper in compose seds
  `__PLACEHOLDER__` tokens before exec'ing litellm.
- **Vision fallback routing:** `claude-shim.js` (which already parses every
  request body to hoist tool_result images) got a second job: when
  `MODEL_VISION=false` and the request's **newest** message carries an image,
  rewrite `body.model` to the `vision` entry litellm now serves. Images that
  only sit in older turns don't pin the conversation to vision: the chosen
  model survives and the stale image blocks are replaced with text
  placeholders (the vision model's textual analysis is already in the
  history). Text requests never touch it, an explicit `/model vision` choice
  is respected (and never stripped), and single-model setups
  (vision == primary) behave exactly as before.
- **`analyze-image.js`** always targets the vision model — it is an explicit
  vision call by definition.
- **Both models appear in the opencode/OMP pickers** (`vllm/...` and
  `vision/...` providers), so manual switching stays possible everywhere.
- Legacy `VLLM_URL`/`VLLM_MODEL` were dropped (2026-07-14) — `MODEL_*` is the
  only interface. Defaults changed the same day: DeepSeek V4 Flash brain +
  qwen3.6 vision is the standard; concrete model defaults live only in
  compose.yml's x-model-env (entrypoint just validates/derives).
- Tests: `tests/test-claude-shim.js` (stub upstream, 16 checks covering
  hoist + routing + class-slot + no-reroute cases; runs at image build).

Historical note: `harness-proxy/` (a Rust litellm+shim replacement) was removed on the
`feat/bifrost-replacement-test` branch after evaluation — it never triggered reasoning upstream,
so it produced no thinking blocks. The code remains in git history. See
`ideas/done/deepseek-thinking-block-bug.md` for why it was dropped and what replaced the gateway fix
(the `reasoning-normalizer` service).

## What's on the branch, file by file

| Area | Change |
|---|---|
| `compose.yml` | `x-model-env` anchor: `MODEL_URL/ID/NAME/CONTEXT/MAX_TOKENS/VISION` + `VISION_MODEL_*`, shared by `sandbox` and `litellm`; litellm gets a sh-wrapper that renders its config template at start; opencode/OMP configs now mount as templates |
| `.env.example` (new) | All variables documented, incl. a ready-made DeepSeek-brain + qwen-eyes example; `.env` gitignored |
| `config/litellm-config.yaml` | Template: `brain` → primary (canonical role name, with real `supports_vision`), Claude aliases kept as compat net → primary, new `vision` entry → vision model |
| `config/opencode/opencode.json`, `config/omp/*` | Templates: dual providers (`vllm` + `vision`), model/context/URL all from env |
| `scripts/entrypoint.sh` | Env defaulting (vision falls back to primary) + `envsubst` rendering with an explicit var list (`"$schema"` survives) |
| `scripts/claude-shim.js` | The routing: `MODEL_VISION=false` + request contains image → rewrite to `vision`; manual choices respected |
| `scripts/analyze-image.js` | Always uses the vision model |
| `tests/test-claude-shim.js` (new) | 16-check test of hoisting + routing against a stub upstream, run at image build |
| `Dockerfile` | +`gettext-base` (envsubst) |
| `README.md` | "Configuring your models" section rewritten around `.env`, dual-model docs, stale hand-edit instructions removed |
| `ideas/archive/dynamic-models.md` (new) | this document |

Validated before review: `docker compose config` passes with defaults and
with dual-model overrides; templates render to valid JSON/YAML for both the
single-model default (byte-equivalent to the old behavior) and the
DeepSeek+qwen case; all 7 shim tests pass; bash/node syntax checks clean.

## Why a `.env.example` when compose.yml already holds all the values?

The two files answer different questions, on purpose:

- **`compose.yml` owns the defaults and the wiring.** Every variable appears
  there as `${MODEL_ID:-qwen3.6-35b}` etc., so the file stays the single
  source of truth: it defines which variables exist, what their fallback is,
  and which services consume them (via the `x-model-env` anchor). A bare
  `docker compose up` with no `.env` at all reproduces the classic qwen
  setup — nothing is required.
- **`.env` owns the per-user values.** Docker Compose automatically loads a
  `.env` file next to compose.yml and uses it for `${...}` interpolation.
  That gives users a place to say "my server, my model" **without editing a
  tracked file** — editing compose.yml directly would make every
  `git pull` a conflict and every `git diff` noisy, and people would
  accidentally commit their LAN IPs.
- **`.env.example` is the documentation for that override surface.** `.env`
  itself is gitignored (it's personal), so the example file is the tracked,
  copy-paste-able catalog of every knob: all `MODEL_*`/`VISION_MODEL_*` vars
  with comments, plus a ready-made DeepSeek-brain + qwen-eyes block. New
  users run `cp .env.example .env`, edit two lines, done.

So there is no duplication of *data*: compose.yml carries the defaults
(what happens when you say nothing), `.env.example` carries the same
variable names as a template for overrides (what you *can* say), and the
values only ever live in one place per deployment — the user's untracked
`.env`. Changing models is then a config action (`edit .env` +
`docker compose up -d`, configs re-render at container start), not a code
change, which is exactly the standard twelve-factor / Compose convention.

## Why 2 models and not N (the "what about 6 models?" question)

The env contract is deliberately **two roles, not a model registry**:

- The sandbox's automation only has two jobs to route: "answer requests"
  (brain) and "handle images" (eyes). A model without a role is a dead picker
  entry — nothing would ever select it automatically.
- `envsubst`/`sed` templating is flat: it cannot loop, so the templates can
  only stamp out a fixed number of provider blocks.

Important nuance on where the limit actually sits: **opencode and OMP support
N models natively** — their configs take arbitrary provider/model lists and
their pickers show everything listed. The 2-slot ceiling comes from the
templating mechanism and from **Claude Code**, which only speaks fixed
Anthropic aliases: every extra model needs a litellm `model_list` entry, and
reaching it means `/model <custom-name>` (works, but no alias, no automatic
routing — and the built-in subagents stay pinned to the haiku alias either way).

What a 6-model user can do today:

1. Swap the pair in `.env` and `docker compose up -d` (~10 s, configs
   re-render at container start). Keep one `.env` variant per pairing.
2. Hand-add providers 3..6 next to the placeholders in the templates —
   opencode/OMP list them happily, litellm serves them, they're just not
   env-driven and never auto-selected.

## Possible v2: N models from env

Replace `envsubst` with a small generator (loop over `MODEL_1_*..MODEL_N_*`
or one `MODELS_JSON`) that emits provider blocks for opencode + OMP and
`model_list` entries for litellm. The current contract survives as slots 1
and 2, so nothing gets thrown away. The open design question isn't listing —
it's routing: beyond brain/eyes, additional roles (cheap-summarizer?
long-context?) need semantics before automation can use them. Until someone
has that need, two roles keep the UX predictable.

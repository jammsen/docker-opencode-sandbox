# Idea: model catalog + configurator (pick brain / vision like we pick the tool)

Status: IMPLEMENTED on `feat/model-catalog` (2026-08-18) — see "As built" right below. Plan v2 and the
older phase-1 sketch further down are kept as the design record.

## As built (2026-08-18)

- `config/models/models.yml` (gitignored) + `models.example.yml`; mounted rw into the sandbox at
  `~/.config/models`, ro into the reasoning-normalizer at `/config/models`.
- `scripts/model-config.sh` → `/usr/local/bin/model-config` (bash + yq in the image; no host deps).
  Menu: add server (probes `GET /v1/models`, multi-select, per-model name/vision — no fuses_reasoning
  question: every model goes through the normalizer, whose split is a no-op when not needed),
  edit/delete server, assign roles, RESET (backup + empty or example), show effective, write & exit
  (validates; edits on a scratch copy). `model-config status` → exit 0/1 for the session menu.
- `scripts/agent-session.sh`: 4th menu entry "model configuration"; unconfigured → red warning,
  tools disabled, wizard default, DEFAULT_TOOL ignored; returns to the menu after the wizard.
- `scripts/render-models.sh` → `/usr/local/bin/render-models`: catalog → `models.json`,
  `~/.config/opencode/opencode.json` (one provider per server), `~/.omp/agent/models.yml`,
  `~/.omp/agent/config.yml`. Runs in the entrypoint (replaces envsubst; `gettext-base` dropped)
  and after every wizard write. Templates stay as skeletons (`provider: {}`, `providers: {}`).
- **Zero-restart gateway**: `config/litellm-config.yaml` is a static wildcard
  (`model_name: "*"` → `hosted_vllm/*` → normalizer); the reasoning-normalizer is now also the
  router (`MODELS_FILE`, re-read on mtime): brain/opus/fable/claude-* → roles.brain,
  vision/sonnet/haiku → roles.vision, `<server>/<id>` explicit, bare id when unique; unknown → 404
  "run the model configuration". Legacy `VLLM_UPSTREAM` mode when no catalog exists.
- `claude-shim.js` and `analyze-image.js` read `models.json` per call (env fallback kept).
- `x-model-env` / `MODEL_*` in compose and `.env.example` removed; `includes/model.sh` only
  warns + exports VISION_* for analyze-image.
- Verified live: alias routing (brain/vision/raw id/server-id/unknown), add server → routed on the
  next request, brain swap → gateway + opencode/omp follow, reset → restored; entrypoint renders;
  session menu configured/unconfigured; unit tests normalizer 7/7, shim all pass.
- Not done (still true caveat, smaller now): headroom's target is fixed to the normalizer (fine —
  every model goes through it); per-session choice = the tools' own pickers.


## Problem

Model config is one flat env contract (`x-model-env` in `compose.yml`, values from `.env`):

```
MODEL_URL / MODEL_ID / MODEL_NAME / MODEL_CONTEXT / MODEL_MAX_TOKENS / MODEL_VISION   = brain
VISION_MODEL_URL / _ID / _NAME / _CONTEXT / _MAX_TOKENS                               = eyes
```

That was the right first step (`ideas/archive/dynamic-models.md`), but it has two practical problems:

1. **The knobs for one model are split across 5-6 loose variables** and nothing ties them
   together. Swapping the Spark today left `MODEL_URL` pointing at the new box while `MODEL_ID`
   still named the old build (`deepseek-v4-flash-dspark` vs served `deepseek-v4-flash-0731`) —
   LiteLLM would 404 every request. The id, context and vision flag *belong to* the URL; the
   env layout lets them drift apart.
2. **Switching models means editing `.env`** by hand, remembering which 5 vars to change, and
   nobody else can see which candidates exist. There is no "menu" of known-good models the way
   there is one for tools (`TOOLS=claude,opencode,omp` → `agent-session.sh` picker in the
   browser, `DEFAULT_TOOL` to skip it).

Goal: a **catalog** of known models in a mounted repo config file, and a **selection** step
that picks one brain and one vision model from it — the same "list + default + picker" shape
the tool menu already has.

## Where the choice can take effect (the constraint that shapes the design)

The brain path is `Claude Code → claude-shim → LiteLLM → [headroom] → reasoning-normalizer → vLLM`.
Three of those are *separate containers* whose upstream is fixed at their own start:

| component | what is fixed at container start | how |
|---|---|---|
| litellm | `model_list` (ids + `api_base`) | `sh -c` wrapper seds `__MODEL_ID__` etc. into `config/litellm-config.yaml`; `api_base` via `os.environ/MODEL_URL` |
| reasoning-normalizer | `VLLM_UPSTREAM` (single host:port) | env |
| headroom (opt-in) | `OPENAI_TARGET_API_URL` (single) | env |
| sandbox | opencode/omp configs (`envsubst` in `includes/config.sh:render_tool_templates`), claude-shim (`MODEL_VISION`, `MODEL_ID`, `VISION_MODEL_ID` read once at start) | entrypoint |

So a picker that runs *inside a browser session* can only change per-session things
(Claude Code's `ANTHROPIC_DEFAULT_*_MODEL`, which litellm alias to hit) — it cannot repoint
litellm/normalizer/headroom. That splits the idea into two phases; phase 1 is the one worth
doing now.


## Plan v2 — the wizard (2026-08-18, from the user's requirements) — REVIEW BEFORE BUILD

Requirements (verbatim intent): reset the entire config · add a server · look up its models ·
select model(s) and save · assign brain / vision · several servers, cherry-picking one model out
of five on one box, one on another · a third server with a "haiku-like" model that has NO role but
is known to the config, so it can be switched to for the next session / screen / shell.

### Data model — `config/models.yml` (single source of truth, mounted `:ro` into the containers)

```yaml
servers:                         # only what the wizard saved; NOT everything the server serves
  spark-brain:
    url: http://10.0.0.25:8888/v1
    models:
      deepseek-v4-flash-0731:
        name: "DeepSeek V4 Flash 0731"   # display name in tool pickers
        context: 1000000                 # max_model_len from GET /v1/models
        max_tokens: 16384
        vision: false
        fuses_reasoning: true            # route through the reasoning-normalizer
  spark-vision:
    url: http://10.0.0.13:8000/v1
    models:
      qwen3.6-35b: {name: "Qwen3.6 35B A3B", context: 131072, max_tokens: 16384, vision: true}
  box3:
    url: http://10.0.0.40:8000/v1
    models:
      qwen3.6-9b: {name: "Qwen3.6 9B (haiku-ish)", context: 65536, max_tokens: 8192, vision: false}
roles:                           # exactly one each; vision may equal brain
  brain:  spark-brain/deepseek-v4-flash-0731
  vision: spark-vision/qwen3.6-35b
```

Model key = the exact served id. Alias exposed to the tools = the id; if two servers serve the
same id, the alias becomes `server/id` (wizard warns).

### Wizard — `scripts/model-config.sh` (host wrapper) → runs the wizard INSIDE docker

No host dependencies beyond docker (repo rule). The wrapper does
`docker compose run --rm --no-deps -v ./config:/config:rw model-config`, a tiny profile-gated
service on the sandbox image (python 3.13 already there; add `pyyaml`). The wizard itself is
python stdlib + yaml, numbered menus like `agent-session.sh`, colors via the same palette:

```
Model configuration  (config/models.yml)

Servers
  1) spark-brain   http://10.0.0.25:8888/v1   1 model   [brain]
  2) spark-vision  http://10.0.0.13:8000/v1   1 model   [vision]
  3) box3          http://10.0.0.40:8000/v1   1 model

Roles
  brain  = spark-brain/deepseek-v4-flash-0731
  vision = spark-vision/qwen3.6-35b

  a) add server        e) edit server (rescan / add-remove models / rename)   d) delete server
  r) assign roles      s) show effective config (what the tools will see)
  R) RESET config      w) write & exit                                        q) quit w/o saving
```

Flows:
- **add server**: name → URL → `GET url/models` (10s timeout; on failure: keep URL, retry, or add
  models by hand) → list `id  max_model_len` → multi-select (`1,3` or `all`) → per model: display
  name [default id], vision? [y/N — /v1/models doesn't tell us], fuses_reasoning? [default y if id
  contains "deepseek", else n], max_tokens [16384] → back to main.
- **assign roles**: numbered list of ALL known models across servers; pick brain, then vision
  (default = a vision-capable one if exactly one exists; may equal brain).
- **reset**: confirm → `models.yml` → `models.yml.bak-<ts>` → empty skeleton (`servers: {}`,
  `roles: {}`); wizard refuses to write with a missing role, so reset is always followed by add.
- **write**: validates (roles exist, every model has context/max_tokens, aliases unique), writes
  `config/models.yml` AND `.env.models` (see below), prints "next: `docker compose up -d`".

### How the catalog reaches the stack (this is where the "known but unassigned" requirement lands)

| consumer | what it needs | how it gets it |
|---|---|---|
| compose interpolation (`x-model-env` → normalizer `VLLM_UPSTREAM`, headroom target, litellm `os.environ/`) | brain + vision URL/ID/… at `compose up` | **`.env.models`** (generated, gitignored) loaded via `env_file:`; contains exactly today's `MODEL_*`/`VISION_MODEL_*` contract |
| litellm `model_list` | ALL known models as aliases + role aliases (`brain`, `vision`, `opus`, `sonnet`, `haiku`, compat ids) | `scripts/render-models.py` (in litellm's `sh -c` wrapper — the image has python+pyyaml) renders the full config from `/config/models.yml`; brain via normalizer, every other model direct to its server |
| opencode `opencode.json`, omp `models.yml`/`config.yml` | one provider per server, all its models; default = brain | same renderer in the sandbox entrypoint (replaces the `envsubst` templates for these two files) |
| Claude Code | `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` | opus→brain, sonnet→vision, haiku→ the model marked `haiku`?? — no: keep haiku→vision as today; `/model <alias>` reaches ANY known model because litellm serves them all |
| claude-shim | `MODEL_VISION`, `MODEL_ID`, `VISION_MODEL_ID` | unchanged (from `.env.models`); the text-only-brain image reroute keeps working |
| `includes/model.sh` guards | `MODEL_*` set | unchanged — the safety net if `.env.models` is missing |

**Per-session switching** = the tools' own pickers (Claude Code `/model`, opencode model list, omp
`models.yml`) now list the whole catalog. No new session menu needed for v1; the role assignment
is only the *default*. Two sessions can use different models at the same time (litellm serves all).

Caveat kept honest: only the **brain** goes through reasoning-normalizer + headroom (their upstream
is fixed at container start). A non-brain model with `fuses_reasoning: true` (e.g. a second
deepseek on box3) would hit the both-field-chunk bug when selected ad hoc — the wizard warns at
save time. Fixing that = teach `reasoning-normalizer.js` a `/u/<host:port>/v1/...` path prefix so
litellm can send any fusing model through it (small, our own code) — listed as step 7, do it if
the warning ever fires for real.

### Steps (each testable on its own)

1. `config/models.yml` (seeded with today's two Sparks) + `.gitignore` `.env.models`
2. `scripts/render-models.py` — `--env` (prints the `MODEL_*` contract), `--litellm`, `--opencode`,
   `--omp-models`, `--omp-config`; unit test with a 3-server fixture (`tests/test-render-models.sh`)
3. wire it: compose `env_file`, litellm wrapper, sandbox entrypoint (`render_tool_templates`),
   Dockerfile `pyyaml`; drop hardcoded fallbacks from `x-model-env` (render fails loudly instead)
4. `scripts/model-config.py` (wizard) + `scripts/model-config.sh` (wrapper) + compose service
   `model-config` (profile `config`)
5. `.env.example` model block → pointer to the wizard; README section; `ideas/archive/dynamic-models.md`
   "superseded" note
6. live test: 3 servers configured (2 real + 1 fake) → `compose up` → litellm `/v1/models` lists
   all aliases, `brain`/`vision` resolve, opencode+omp pickers show all, Claude `/model qwen3.6-9b`
   works, existing thinking/vision gates green
7. (only if needed) normalizer path-prefix routing for non-brain fusing models

Out of scope v1: web UI, auto-detecting `vision`/`fuses_reasoning` from the server, a session-start
"pick brain" menu (the tools' pickers cover it), per-session headroom.

## Phase 1 — catalog + compose-time selection (the deliverable)

### `config/models.yml` (mounted `:ro`, replaces the model vars in `.env`)

```yaml
# Known-good models. One entry = everything the stack needs to know about one served model.
# id must be the exact id from GET <url>/models; context = max_model_len from the same call.
models:
  deepseek-v4-flash-0731:
    url: http://10.0.0.25:8888/v1
    id: deepseek-v4-flash-0731
    name: "DeepSeek V4 Flash 0731"
    context: 1000000
    max_tokens: 16384
    vision: false
    fuses_reasoning: true      # both-field deltas -> needs the reasoning-normalizer (see deepseek-thinking-block-bug.md)
  qwen3.6-35b:
    url: http://10.0.0.13:8000/v1
    id: qwen3.6-35b
    name: "Qwen3.6 35B A3B"
    context: 120000
    max_tokens: 16384
    vision: true

# Roles. Selection = one key per role; `vision` may equal `brain` (single-model setup).
default:
  brain: deepseek-v4-flash-0731
  vision: qwen3.6-35b
```

`.env` keeps only overrides: `BRAIN=qwen3.6-35b` / `VISION=...` (empty = `default:` from the
file). Everything below the selection stays exactly as it is — the catalog is *rendered into
the existing `MODEL_*` / `VISION_MODEL_*` contract*, so litellm template, opencode/omp templates,
claude-shim, normalizer, headroom, README's "one env contract" story all keep working unchanged.

### Render step: one small script, one place

`scripts/render-model-env.sh` (host side, POSIX sh + `yq` **or** pure python — no new runtime
in the image; the sandbox already ships python 3.13, the host may not have `yq`):

- input: `config/models.yml` + `BRAIN`/`VISION` env
- output: the `MODEL_*` / `VISION_MODEL_*` lines → written to `.env.models` (generated,
  gitignored) which compose loads via `env_file:` — or exported into the shell for
  `docker compose up`
- validation: unknown key → error listing available keys (same "not available. Available: …"
  UX as `DEFAULT_TOOL` in `agent-session.sh`); optional `--probe` does `GET url/models` and
  fails loudly if `id` isn't served (would have caught the Spark-swap drift immediately).

Rendering *outside* the containers is deliberate: `x-model-env` values are needed by **four**
services (sandbox, litellm, normalizer, headroom) at compose evaluation time, so the expansion
has to happen before/at `compose up`, not in one container's entrypoint. Keep the existing
per-service rendering as-is; only the *source* of the values moves from hand-edited `.env` to
catalog+selection.

Alternative considered: a tiny `model-config` init service that renders and the others
`depends_on` it — rejected, compose interpolation of `${MODEL_URL}` in `x-model-env` happens
before any container runs, so a runtime service can't feed it. `env_file: .env.models` is the
compose-native answer.

### UX

```
BRAIN=qwen3.6-35b docker compose up -d           # pick from catalog for this deployment
docker compose up -d                              # defaults from config/models.yml
scripts/render-model-env.sh --list                # print catalog: key, name, url, vision, context
scripts/render-model-env.sh --probe               # verify every catalog entry is actually served
```

Also fixes an existing footgun: `x-model-env` in `compose.yml` currently carries hardcoded
fallbacks (`10.0.0.25`, `deepseek-v4-flash-dspark`) that silently apply when `.env` is missing.
With the catalog those defaults live in ONE reviewed file with names attached.

### Touch list (phase 1)

- `config/models.yml` (new), `scripts/render-model-env.sh` (new), `.gitignore` (+`.env.models`)
- `compose.yml`: `env_file: [.env, .env.models]` (or keep `x-model-env` but drop hardcoded
  fallbacks and let render fail loudly), comment header pointing to the catalog
- `.env.example`: model block → `BRAIN=` / `VISION=` two-liner
- `README.md` "model configuration" section, `ideas/archive/dynamic-models.md` "superseded by" note
- `includes/model.sh:setup_model_env` unchanged (its `:?` guards become the safety net)
- optional: `tests/test-render-model-env.sh` (unknown key, defaults, vision==brain, probe)

## Phase 2 — per-session picker (follow-up issue, only if we actually switch brains mid-day)

Prereqs, each a real change:

1. litellm serves **every** catalog entry as an alias (`model_list` generated from
   `models.yml`, not the fixed 9-entry template) — then `brain`/`vision`/`opus`/`sonnet` become
   *pointers* the session can move.
2. reasoning-normalizer routes per request instead of one `VLLM_UPSTREAM` — e.g. litellm
   `api_base: http://normalizer:4002/u/10.0.0.25:8888/v1`, normalizer parses the target out of
   the path (its splitter is upstream-agnostic already). Same for headroom's target, or accept
   that headroom is brain-only.
3. `agent-session.sh` grows a "brain / eyes" menu next to the tool menu, sets
   `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` per session. **Caveat:** opencode/omp configs
   live in the shared `/home/agent`, so two concurrent browser sessions choosing different
   brains would fight — per-session only cleanly works for Claude Code unless those configs
   move to per-session dirs (`XDG_CONFIG_HOME` per tmux session).
4. claude-shim's `VISION_SIDE`/`BRAIN_ID` become per-request (they only exist for logging + the
   text-only-brain image reroute; the reroute needs `vision:` per model from the catalog).

Not started; phase 1 makes all of it possible without redoing anything.

## Non-goals

- No web UI. The "configurator" is a YAML file + a `--list/--probe` script + (phase 2) the
  same numbered terminal menu as the tool picker. Consistent with the palworld-style thin
  manager + `includes/*.sh` shape of the repo.
- No auto-discovery of models from vLLM. `--probe` verifies the catalog; it doesn't invent
  entries (context/max_tokens/vision/fuses_reasoning are curated facts, not discoverable ones).

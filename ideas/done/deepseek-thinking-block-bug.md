# Research: "API Error: Content block is not a thinking block"

Investigated 2026-07-16/17. Everything below was measured against the real vLLM boxes
(`10.0.0.25:8888` deepseek, `10.0.0.13:8000` qwen) with throwaway probe containers on the compose
network. The live stack was never touched.

## Problem

Claude Code errors out mid-turn against the `brain` model (deepseek-v4-flash), killing long agent
runs. Switching to `sonnet` (the qwen vision backend) works instantly. The error:

```
API Error: Content block is not a thinking block
```

The string is **not** in LiteLLM's source — it is client-side validation in Claude Code's Anthropic
SDK, which is why it reads like a Claude Code bug. It is not.

## Root cause (at the wire)

`deepseek-v4-flash-dspark` emits a chunk carrying **both `delta.reasoning` and `delta.content`**:

```
delta order: RRRRRRRRRC!BOTH!
  reasoning: '.'     <- last reasoning token
  content:   '6'     <- first content token   (same delta)
```

It emits **no boundary event** between reasoning and content. Anthropic/OpenAI/Google/Mistral all
send a discrete `thinking_end`; DeepSeek only signals at stream completion, too late — see
[openclaw#95280](https://github.com/openclaw/openclaw/issues/95280). Gateways must *infer* the
boundary.

**qwen3.6-35b emits 0 both-field chunks.** That is the entire reason `sonnet` works and `brain`
does not — the difference is the model, not the slot.

Second model difference, verified against vLLM direct:

- **deepseek reasons only when triggered** (`reasoning_effort` / `chat_template_kwargs`). Without
  it: straight to `"content":"6"`, no reasoning at all.
- **qwen reasons by default**, with no thinking param whatsoever
  (`"reasoning":"Here's a thinking process:…"`).

So `alwaysThinkingEnabled: false` only silences *deepseek's* reasoning; qwen keeps thinking either
way, and LiteLLM keeps surfacing it (correctly).

### Why LiteLLM breaks on it

`_should_start_new_content_block()` derives the block type from the **raw chunk** (sees `content` →
opens a **text** block), while the delta is translated **separately** (sees `reasoning` → emits a
**thinking_delta**). On a both-field chunk the two disagree, the thinking delta lands in a text
block, and the SDK aborts. The straggling `thinking_delta '.'` observed on block[2] is literally
that chunk's reasoning field.

### Why Bifrost breaks on it (different bug, same symptom)

`core/schemas/mux.go` opened a **text** item when reasoning arrived, and the reasoning delta
carried **no `ItemID`**. `reverseStreamItemKey` therefore fell back to `"oi:0"`, never matched the
key registered by `output_item.added`, and `blockIndexFor` allocated a **fresh index** — emitting a
`content_block_delta` for a block whose `content_block_start` was never sent. Bifrost's own code
documents the desync ("a stop/delta references a block whose start we never emitted") and then
papers over it with a fresh allocation. Result at the wire: exactly **one** `content_block_start`
(index 0, text), then `thinking_delta` streamed into index 1, which was never opened.

This is **not** deepseek-specific — it breaks on qwen too, and with no thinking param at all.

## Test results

Reproducer: multi-turn + thinking, deterministic expected text, streamed. Three independent checks
— block-type mismatch, unclosed blocks (start without stop), and text integrity (the pre-1.90
first-delta drop).

### deepseek + thinking

| gateway | mismatch | unclosed | text corrupted |
|---|---|---|---|
| LiteLLM v1.89.3 (old pin) | 0/10 | — | **10/10 — silent** |
| LiteLLM v1.92.0, short/adversarial prompt | 6/10 | 0/10 | 5–6/10 |
| LiteLLM v1.92.0, long/realistic prompt | 3/10 | 0/10 | 3/10 |
| **LiteLLM v1.92.0 + normalizer** | **0/20** | — | **0/20** |
| Bifrost latest | 10/10 | — | — |
| Bifrost latest + normalizer | **10/10 — not rescued** | — | 0/10 |
| **Bifrost patched (ours)** | **0/10** | **0/10** | **0/10** |

### qwen + thinking, and other paths

| case | result |
|---|---|
| qwen + thinking (adversarial), LiteLLM | **0/10** |
| qwen, no thinking param, LiteLLM | **0/10** (thinking surfaced, correctly) |
| qwen, any config, Bifrost latest | **10/10 fail** |
| qwen, **Bifrost patched** | **0/10** all three checks |
| deepseek, no thinking param, either gateway | 0/10 |
| tool calls streamed, both gateways | ✅ `{"city":"Paris"}` parses, `stop_reason: tool_use` |
| image in `tool_result` | LiteLLM ❌ (hallucinates about base64) · Bifrost ✅ native `"Red"` |
| shim → LiteLLM → qwen (control) | ✅ `"Red"` |

Notes worth keeping:

- **v1.89.3 corrupted text on every run, silently.** It never errored because the first-delta-drop
  swallowed the malformed delta. The v1.92.0 bump traded invisible corruption for visible errors —
  the right trade, now measured.
- The short/adversarial reproducer roughly **doubles** LiteLLM's failure rate (6/10) vs a long
  realistic prompt (3/10). Real sessions fail less than the synthetic worst case. Bifrost's 10/10
  is unaffected by prompt length — structural, not a race.

## Fix A: normalize the stream (`scripts/reasoning-normalizer.js`)

Pure node stdlib, same pattern as `scripts/claude-shim.js`. Sits between LiteLLM and vLLM and
splits any both-field chunk into two (reasoning-only, then content-only) — making deepseek look
like qwen, which every gateway already handles.

**0/20 on both defects, thinking intact:**

```
block[1] thinking 'We are asked to ...'
block[2] text     'ALPHA BRAVO CHARLIE DELTA ECHO'
```

Strictly better than `alwaysThinkingEnabled: false`: errors stop **and** deepseek keeps reasoning.
Touches no gateway internals, so a LiteLLM upgrade can't break it, and it is gateway-agnostic.
**Not yet wired** into `compose.yml` / `includes/services.sh` — it would run alongside the shim
with `MODEL_URL` pointed at it.

## Fix B: patch Bifrost (`ideas/archive/bifrost-reasoning-item.patch`)

Bifrost **is** patchable — clone, patch, `transports/Dockerfile.local` multistage build (~6 min),
exactly the wetty/harness-proxy pattern. An earlier claim that it "can't be patched because it's a
compiled Go binary" was wrong: that is only true of the *shipped image*.

**This needs no fork.** Same shape as `wetty@3.1.0` in our Dockerfile: a multistage stage clones a
**pinned commit SHA**, applies `ideas/archive/bifrost-reasoning-item.patch` on the fly, builds, and the final
stage copies the binary out. No divergent history, no rebasing, no repo to own — and when
[#5286](https://github.com/maximhq/bifrost/pull/5286) lands upstream you delete the patch file and
bump the SHA. Failure mode is the familiar one: the patch stops applying on a SHA bump, exactly
like the wetty anchor checks, and it fails loudly at build time rather than silently at runtime.

- Base commit `c0909f9` (dev), one file: `core/schemas/mux.go`, +60/-2.
- **Fix:** open a proper reasoning item (`ResponsesMessageTypeReasoning`, which the Anthropic
  surface maps to `AnthropicContentBlockTypeThinking`), give the reasoning delta that item's
  `ItemID`, and close the item at finish so `content_block_start` is paired with a stop.
- Stop reasoning from opening the **text** item (`if hasContent || (hasReasoning && …)` →
  `if hasContent`).

```
before:  START index=0 type=text        (thinking_delta -> index 1, never opened)
after:   START index=0 type=thinking
         START index=1 type=text
```

**⚠️ The patch is GLOBAL, not deepseek-specific.** It sits in the shared chat-completions→responses
mux that every OpenAI-compatible provider uses (vLLM, Ollama, Groq, Cerebras…). Verified it does
not regress: qwen went 10/10 → **0/10**, and Bifrost's full `core/schemas` test suite passes. The
old behaviour was wrong for *everyone*, which matches their reports naming Ollama/Groq/Cerebras.
Only proven on our two models, though. **Worth upstreaming to
[#5286](https://github.com/maximhq/bifrost/pull/5286) regardless of what we adopt.**

Two wrong attempts before it worked, both caught by measurement:
1. Setting `ItemID` to the *text* item's ID — "fixed" the orphan by misdelivering more neatly
   (mismatch stayed).
2. Correct reasoning item, but never closed → **unclosed blocks 10/10**. Needed the
   `OutputItemDone` at finish.

## Does Bifrost retire `claude-shim.js`?

**Half of it.**

- **Retired:** `hoistToolResultImages()` — exists only because LiteLLM drops images nested in
  `tool_result` (OpenAI tool-role messages can't carry them). Bifrost forwards them natively.
- **Stays:** `maybeRewrite()` / `messageHasImage()` (reroute image-bearing requests to the vision
  model when the brain is text-only), `stripImages()` (replace stale images in older turns with
  placeholders), and the per-request routing log line.

Bifrost's routing rules use **CEL expressions** over `request_type`, `budget_used`, `tokens_used`,
virtual-key scope — `request_type` is the *kind of API call*, not "does this message contain an
image block". It cannot introspect message content to pick a model, and does no stale-image
stripping. (From their docs' variable list, not proven at the wire like the rest.)

That second half exists **only because the brain is text-only**. If deepseek were vision-capable —
or qwen did all image work — the shim retires completely. So Bifrost would *shrink* the shim, not
remove it: same process count either way.

## Options, ranked (1 = recommended)

| # | option | thinking works | cost |
|---|---|---|---|
| **1** | **LiteLLM + normalizer** ⭐ | ✅ **0/20** | 114-line node proxy; no gateway internals; gateway-agnostic |
| **2** | **Patched Bifrost** | ✅ **0/10** both models | pinned-SHA clone + patch in a multistage build (~6 min); gains native `tool_result` images |
| 3 | Patch LiteLLM's python directly | untested | spans 2 disagreeing functions — no clean anchor; strictly worse than 1 |
| 4 | `alwaysThinkingEnabled: false` | ❌ deepseek loses reasoning | one line; qwen unaffected (reasons anyway) |
| 5 | LiteLLM alone (status quo) | ❌ 3–6/10 | zero work; kills long runs at random |
| 6 | Finish harness-proxy | ❌ | most work of any option; author declined to maintain |
| 7 | Bifrost unpatched | ❌ 10/10 every config | not rescued by the normalizer |
| 8 | harness-proxy as-is | ❌ no thinking at all | = option 4 but with a service to run |
| 9 | Revert to v1.89.3 | ❌ | **10/10 silent text corruption** — never do this |

**Why 1 over 2:** no build in the loop, nothing to re-anchor on a SHA bump, and it keeps working if
you later adopt Bifrost anyway — the two are not exclusive, 1 just stops being load-bearing.

**Would 2 become 1 if [#5286](https://github.com/maximhq/bifrost/pull/5286) lands upstream?**
Probably — a fixed Bifrost needs **no normalizer** (our patched build scored 0/10 pointed straight
at raw vLLM), so the path shrinks from 3 pieces (shim + litellm + normalizer) to 2 (half-shim +
bifrost). Conditions before believing it:

1. **Re-run this exact matrix against the released build.** Their fix may differ from ours — our
   own first two attempts "fixed" the orphan while still being wrong (one misdelivered more
   neatly, one left blocks unclosed 10/10). A fix landing is not evidence the fix is correct.
2. **Migration is unmeasured work:** config rewrite, `ANTHROPIC_DEFAULT_*_MODEL` → `provider/model`
   strings, and surgery on `claude-shim.js` to drop the image-hoisting half without breaking the
   vision-routing half.
3. **Bifrost's reasoning path is actively unstable** — 14 reasoning/thinking streaming issues in
   three days. One fix landing makes *that* bug safe, not the area.

Even fixed, it does **not** retire the shim (see the shim section) — 2 processes vs 3, not 2 vs 1.
Don't *wait* for the fix: that means running 3–6/10 failures for a payoff of one fewer container.

**harness-proxy:** its `Translator` design is right (processes `reasoning` before `content` per
chunk, so a both-field chunk closes thinking and opens text in the correct order) — but it **never
sends a reasoning trigger upstream**, so vLLM never reasons and no thinking block is ever produced.
Its clean test score measured nothing. Do not cite it without checking a thinking block was
actually emitted. *(The `harness-proxy/` Rust code was removed from this branch on adopting Option
1; it remains in git history if ever revived.)*

## Decision (2026-07-17) — adopt Option 1, keep Option 2 staged

Going with **Option 1: LiteLLM v1.92.0 + `scripts/reasoning-normalizer.js`.** Rationale, all
measured above:

- Only option that fixes the bug (0/20) **and** keeps deepseek's reasoning.
- Cost is decoupled from either gateway's release cadence — the normalizer touches no gateway file,
  so neither repo's churn can break it.
- Fully reversible with zero wasted work: if it disappoints, **Option 2 (patched Bifrost) is
  staged** — `ideas/archive/bifrost-reasoning-item.patch` already exists and applies cleanly — and the
  normalizer is gateway-agnostic, so under a patched Bifrost it simply stops being load-bearing
  rather than being thrown away.
- A clean transport is a **prerequisite for evaluating the model at all**: a corrupted or aborted
  thinking stream makes model-quality failures and transport failures indistinguishable, so any
  benchmark run over the current stack is uninterpretable.

**Not yet wired:** normalizer into `compose.yml` + `includes/services.sh` (runs between litellm and
vLLM; point `MODEL_URL` at it, matching the `claude-shim.js` supervision pattern). **Escalation
trigger for Option 2:** recurring thinking-path failures after the normalizer is live, or a decision
to retire the image-hoist half of the shim via Bifrost's native `tool_result` handling.

## Project velocity & file churn (2026-07-17 snapshot)

Context for the "which patch's survival is coupled to upstream churn" question. Unauthenticated GitHub API,
single snapshot — rough by construction. PR-merge counts are inflated by automation on both sides
(dependency bots on LiteLLM; plugin version-bump releases on Bifrost), so read those loosely; issue
intake is the cleaner human-activity signal.

Per-day rates across windows:

| metric (per day) | LiteLLM 30d / 90d / 120d | Bifrost 30d / 90d / 120d |
|---|---|---|
| issues opened | 20.0 / 17.0 / 16.7 | 5.3 / 4.9 / 4.8 |
| PRs merged | 32.9 / 26.8 / 25.2 | 18.3 / 18.1 / 17.0 |
| open issues (now) | 1,479 | 299 |
| open PRs (now) | 2,543 | 343 |

Churn of the exact file a patch anchors on, in 30-day slices — the metric that actually predicts
patch-maintenance pain:

| 30-day slice | Bifrost `core/schemas/mux.go` | LiteLLM `…/adapters/streaming_iterator.py` |
|---|---|---|
| 90–120d ago | 1 | 3 |
| 60–90d ago | 2 | 0 |
| 30–60d ago | 4 | 4 |
| 0–30d ago | 2 | 5 |
| **120d total** | **9** | **12** |

Read: both target files change ~once every 8–11 days — neither is a moving target. LiteLLM's
streaming adapter is *heating up* (busiest month in the window), consistent with active work on
this exact area (the [#30014](https://github.com/BerriAI/litellm/issues/30014) fix landed here in
v1.90.0) — so a python patch there is both more likely to break and more likely made redundant by
upstream. Bifrost's mux is *cooling*, so a pinned-SHA patch is more stable to carry but an upstream
fix may land slower. Option 1's normalizer is invariant to both columns.

## Bifrost gotchas (hard-won)

- **SSRF guard**: LAN backends need `network_config.allow_private_network: true`. The Anthropic
  surface hides the cause behind a generic `provider_connection_failed`; the **OpenAI** surface
  shows the real one (`connection to private IP 10.0.0.25 is not allowed`).
- Docker tag `2.1.29` is **not** the gateway image (no entrypoint, no arch) — use `latest`.
- Config lives at `/app/data/config.json`; the mounted volume *is* the app-dir.
- `LOG_LEVEL=debug` is an **env var**, not a flag — the entrypoint builds the `main` invocation
  from `APP_DIR`/`APP_HOST`/`APP_PORT`/`LOG_LEVEL`. Passing a custom command fights the entrypoint.
- Model **aliasing works well**: per-key `aliases` map, case-insensitive. Cross-provider aliasing is
  only a feature request ([#1093](https://github.com/maximhq/bifrost/issues/1093)), so route with
  `provider/model` strings via `ANTHROPIC_DEFAULT_*_MODEL`.
- Anthropic surface is `/anthropic/v1/messages`.

## Open upstream

**LiteLLM:** [#30014](https://github.com/BerriAI/litellm/issues/30014) (first-delta drop — fixed in
v1.90.0, still open), [#29518](https://github.com/BerriAI/litellm/issues/29518) (reasoning_content
→ thinking blocks dropped), [#27439](https://github.com/BerriAI/litellm/issues/27439) (deepseek
`reasoning_effort` stripped), [#26395](https://github.com/BerriAI/litellm/issues/26395) (v4
multi-turn reasoning_content), [#28045](https://github.com/BerriAI/litellm/issues/28045)
(deepseek+LiteLLM+Claude Code thinking).

**Bifrost:** [#2446](https://github.com/maximhq/bifrost/issues/2446) (our exact stack and error
string), [#5286](https://github.com/maximhq/bifrost/pull/5286) (orphan thinking blocks),
[#5169](https://github.com/maximhq/bifrost/issues/5169) (reasoning delta has no
`output_item.added` on the chat-completions fallback).

**DeepSeek:** [openclaw#95280](https://github.com/openclaw/openclaw/issues/95280) (no boundary
event at the reasoning→content transition).

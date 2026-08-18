# Headroom spike results (issue #11) — 2026-07-18

Opt-in context-compression sidecar on the brain path, evaluated live against the real chain
(`Claude Code surface -> LiteLLM -> headroom -> reasoning-normalizer -> vLLM on the Sparks`).
Motivation: decode tok/s on the bandwidth-bound Sparks degrades as context grows; goal is
shrinking bloated tool outputs, not token cost (self-hosted).

## What shipped

- `headroom/Dockerfile` — rules-only build (`headroom-ai[proxy]==0.32.0`, no Kompress ML, no ONNX)
- compose service `headroom` behind profile `headroom`, off by default; enable with
  `COMPOSE_PROFILES=headroom LITELLM_BRAIN_URL=http://agentic-headroom:8787/v1 docker compose up -d`
- `tests/test-headroom-interactions-live.sh` — 3 scenarios x N runs: json-needle (fact in big JSON
  survives compression), code-needle (magic constant in big code blob survives), stream-hygiene
  (delta/block pairing + no injected `headroom_*` tool). Reports input_tokens per run.
- `tests/bench-context-toksec.sh` — TTFT + decode tok/s vs context size through the real chain.

## Config that passed all gates (15/15 interactions, 20/20 thinking-path)

`--no-rate-limit --no-cache --no-ccr --stateless`, `HEADROOM_MODE=token`, **without**
`--intercept-tool-results`. Each flag is load-bearing:

- default rate limits (60 rpm / 100k TPM) would throttle agent traffic immediately
- semantic cache could answer from cache instead of the model
- `--no-ccr`: our clients stream and cannot resolve the injected `headroom_retrieve` tool
- `HEADROOM_MODE=cache` (default) froze every turn -> `transforms=none`, 0 tokens saved, pure overhead
- `--intercept-tool-results` (ast-grep code outliner) elided function bodies for ~8% savings and the
  model lost the code it was reading — code-needle went 0/5. Without it, code passes through and 5/5.

## Measured

| payload | before -> after | needle survived | notes |
|---|---|---|---|
| 300-row JSON tool_result | 10004 -> 4023 (-60%) | yes, 5/5 | SmartCrusher keeps outliers; ~15-20ms steady-state overhead (first request ~6.5s warmup) |
| 3.6k-token code blob | untouched | yes, 5/5 | correct: rules-only has no safe code compressor |
| 2k-23k-token text logs | untouched | n/a | prose is Kompress (ML) territory — not installed |
| 94k-token text logs | 93995 -> **99** (-99.9%) | **yes, 6/6** (text-needle follow-up, 94380 -> 531) | `router:search:0.00` fires deterministically (8/8 across payloads); it is query-AWARE — kept the asked-about error line every time |

Bench (single-stream): decode tok/s roughly flat 45-56 across 3k-94k input; TTFT linear with
input (3.1s @ 3k, 13.2s @ 23.6k, 50.7s @ 94k). The 64k row through headroom showed TTFT 2.2s —
but only because the payload was destroyed (see above), so it is NOT a win to cite.

## Verdict

Plumbing is sound: streams byte-clean through the sidecar (the fragile thinking path stayed
20/20), no tool injection, negligible steady-state latency. But value for OUR workload is narrow:

1. Real win only on big **JSON** tool results (MCP tools, API responses) — 60% with facts intact.
2. Plain-text tool output (Bash, logs — most of our traffic) is untouched in the rules-only build.
3. **Deterministic giant-text behavior, revised by the text-needle follow-up (2026-07-18)**: at
   ~94k tokens of text the `search` route fires every time (8/8) and keeps only query-relevant
   lines (~531 tokens) — retrieval questions answered 6/6 CORRECTLY with TTFT ~0.2s vs ~51s. The
   remaining risk is aggregate tasks ("summarize/count these logs"): faithful stats are impossible
   from 531 tokens and answer quality there was never validated — silent-hallucination risk.

Recommendation: keep the profile opt-in and OFF by default (as shipped). The text-needle result
makes it genuinely attractive for retrieval-heavy big-log sessions; the unvalidated aggregate-task
quality keeps it from default-on. Revisit if/when (a) a session is MCP/JSON-heavy, (b) an
aggregate-needle test validates summary quality, or (c) upstream ships a safe non-ML prose
compressor. `tests/test-headroom-interactions-live.sh SCENARIOS=text-needle` covers the retrieval
case (slow, opt-in).

## 200-run coding-needle eval (2026-07-18, `tests/eval-headroom-coding-needles.sh`)

10 realistic agent payloads x 20 runs, fresh seeded payload+needle every run, baseline-proven
solvable 10/10 first. **Total 174/200 (87%)** — but failures are structural, not random:

| scenario (size) | route | result | note |
|---|---|---|---|
| tsc-build log (69k) | log ~0.00 | **20/20** | 69k -> ~800 tok and still perfect — query-aware keeps the error line |
| api-json (58k) | smart_crusher 0.49 | **20/20** | |
| java-trace (47k) | search ~0.00 | 18/20 | 2 empty-answer misses at ~500 tok kept |
| server-log (133k) | log 0.01-0.15 | 17/20 | 3 empty-answer misses, partial compression |
| pytest / git-log / pip-freeze | noop | 59/60 | uncompressed; the 1 git-log miss is the MODEL's own error floor (7-char hash) |
| rg-results / source-file | search/code_aware 1.00 | **40/40** | routed but kept 100% |
| **k8s-config YAML (74k)** | **config 0.00** | **0/20** | **payload destroyed to ~376 tok every run — needle env var gone, deterministic** |

Takeaways: excluding the config route it is 174/180 (96.7%, vs a nonzero model-own floor); the
`config` compressor deterministically deletes YAML dump content (`kubectl get -o yaml` is a real
agent operation) — this is THE default-on blocker and is now precisely reproducible for an
upstream report. Where compression fires well (build logs) it is spectacular: 85x reduction with
perfect retrieval.

Workaround experiment (2026-07-19, k8s x5 + tsc x2 per variant): both available workarounds fix
correctness by giving up the wins — `--protect-tool-results Bash` passes everything through
byte-identical (k8s 5/5 at 73.5k tok; tsc win gone: 68.6k/37s vs 800/2s), `--lossless` keeps k8s
5/5 but saves only ~4.5% on YAML and 0% on build logs. No config keeps the wins AND avoids the
config-route destruction -> upstream ask: per-route disable + fix the config compressor.

## 2026-08-18 re-check: bump to 0.35.0, REAL root cause of the YAML destruction, 195/200

Upstream (repo moved to `headroomlabs-ai/headroom`, 4 releases since our pin) did NOT fix it —
`transforms/config_compressor.py` is byte-identical 0.32.0 -> 0.35.0 and nobody reported it. 0.33
added the per-route allowlist we asked for (`HEADROOM_COMPRESSORS`, `--compressor`), and it does
NOT help either (tested: still 376 tok). Reason: **the label lied.** Traced live with a second
`headroom proxy` started from python with monkeypatched `ContentRouter` methods (there is no debug
log knob; `POST /v1/compress` returns the transformed messages + `transforms_applied`, so it
reproduces without LiteLLM/vLLM):

```
strategy CONFIG -> chain ['lossless_config', 'kompress']
```

1. YAML -> CONFIG route -> lossless config fold -> **no savings** (63.6k >= 60.4k estimator tokens)
2. CONFIG is "fallback-eligible" -> `_try_ml_compressor()` runs **even with Kompress disabled**
3. Kompress **size gate** (`HEADROOM_KOMPRESS_MAX_TOKENS`, default 50000) fires on >50k-tok
   payloads and reroutes to `LogCompressor` (TextCrusher is opt-in) — meant to bound ONNX time
4. LogCompressor turns the YAML dump into 13 tokens of `---`; accepted, reported as `router:config:0.00`

The gate ignores the allowlist and the strategy — it is a blunt "big payload -> log compressor"
hand-off. With Kompress not installed it is the ONLY thing on that path, so **gate off =
passthrough**. That is the fix, and it works on 0.32.0 too (env var existed): compose now sets
`HEADROOM_KOMPRESS_MAX_TOKENS: "0"`.

### 200-run eval, 0.35.0 + gate off, brain = deepseek-v4-flash-0731 on the new Spark (10.0.0.25)

**195/200** (July: 174/200). k8s-config **20/20** (was 0/20), 73k -> ~70k tok (lossless fold only,
~4.5%; headroom has no safe lossy YAML compressor in the rules-only build). tsc-build 17/20,
pip-freeze 19/20, java-trace 19/20 — all 5 misses are empty-answer runs (thinking-only / tool call
instead of text) with the SAME compressed context as the passing runs -> model floor, not
compression loss. Routes: tsc `log:0.01` (68k -> 528), java-trace `log:0.00` (47k -> 230),
api-json `smart_crusher:0.49`, k8s `config:0.95`, everything else ~1.0.

### The trade-off the gate hides (measured on the same 4 payloads via /v1/compress)

| config | k8s YAML 73k | server-log 132k | tsc / java |
|---|---|---|---|
| 0.35.0 as shipped (gate on) | **91 tok, destroyed** | 231 tok, needle kept | 528 / 230 |
| gate on + `HEADROOM_TEXT_CRUSHER=1` | 14k, kept | 55k, **needle lost** | same |
| **gate off (shipped in compose)** | 70k, kept | 131k, kept, uncompressed (TTFT ~74s) | same |
| gate on, CONFIG route exempt (2-line patch, tested via monkeypatch) | 70k, kept | 231, kept | same |

So the July "spectacular" big-plain-text results (94k text -> 99 tok, server-log `log 0.01-0.15`)
were the SAME LogCompressor gamble that destroyed the YAML — it just happens to work on logs. Gate
off trades that speed for correctness on every non-log >50k payload (YAML, big prose, unparseable
JSON...). The surgical patch keeps the log win but only protects YAML. Decision: gate off by
default (correctness first, no patch to carry); the patch is the option if big-plain-log sessions
matter and upstream stalls. Upstream report to file: (a) the no-savings fallback bypasses
`HEADROOM_COMPRESSORS`, (b) the size gate hands non-log content to LogCompressor, which is
destructive; ask: exempt CONFIG (and ideally everything not LOG/TEXT) from the gate.

Other gates, same day: thinking-path live test 20/20 clean through headroom; the 5 eval misses
re-run x2 with identical inputs -> 9/10 pass (sampling flakiness, not compression). The
interactions gate (`tests/test-headroom-interactions-live.sh`) reports 8/15 FAIL with headroom and
**5/15 FAIL without it** (control): every failure is `thinking=False` with the needle found and the
stream clean — the new `deepseek-v4-flash-0731` build answers trivial questions in ~4 tokens with
no thinking block. Its `has_thinking` assertion was calibrated on the old build; JSON needle still
-60% (10004 -> 4023) with facts intact, code untouched. TODO: scope the thinking assertion to
`stream-hygiene` (where thinking is the subject) or accept `thinking=False` when out_tok is tiny.

Other 0.35 deltas on our path: `HEADROOM_COMPRESSORS` allowlist (unused; typo -> disables all,
#2384), server-log now classifies as `search` instead of `log`, "preserve signed Anthropic thinking
blocks" (#2254, Anthropic surface only — we enter via the OpenAI path), litellm model-resolution
log-spam cache. Nothing that changes the measured behaviour.

## Gotchas for future us

- `docker exec` without `-i` silently drops stdin -> validator files land empty -> tests pass
  vacuously. Both live tests now guard with `[ -s file ]`. (This invalidated all pre-fix "N/N
  clean" results; everything above is post-fix.)
- headroom v0.32.0 ignores `HEADROOM_NO_CCR`/`HEADROOM_STATELESS` as env vars — CLI flags are
  authoritative; verify the startup log after any bump.
- tokenizer cache needs a writable `~/.cache` (tmpfs) or every request re-attempts an HF download.
- LiteLLM reports `input_tokens` only in the final `message_delta` (0 in `message_start`).

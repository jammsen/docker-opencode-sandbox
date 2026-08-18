# Upstream issue draft — headroomlabs-ai/headroom (NOT filed yet, 2026-08-18)

Context and measurements: `ideas/done/headroom-spike-results.md` ("2026-08-18 re-check").
File manually / on request only.

---

**Title:** Kompress size gate routes non-log content (YAML) to LogCompressor → 99.98% data loss, mislabelled as `router:config`

**Version:** headroom-ai 0.35.0 (`[proxy]` extra, no Kompress/ML installed); also reproduced on
0.32.0. Proxy flags: `--no-rate-limit --no-cache --no-ccr --stateless`, `HEADROOM_MODE=token`.

**Repro:** `POST /v1/compress` with a `role: tool` message containing ~240 KB of
`kubectl get deploy -o yaml` output (many `---` documents, ~60k tokens). Result: the tool content
becomes `---\napiVersion: apps/v1\nkind: Deployment\nmetadata:` (13 tokens),
`transforms_applied: ['router:config:0.00']`. Deterministic, 20/20 across seeded payloads.

**Mechanism** (traced by monkeypatching `ContentRouter._apply_strategy_to_content` in a second
proxy instance): strategy `CONFIG` → chain `['lossless_config', 'kompress']`. The lossless config
fold yields no savings, CONFIG is in the fallback-eligible set, so `_try_ml_compressor()` runs even
though Kompress is disabled / not installed. There the size gate (`HEADROOM_KOMPRESS_MAX_TOKENS`,
default 50000) fires and hands the content to `LogCompressor` (TextCrusher off by default), which
collapses the YAML to its "unique" lines. The result is accepted (ratio 0.00) and reported under the
original strategy name, so the transform label points at the wrong compressor.

**Why the existing knobs don't help:** `HEADROOM_COMPRESSORS=…` without `config` (0.33+) does not
prevent it — the fallback path doesn't consult the allowlist and the lossless fold runs regardless
of `enable_config_compressor`. `HEADROOM_TEXT_CRUSHER=1` changes the damage (14k tokens kept for
the YAML, but a 132k plain log then loses its needle).

**Workaround:** `HEADROOM_KOMPRESS_MAX_TOKENS=0` — with no ML compressor installed the gate is the
only thing on that path, so gate-off = passthrough. Cost: large plain logs that *benefited* from
the same hand-off (132k → 231 tokens) are no longer compressed.

**Ask:**
1. the size gate should only reroute to LogCompressor when the *requested* strategy is LOG/TEXT
   (or at least never for CONFIG/CODE/TABULAR);
2. the no-savings fallback should honor `--compressor` / `HEADROOM_COMPRESSORS`;
3. label the applied transform by the compressor that actually produced the output.

Payload generator available on request (`tests/eval-headroom-coding-needles.py`, scenario
`k8s-config`).

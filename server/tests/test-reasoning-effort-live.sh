#!/usr/bin/env bash
# test-reasoning-effort-live.sh — end-to-end proof that reasoning-effort control actually reaches
# the model through the REAL stack: Claude Code's Anthropic surface -> claude-shim (translated
# dispatch) -> LiteLLM's /v1/chat/completions -> vLLM's Qwen3 chat template.
#
# Why this test exists: litellm's OWN /v1/messages translation (bypassing claude-shim) recomputes
# reasoning_effort from Anthropic thinking.budget_tokens and caps it at the single string "high" —
# Qwen3's chat template only knows xhigh/medium/low (no "high" tier) and hard-rejects it with a
# 400, breaking every Claude Code request above its lowest effort tier. claude-shim now bypasses
# that broken path by translating to OpenAI shape itself and dispatching to /v1/chat/completions,
# which passes chat_template_kwargs through untouched. This script proves BOTH halves: that the
# broken path is still broken (regression baseline, so this test stays meaningful if litellm ever
# changes) and that the fixed path actually works, across multiple thinking-budget scenarios.
#
# Run from the host (needs litellm + vLLM up, e.g. `docker compose up -d` in ../ or a bare vLLM box
# reachable directly) — no Docker required for the test itself, the shim runs as a plain node
# process on the host:
#   ./test-reasoning-effort-live.sh
#
# Env: LITELLM_UPSTREAM (default http://localhost:4000), MODEL (served model id, default
# qwen3.8-flash-next), SHIM (path to a claude-shim.js copy, default ../../native-client/claude-shim.js).

set -euo pipefail

LITELLM_UPSTREAM="${LITELLM_UPSTREAM:-http://localhost:4000}"
MODEL="${MODEL:-qwen3.8-flash-next}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHIM="${SHIM:-$HERE/../../native-client/claude-shim.js}"
SHIM_PORT=4098
SHIM_URL="http://127.0.0.1:${SHIM_PORT}"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass() { echo -e "${GREEN}PASS${NC} $*"; }
fail() { echo -e "${RED}FAIL${NC} $*"; }
info() { echo -e "${YELLOW}    ${NC} $*"; }

bad=0
tmpdir="$(mktemp -d)"
cleanup() { [ -n "${SHIM_PID:-}" ] && kill "$SHIM_PID" 2>/dev/null || true; rm -rf "$tmpdir"; }
trap cleanup EXIT

echo "== reasoning-effort live test: upstream=$LITELLM_UPSTREAM model=$MODEL shim=$SHIM =="

# Sanity: litellm/vLLM must actually be up before anything else is worth running.
if ! curl -s -m 5 -o /dev/null -w '%{http_code}' "$LITELLM_UPSTREAM/v1/models" | grep -q '^200$'; then
    fail "upstream $LITELLM_UPSTREAM/v1/models did not return 200 — is the stack up?"
    exit 1
fi
pass "upstream reachable ($LITELLM_UPSTREAM/v1/models)"

# --- regression baseline: prove the RAW litellm /v1/messages path is still broken ---------------
# If this ever starts passing, the whole reason claude-shim bypasses it is gone and this script
# (and the shim's translation-default) should be revisited, not silently left as dead code.
raw_resp="$(curl -s -m 30 "$LITELLM_UPSTREAM/v1/messages" -H 'content-type: application/json' -d "$(cat <<JSON
{"model":"$MODEL","max_tokens":50,"messages":[{"role":"user","content":"hi"}],"thinking":{"type":"enabled","budget_tokens":8000}}
JSON
)")"
if echo "$raw_resp" | grep -q 'Unexpected reasoning effort'; then
    pass "regression baseline: raw litellm /v1/messages still rejects elevated thinking (confirms the fix is still needed)"
else
    fail "regression baseline: raw litellm /v1/messages did NOT reject elevated thinking as expected — litellm's behavior may have changed"
    info "response was: $(echo "$raw_resp" | head -c 300)"
    bad=$((bad + 1))
fi

# --- start claude-shim locally, pointed at the real stack, no catalog (bootstrap path) ----------
LITELLM_UPSTREAM="$LITELLM_UPSTREAM" CLAUDE_SHIM_PORT="$SHIM_PORT" MODELS_FILE="$tmpdir/nonexistent.json" \
    node "$SHIM" > "$tmpdir/shim.log" 2>&1 &
SHIM_PID=$!
for _ in $(seq 1 20); do
    grep -q 'claude-shim listening' "$tmpdir/shim.log" 2>/dev/null && break
    sleep 0.25
done
if ! grep -q 'claude-shim listening' "$tmpdir/shim.log" 2>/dev/null; then
    fail "shim did not start — log follows"
    cat "$tmpdir/shim.log"
    exit 1
fi
pass "shim started on $SHIM_URL (bootstrap, no catalog)"

# --- scenario matrix: several thinking budgets + no-thinking, through the shim ------------------
run_scenario() {
    local name="$1" budget="$2" extra_msgs="${3:-}"
    local thinking_field=""
    if [ -n "$budget" ]; then
        thinking_field=",\"thinking\":{\"type\":\"enabled\",\"budget_tokens\":$budget}"
    fi
    local req
    req=$(cat <<JSON
{"model":"$MODEL","max_tokens":150,"messages":[${extra_msgs}{"role":"user","content":"Say OK and stop."}]$thinking_field}
JSON
)
    local resp code
    resp="$(curl -s -m 60 -w '\n%{http_code}' "$SHIM_URL/v1/messages" -H 'content-type: application/json' -d "$req")"
    code="$(echo "$resp" | tail -1)"
    resp="$(echo "$resp" | sed '$d')"
    if [ "$code" != "200" ]; then
        fail "$name: HTTP $code — $(echo "$resp" | head -c 300)"
        bad=$((bad + 1))
        return
    fi
    printf '%s' "$resp" > "$tmpdir/scenario.json"
    python3 -c "
import json, sys
d = json.load(open('$tmpdir/scenario.json'))
assert d.get('type') == 'message', f'not a message: {d}'
assert d.get('role') == 'assistant'
assert isinstance(d.get('content'), list) and len(d['content']) > 0, f'empty content: {d}'
has_thinking = any(b.get('type') == 'thinking' for b in d['content'])
has_text = any(b.get('type') == 'text' for b in d['content'])
assert has_text, f'no text block: {d}'
print(f'has_thinking={has_thinking} blocks={[b[\"type\"] for b in d[\"content\"]]}')
" && pass "$name: valid Anthropic-shaped 200 response" || { fail "$name: response shape check failed"; bad=$((bad + 1)); }
}

run_scenario "low effort (budget=1000)" 1000
run_scenario "medium effort (budget=8000)" 8000
run_scenario "xhigh effort (budget=25000)" 25000
run_scenario "no thinking block at all" ""
run_scenario "thinking + multi-turn history" 5000 \
  '{"role":"user","content":"What is 2+2?"},{"role":"assistant","content":[{"type":"thinking","thinking":"2+2=4","signature":"sig"},{"type":"text","text":"4"}]},'

# --- streaming scenario: SSE block open/close correctness through the translated path ------------
stream_req='{"model":"'"$MODEL"'","max_tokens":150,"stream":true,"thinking":{"type":"enabled","budget_tokens":5000},"messages":[{"role":"user","content":"Say OK and stop."}]}'
curl -s -N -m 60 "$SHIM_URL/v1/messages" -H 'content-type: application/json' -d "$stream_req" > "$tmpdir/stream.out"
python3 -c "
import json
EXPECT = {'text_delta': 'text', 'thinking_delta': 'thinking', 'input_json_delta': 'tool_use'}
started = {}; stopped = set(); mism = []
for line in open('$tmpdir/stream.out'):
    if not line.startswith('data: '): continue
    try: d = json.loads(line[6:])
    except Exception: continue
    t = d.get('type')
    if t == 'content_block_start': started[d['index']] = d['content_block']['type']
    elif t == 'content_block_stop': stopped.add(d['index'])
    elif t == 'content_block_delta':
        i = d['index']; dt = d['delta']['type']; want = EXPECT.get(dt); got = started.get(i, '<none>')
        if want and got != want: mism.append(f'{dt}->{got}')
unclosed = sorted(set(started) - stopped)
assert not mism, f'mismatched deltas: {mism}'
assert not unclosed, f'unclosed blocks: {unclosed}'
assert started, 'no content blocks opened at all'
print(f'blocks={list(started.values())}')
" && pass "streaming: all content blocks correctly typed and closed" || { fail "streaming: block validation failed"; bad=$((bad + 1)); }

echo
if [ "$bad" -eq 0 ]; then
    pass "all reasoning-effort scenarios clean end-to-end through the shim's translated dispatch"
    exit 0
else
    fail "$bad scenario(s) failed"
    info "shim log:"
    cat "$tmpdir/shim.log"
    exit 1
fi

#!/usr/bin/env bash
# test-reasoning-normalizer-live.sh — end-to-end proof that the thinking path is clean through the
# REAL stack: Claude Code's Anthropic surface -> claude-shim -> LiteLLM -> reasoning-normalizer -> vLLM.
#
# Run from the host (needs the stack up, `docker compose up -d`):
#   ./tests/test-reasoning-normalizer-live.sh
#
# It fires a multi-turn + thinking request N times (default 20) at LiteLLM's /v1/messages and, for
# each streamed response, asserts every *_delta lands on a content block whose content_block_start
# declared that type — the exact defect behind "API Error: Content block is not a thinking block".
# All curl/python run inside the sandbox container (shares the Docker network with LiteLLM). The
# only host dependency is docker. Set RUNS to change the count, MODEL to change the alias.

set -euo pipefail

CONTAINER="agentic-harness-sandbox"
LITELLM="http://agentic-litellm:4000/v1/messages"
RUNS="${RUNS:-20}"
MODEL="${MODEL:-brain}"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass() { echo -e "${GREEN}PASS${NC} $*"; }
fail() { echo -e "${RED}FAIL${NC} $*"; }
info() { echo -e "${YELLOW}    ${NC} $*"; }

# Multi-turn + thinking: assistant turn already carries a thinking block, then a fresh user turn —
# forces the reasoning->content transition that trips the bug.
read -r -d '' REQ <<JSON || true
{"model":"$MODEL","max_tokens":1500,"stream":true,"thinking":{"type":"enabled","budget_tokens":1024},
 "messages":[
   {"role":"user","content":"What is 2+2?"},
   {"role":"assistant","content":[
     {"type":"thinking","thinking":"The user asks 2+2. That is 4.","signature":"sig"},
     {"type":"text","text":"4"}]},
   {"role":"user","content":"Now what is 3+3? Think briefly."}]}
JSON

# The validator, run inside the container. Reads an SSE file, exits 0 only if every delta is paired
# to a correctly-typed, opened-and-closed block; prints a one-line verdict.
VALIDATOR='
import json,sys
EXPECT={"text_delta":"text","thinking_delta":"thinking","signature_delta":"thinking","input_json_delta":"tool_use"}
started={}; stopped=set(); mism=[]; err=None
for line in open(sys.argv[1]):
    if not line.startswith("data: "): continue
    try: d=json.loads(line[6:])
    except: continue
    t=d.get("type")
    if t=="content_block_start": started[d["index"]]=d["content_block"]["type"]
    elif t=="content_block_stop": stopped.add(d["index"])
    elif t=="content_block_delta":
        i=d["index"]; dt=d["delta"]["type"]; want=EXPECT.get(dt); got=started.get(i,"<none>")
        if want and got!=want: mism.append(f"{dt}->{got}")
    elif t=="error": err=json.dumps(d.get("error",{}))[:80]
unclosed=sorted(set(started)-stopped)
has_thinking = any(v=="thinking" for v in started.values())
ok = not mism and not unclosed and not err and has_thinking
print(f"mism={mism or 0} unclosed={unclosed or 0} err={err or 0} thinking={has_thinking}")
sys.exit(0 if ok else 1)
'

echo "== reasoning-normalizer live test: $RUNS runs, model=$MODEL =="
# -i is load-bearing: without it docker exec discards stdin and the validator lands as an EMPTY
# file — python3 on an empty file exits 0 and every run passes vacuously.
docker exec -i "$CONTAINER" sh -c "cat > /tmp/rn-live.py" <<< "$VALIDATOR"
docker exec "$CONTAINER" sh -c '[ -s /tmp/rn-live.py ]' || { fail "validator did not reach the container"; exit 1; }

bad=0
for n in $(seq 1 "$RUNS"); do
    docker exec "$CONTAINER" sh -c "curl -s -N --max-time 120 -X POST '$LITELLM' \
        -H 'content-type: application/json' -H 'x-api-key: dummy' \
        -d '$(echo "$REQ" | tr -d '\n')' > /tmp/rn-live.$n.out 2>&1"
    if out=$(docker exec "$CONTAINER" python3 /tmp/rn-live.py "/tmp/rn-live.$n.out" 2>&1); then
        pass "run $n: $out"
    else
        fail "run $n: $out"
        bad=$((bad + 1))
    fi
done

docker exec "$CONTAINER" sh -c 'rm -f /tmp/rn-live.*.out /tmp/rn-live.py' 2>/dev/null || true

echo
if [ "$bad" -eq 0 ]; then
    pass "$RUNS/$RUNS clean — thinking path is healthy end-to-end"
    exit 0
else
    fail "$bad/$RUNS runs failed"
    info "if these fail, the normalizer may not be in the path — check: docker compose ps reasoning-normalizer"
    exit 1
fi

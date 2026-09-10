#!/usr/bin/env bash
# Gate for context compression on the model path (issue #11): needles in big JSON/code tool_results
# must survive, streams stay structurally clean, no headroom_* tool injected. Passes with AND without
# the headroom profile. Run from host, both client and server stacks up and reachable from each
# other (see ../integration/README.md). Env: CONTAINER, LITELLM_HOST, LITELLM_PORT, RUNS (5),
# MODEL (brain), SCENARIOS (all).

set -euo pipefail

CONTAINER="${CONTAINER:-agentic-harness-sandbox}"
LITELLM="http://${LITELLM_HOST:-agentic-litellm}:${LITELLM_PORT:-4000}/v1/messages"
RUNS="${RUNS:-5}"
MODEL="${MODEL:-brain}"
SCENARIOS="${SCENARIOS:-json-needle,code-needle,stream-hygiene}"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass() { echo -e "${GREEN}PASS${NC} $*"; }
fail() { echo -e "${RED}FAIL${NC} $*"; }
info() { echo -e "${YELLOW}    ${NC} $*"; }

# Request generator + SSE validator, run inside the container. Payloads are built in python (not
# bash heredocs) because the tool_result bodies are hundreds of rows/lines — see gen().
HELPER='
import json, random, sys

MODEL = sys.argv[2] if len(sys.argv) > 2 else "brain"
NEEDLE_ID = "X-7741-QQZ"; NEEDLE_LATENCY = 9942
MAGIC_CONSTANT = 731852

def tools():
    return [{"name": "get_logs", "description": "Fetch service logs as JSON",
             "input_schema": {"type": "object", "properties": {"service": {"type": "string"}}}},
            {"name": "read_file", "description": "Read a source file",
             "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}}}]

def base(question, tool_name, tool_input, tool_result):
    return {"model": MODEL, "max_tokens": 2000, "stream": True,
            "thinking": {"type": "enabled", "budget_tokens": 1024},
            "tools": tools(),
            "messages": [
                {"role": "user", "content": question},
                {"role": "assistant", "content": [
                    {"type": "thinking", "thinking": "I should look at the data first.", "signature": "sig"},
                    {"type": "text", "text": "Let me check."},
                    {"type": "tool_use", "id": "toolu_hr_01", "name": tool_name, "input": tool_input}]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "toolu_hr_01", "content": tool_result},
                    {"type": "text", "text": question + " Answer with just the number."}]}]}

def gen_json_needle():
    # 300 boring rows around ~100ms, one screaming outlier — a sane compressor keeps outliers,
    # and the question is only answerable from that row.
    rng = random.Random(11)
    letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    rows = [{"request_id": f"R-{i:04d}-{rng.choice(letters)*3}",
             "service": "api", "status": 200, "latency_ms": rng.randint(80, 130)}
            for i in range(300)]
    rows[173] = {"request_id": NEEDLE_ID, "service": "api", "status": 200, "latency_ms": NEEDLE_LATENCY}
    q = f"What is the latency_ms of request {NEEDLE_ID}?"
    return base(q, "get_logs", {"service": "api"}, json.dumps(rows))

def gen_code_needle():
    # ~400 lines of plausible-but-boring code with one function whose return value is the fact
    # under test. AST-aware compression that elides this body loses the answer.
    fns = [f"def handler_{i}(payload):\n"
           f"    \"\"\"Route payload for channel {i}.\"\"\"\n"
           f"    if not payload:\n"
           f"        return None\n"
           f"    return {{\"channel\": {i}, \"size\": len(payload)}}\n" for i in range(80)]
    fns.insert(41, "def get_shard_seed():\n"
                   "    \"\"\"Seed for shard placement. Changing this reshuffles every shard.\"\"\"\n"
                   f"    return {MAGIC_CONSTANT}\n")
    q = "What number does the function get_shard_seed() in shards.py return?"
    return base(q, "read_file", {"path": "shards.py"}, "# shards.py\n" + "\n".join(fns))

def gen_text_needle():
    # ~94k tokens of plain log text, one error outlier. Probes the router:search/code_aware
    # misroute that deleted 94k -> 99 tokens in the spike (ideas/headroom-spike-results.md).
    rng = random.Random(23)
    services = ["api", "auth", "billing", "ingest", "scheduler", "webhook"]
    lines = []; approx = 0
    while approx < 64000 * 4:
        l = (f"2026-07-18T{rng.randint(0,23):02d}:{rng.randint(0,59):02d}:{rng.randint(0,59):02d}Z "
             f"{rng.choice(services)} level=info request_id=R-{rng.randint(0,99999):05d} "
             f"status={rng.choice([200,200,200,201,204,404,500])} latency_ms={rng.randint(40,900)} "
             f"bytes={rng.randint(200,90000)}")
        lines.append(l); approx += len(l) + 1
    lines[len(lines)//2] = ("2026-07-18T11:22:33Z api level=error request_id=X-9313-TTK "
                            "status=500 latency_ms=8317 bytes=17")
    q = "What is the latency_ms of request X-9313-TTK?"
    return base(q, "get_logs", {"service": "all"}, "\n".join(lines))

def gen_stream_hygiene():
    # Multi-turn + thinking + tools declared: the reasoning-normalizer scenario, with the tool
    # surface present so an injected headroom_* tool would have somewhere to show up.
    return {"model": MODEL, "max_tokens": 1500, "stream": True,
            "thinking": {"type": "enabled", "budget_tokens": 1024},
            "tools": tools(),
            "messages": [
                {"role": "user", "content": "What is 2+2?"},
                {"role": "assistant", "content": [
                    {"type": "thinking", "thinking": "The user asks 2+2. That is 4.", "signature": "sig"},
                    {"type": "text", "text": "4"}]},
                {"role": "user", "content": "Now what is 3+3? Think briefly."}]}

GEN = {"json-needle": (gen_json_needle, str(NEEDLE_LATENCY)),
       "code-needle": (gen_code_needle, str(MAGIC_CONSTANT)),
       "text-needle": (gen_text_needle, "8317"),   # slow (~94k prefill) — opt-in via SCENARIOS
       "stream-hygiene": (gen_stream_hygiene, "6")}

def validate(scenario, path):
    needle = GEN[scenario][1]
    expect = {"text_delta": "text", "thinking_delta": "thinking",
              "signature_delta": "thinking", "input_json_delta": "tool_use"}
    started = {}; stopped = set(); mism = []; err = None
    text = ""; raw = ""; in_tokens = out_tokens = None
    for line in open(path):
        raw += line
        if not line.startswith("data: "): continue
        try: d = json.loads(line[6:])
        except Exception: continue
        t = d.get("type")
        if t == "message_start":
            in_tokens = d.get("message", {}).get("usage", {}).get("input_tokens")
        elif t == "message_delta":
            u = d.get("usage", {})
            out_tokens = u.get("output_tokens") or out_tokens
            in_tokens = u.get("input_tokens") or in_tokens   # litellm sends 0 in message_start
        elif t == "content_block_start":
            started[d["index"]] = d["content_block"]["type"]
        elif t == "content_block_stop":
            stopped.add(d["index"])
        elif t == "content_block_delta":
            i = d["index"]; dt = d["delta"]["type"]
            want = expect.get(dt); got = started.get(i, "<none>")
            if want and got != want: mism.append(f"{dt}->{got}")
            if dt == "text_delta": text += d["delta"].get("text", "")
        elif t == "error":
            err = json.dumps(d.get("error", {}))[:80]
    unclosed = sorted(set(started) - stopped)
    has_thinking = any(v == "thinking" for v in started.values())
    injected = "headroom_" in raw
    found = needle in text
    ok = not mism and not unclosed and not err and has_thinking and found and not injected
    print(f"needle={found} inject={injected} mism={mism or 0} unclosed={unclosed or 0} "
          f"err={err or 0} thinking={has_thinking} in_tok={in_tokens} out_tok={out_tokens}")
    sys.exit(0 if ok else 1)

cmd, scenario = sys.argv[1].split(":", 1)
if cmd == "gen":
    print(json.dumps(GEN[scenario][0]()))
else:
    validate(scenario, sys.argv[2])
'

echo "== headroom-interactions live test: $RUNS runs each, model=$MODEL, scenarios=$SCENARIOS =="
# -i is load-bearing: without it docker exec discards stdin and the helper lands as an EMPTY file —
# python3 on an empty file exits 0 and every run passes vacuously.
docker exec -i "$CONTAINER" sh -c "cat > /tmp/hr-live.py" <<< "$HELPER"
docker exec "$CONTAINER" sh -c '[ -s /tmp/hr-live.py ]' || { fail "helper did not reach the container"; exit 1; }

bad=0
IFS=',' read -ra SCEN <<< "$SCENARIOS"
for s in "${SCEN[@]}"; do
    echo "-- scenario: $s"
    docker exec "$CONTAINER" sh -c "python3 /tmp/hr-live.py gen:$s '$MODEL' > /tmp/hr-req.json"
    for n in $(seq 1 "$RUNS"); do
        docker exec "$CONTAINER" sh -c "curl -s -N --max-time 180 -X POST '$LITELLM' \
            -H 'content-type: application/json' -H 'x-api-key: dummy' \
            -d @/tmp/hr-req.json > /tmp/hr-live.$n.out 2>&1"
        if out=$(docker exec "$CONTAINER" python3 /tmp/hr-live.py "validate:$s" "/tmp/hr-live.$n.out" 2>&1); then
            pass "$s $n: $out"
        else
            fail "$s $n: $out"
            bad=$((bad + 1))
        fi
    done
done

docker exec "$CONTAINER" sh -c 'rm -f /tmp/hr-live.*.out /tmp/hr-live.py /tmp/hr-req.json' 2>/dev/null || true

echo
total=$(( ${#SCEN[@]} * RUNS ))
if [ "$bad" -eq 0 ]; then
    pass "$total/$total clean — compression-sensitive facts survive, stream hygiene intact"
    exit 0
else
    fail "$bad/$total runs failed"
    info "needle=False  -> compression dropped a load-bearing fact (tune/disable the compressor)"
    info "inject=True   -> a headroom_* tool leaked into the stream (CCR must stay off)"
    info "mism/unclosed -> SSE structure damaged in transit — check the proxy chain is byte-transparent"
    exit 1
fi

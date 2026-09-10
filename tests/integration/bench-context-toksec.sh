#!/usr/bin/env bash
# Measures TTFT + decode tok/s vs context size through the real chain (issue #11 baseline/A-B;
# results: ideas/headroom-spike-results.md). Client-side SSE timing, filler re-randomized per run.
# Run with both client and server stacks up and reachable from each other (see
# ../integration/README.md). Env: CONTAINER, LITELLM_HOST, LITELLM_PORT, SIZES (token counts),
# RUNS (2), MODEL (brain).

set -euo pipefail

CONTAINER="${CONTAINER:-agentic-harness-sandbox}"
LITELLM_HOST="${LITELLM_HOST:-agentic-litellm}"
LITELLM_PORT="${LITELLM_PORT:-4000}"
SIZES="${SIZES:-2000,8000,16000,32000,64000}"
RUNS="${RUNS:-2}"
MODEL="${MODEL:-brain}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

# Runs inside the container: builds a request whose tool_result filler approximates the target
# token count (chars/4), streams it with per-event timestamps, prints one metrics line.
BENCH='
import json, os, random, sys, time, http.client

target_tokens = int(sys.argv[1]); model = sys.argv[2]; seed = int(sys.argv[3]); run = sys.argv[4]
litellm_host = os.environ.get("LITELLM_HOST", "agentic-litellm")
litellm_port = int(os.environ.get("LITELLM_PORT", "4000"))

rng = random.Random(seed)
services = ["api", "auth", "billing", "ingest", "scheduler", "webhook"]
lines = []
approx = 0
while approx < target_tokens * 4:  # ~4 chars/token
    l = (f"2026-07-18T{rng.randint(0,23):02d}:{rng.randint(0,59):02d}:{rng.randint(0,59):02d}Z "
         f"{rng.choice(services)} level=info request_id=R-{rng.randint(0,99999):05d} "
         f"status={rng.choice([200,200,200,201,204,404,500])} latency_ms={rng.randint(40,900)} "
         f"bytes={rng.randint(200,90000)}")
    lines.append(l); approx += len(l) + 1
filler = "\n".join(lines)

req = {"model": model, "max_tokens": 512, "stream": True,
       "messages": [
           {"role": "user", "content": "Fetch the service logs."},
           {"role": "assistant", "content": [
               {"type": "text", "text": "Fetching."},
               {"type": "tool_use", "id": "toolu_bench", "name": "get_logs", "input": {"scope": "all"}}]},
           {"role": "user", "content": [
               {"type": "tool_result", "tool_use_id": "toolu_bench", "content": filler},
               {"type": "text", "text": "Summarize these logs in about 5 sentences: overall error rate, slowest-looking services, anything unusual."}]}]}
body = json.dumps(req).encode()

conn = http.client.HTTPConnection(litellm_host, litellm_port, timeout=600)
t0 = time.monotonic()
conn.request("POST", "/v1/messages", body=body,
             headers={"content-type": "application/json", "x-api-key": "dummy"})
resp = conn.getresponse()

first_delta = last_delta = None
in_tok = out_tok = None
err = None
buf = b""
while True:
    chunk = resp.read(4096)
    if not chunk: break
    buf += chunk
    while b"\n" in buf:
        line, buf = buf.split(b"\n", 1)
        if not line.startswith(b"data: "): continue
        try: d = json.loads(line[6:])
        except Exception: continue
        t = d.get("type")
        now = time.monotonic()
        if t == "content_block_delta":
            if first_delta is None: first_delta = now
            last_delta = now
        elif t == "message_start":
            in_tok = d.get("message", {}).get("usage", {}).get("input_tokens")
        elif t == "message_delta":
            u = d.get("usage", {})
            out_tok = u.get("output_tokens") or out_tok
            in_tok = u.get("input_tokens") or in_tok   # litellm sends 0 in message_start
        elif t == "error":
            err = json.dumps(d.get("error", {}))[:100]

if err or first_delta is None:
    msg = err if err else "no deltas received"
    print(f"error: {msg} (http {resp.status})")
    sys.exit(1)
ttft = first_delta - t0
gen_s = max(last_delta - first_delta, 1e-6)
toks = round(out_tok / gen_s, 1) if out_tok else "-"
print(f"{target_tokens:<10} {run:<6} {str(in_tok):<12} {str(out_tok):<12} "
      f"{round(ttft, 2):<8} {round(gen_s, 2):<8} {toks}")
'

echo "== context-size vs tok/s bench: sizes=[$SIZES] runs=$RUNS model=$MODEL =="
# -i is load-bearing: without it docker exec discards stdin and the script lands empty.
docker exec -i "$CONTAINER" sh -c "cat > /tmp/bench-ctx.py" <<< "$BENCH"
docker exec "$CONTAINER" sh -c '[ -s /tmp/bench-ctx.py ]' || { echo "bench script did not reach the container"; exit 1; }

printf "%-10s %-6s %-12s %-12s %-8s %-8s %s\n" "target" "run" "input_tok" "output_tok" "ttft_s" "gen_s" "decode_tok/s"
IFS=',' read -ra SZ <<< "$SIZES"
for size in "${SZ[@]}"; do
    for n in $(seq 1 "$RUNS"); do
        seed=$((size + n * 7919))   # new filler each run — defeats vLLM prefix caching
        if out=$(docker exec -e LITELLM_HOST -e LITELLM_PORT "$CONTAINER" python3 /tmp/bench-ctx.py "$size" "$MODEL" "$seed" "$n" 2>&1); then
            printf "%s\n" "$out"
        else
            echo -e "${YELLOW}warn${NC} size=$size run=$n: $out"
        fi
    done
done

docker exec "$CONTAINER" sh -c 'rm -f /tmp/bench-ctx.py' 2>/dev/null || true
echo -e "${GREEN}done${NC} — rerun with the Headroom profile enabled for the A/B curve"

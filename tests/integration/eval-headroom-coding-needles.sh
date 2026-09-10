#!/usr/bin/env bash
# Needle-in-haystack eval over 10 realistic coding-agent payloads (20k-90k tokens), fresh seeded
# payload+needle per run — 200 independent data points at RUNS=20. Design + verdict: issue #11 /
# ideas/headroom-spike-results.md. Run with both client and server stacks up and reachable from
# each other (see ../integration/README.md). Env: CONTAINER, LITELLM_HOST, LITELLM_PORT, RUNS (20),
# MODEL (brain), SCENARIOS (all), OUT (results file).

set -euo pipefail

CONTAINER="${CONTAINER:-agentic-harness-sandbox}"
LITELLM_HOST="${LITELLM_HOST:-agentic-litellm}"
LITELLM_PORT="${LITELLM_PORT:-4000}"
RUNS="${RUNS:-20}"
MODEL="${MODEL:-brain}"
SCENARIOS="${SCENARIOS:-tsc-build,pytest,api-json,source-file,git-log,server-log,pip-freeze,rg-results,java-trace,k8s-config}"
OUT="${OUT:-/tmp/eval-headroom-results.jsonl}"

GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'

# -i is load-bearing: without it docker exec discards stdin and the file lands empty (vacuous runs).
docker exec -i "$CONTAINER" sh -c "cat > /tmp/eval-needles.py" < "$(dirname "$0")/eval-headroom-coding-needles.py"
docker exec "$CONTAINER" sh -c '[ -s /tmp/eval-needles.py ]' || { echo "helper missing in container"; exit 1; }

echo "== coding-needles eval: $RUNS runs/scenario, model=$MODEL, results -> $OUT =="
: > "$OUT"
declare -A pass total
IFS=',' read -ra SCEN <<< "$SCENARIOS"
for s in "${SCEN[@]}"; do
    for n in $(seq 1 "$RUNS"); do
        if line=$(docker exec -e LITELLM_HOST -e LITELLM_PORT "$CONTAINER" python3 /tmp/eval-needles.py "$s" "$n" "$MODEL" 2>&1); then
            ok=1; else ok=0
        fi
        echo "$line" >> "$OUT"
        pass[$s]=$(( ${pass[$s]:-0} + ok )); total[$s]=$(( ${total[$s]:-0} + 1 ))
        [ "$ok" = 1 ] && st="${GREEN}ok${NC}" || st="${RED}MISS${NC}"
        echo -e "$st $s $n: $(echo "$line" | head -c 200)"
    done
done

docker exec "$CONTAINER" sh -c 'rm -f /tmp/eval-needles.py' 2>/dev/null || true

echo; bad=0
for s in "${SCEN[@]}"; do
    p="${pass[$s]:-0}"; t="${total[$s]:-0}"
    [ "$p" -eq "$t" ] && c="$GREEN" || { c="$RED"; bad=1; }
    echo -e "${c}$s: $p/$t${NC}"
done
exit "$bad"

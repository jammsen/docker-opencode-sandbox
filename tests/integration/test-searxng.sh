#!/usr/bin/env bash
# test-searxng.sh — verify a running SearXNG instance (server-side) is healthy and searchable,
# reached from the client's sandbox container — i.e. this is a whole-chain check needing both
# stacks up and reachable from each other (see README.md in this directory).
#
# Run from the host:
#   ./tests/integration/test-searxng.sh
#
# All curl and python3 calls are executed inside the sandbox container via docker exec. The only
# host-side dependency is docker itself. Env: CONTAINER, SEARXNG_URL (defaults match a co-located
# same-compose-project setup; override for a real client/server split).

set -euo pipefail

CONTAINER="${CONTAINER:-agentic-harness-sandbox}"
BASE="${SEARXNG_URL:-http://searxng:8080}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

FAILED=0

pass() { echo -e "${GREEN}PASS${NC} $*"; }
fail() { echo -e "${RED}FAIL${NC} $*"; FAILED=$((FAILED + 1)); }
info() { echo -e "${YELLOW}    ${NC} $*"; }

run_curl() {
    docker exec "$CONTAINER" curl -s --max-time 10 "$@"
}

# -i passes stdin through so piped JSON reaches python3 inside the container.
run_python3() {
    docker exec -i "$CONTAINER" python3 "$@"
}

echo "=== SearXNG health check ==="
echo

# ── 1. Liveness probe ──────────────────────────────────────────────────────────
# /healthz returns plain "OK" with HTTP 200 when the server is up.
echo "[1/3] GET /healthz — liveness probe"
body=$(run_curl "${BASE}/healthz")
if [[ "$body" == "OK" ]]; then
    pass "instance is alive (response: '$body')"
else
    fail "unexpected response: '$body'"
fi
echo

# ── 2. Config endpoint ─────────────────────────────────────────────────────────
# /config returns a JSON object with engine metadata, categories, etc.
# It does not expose search.formats directly — we just verify it returns valid
# JSON and pull out a few enabled engine names as a sanity check.
echo "[2/3] GET /config — instance configuration"
config=$(run_curl "${BASE}/config")
engines=$(echo "$config" | run_python3 -c "
import sys, json
d = json.load(sys.stdin)
names = [e['name'] for e in d.get('engines', []) if e.get('enabled')][:5]
print(', '.join(names))
" 2>/dev/null || echo "")
if [[ -n "$engines" ]]; then
    pass "config returned valid JSON"
    info "sample enabled engines: $engines"
else
    fail "could not parse engine list from /config"
    info "raw response (first 300 chars): ${config:0:300}"
fi
echo

# ── 3. Search queries ─────────────────────────────────────────────────────────
# Three searches across different categories to verify multiple engine paths.
# Each checks that at least one result came back.
search_test() {
    local num="$1" query="$2" category="$3"
    echo "[${num}] search: '${query}' (category: ${category})"
    local response result_count
    response=$(run_curl "${BASE}/search?q=$(run_python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "${query}")&format=json&categories=${category}")
    result_count=$(echo "$response" | run_python3 -c "
import sys, json
d = json.load(sys.stdin)
print(len(d.get('results', [])))
" 2>/dev/null || echo "0")

    if [[ "$result_count" -gt 0 ]]; then
        pass "got ${result_count} results"
        echo "$response" | run_python3 -c "
import sys, json
d = json.load(sys.stdin)
r = d['results'][0]
print(f\"    title : {r.get('title','')}\")
print(f\"    url   : {r.get('url','')}\")
" 2>/dev/null || true
    else
        fail "zero results — engines may be failing or all timed out"
        info "raw response (first 300 chars): ${response:0:300}"
    fi
    echo
}

search_test "3/5" "docker compose networking"  "general"
search_test "4/5" "linux kernel release 2025"  "news"
search_test "5/5" "python asyncio tutorial"    "it"

exit "$FAILED"

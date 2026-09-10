# Integration tests

These exercise the real chain end-to-end — client → server's LiteLLM → reasoning-normalizer → vLLM
— unlike the unit tests that live alongside each half (`../../sandbox-client/tests/`, `../../server/tests/`).
They live here, outside both halves, because they need both stacks running and reachable from each
other; neither half alone can run them.

- `test-searxng.sh` — searXNG health + search check
- `test-headroom-interactions-live.sh` — needle-in-haystack correctness gate for the optional headroom sidecar (issue #11)
- `bench-context-toksec.sh` — TTFT + decode tok/s vs. context size
- `eval-headroom-coding-needles.py` / `.sh` — larger needle-in-haystack eval (200 runs)

Design background: [`../../ideas/headroom-spike-results.md`](../../ideas/headroom-spike-results.md), [`../../ideas/headroom-issue-size-gate-yaml.md`](../../ideas/headroom-issue-size-gate-yaml.md).

## Running them

Each script `docker exec`s into the client's sandbox container and, from there, reaches the
server's LiteLLM (and searXNG, for `test-searxng.sh`) by hostname. That only resolves automatically
when client and server happen to be on the same Docker network — the default if you're developing
with both `sandbox-client/compose.yml` and `server/compose.yml` up on one machine and joined together
(there's no single compose file spanning both after the split).

For a real split (server elsewhere, or just two separate compose projects on one host), override
the connection details instead of relying on Docker DNS:

```bash
CONTAINER=agentic-harness-sandbox \
LITELLM_HOST=<server-host> LITELLM_PORT=4000 \
./tests/integration/bench-context-toksec.sh

SEARXNG_URL=http://<server-host>:8080 ./tests/integration/test-searxng.sh
```

All scripts default to the old same-network hostnames (`agentic-litellm`, `searxng`) when these
env vars are unset, so nothing changes for a co-located dev setup.

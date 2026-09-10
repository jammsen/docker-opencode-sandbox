# Runs INSIDE the sandbox container (shipped there by eval-headroom-coding-needles.sh).
# One invocation = one request: generate a seeded realistic payload with a needle, stream it
# through LiteLLM /v1/messages, validate the answer, print one metrics line.
import json
import os
import random
import sys
import time
import http.client

SCEN, SEED, MODEL = sys.argv[1], int(sys.argv[2]), sys.argv[3]
LITELLM_HOST = os.environ.get("LITELLM_HOST", "agentic-litellm")
LITELLM_PORT = int(os.environ.get("LITELLM_PORT", "4000"))

AREAS = ["billing", "auth", "ingest", "catalog", "checkout", "shipping", "search", "admin"]
WORDS = ["update", "resolve", "handle", "parse", "render", "commit", "flush", "merge",
         "index", "rotate", "validate", "encode", "batch", "retry", "sync", "probe"]


def fill(rng, target_chars, line_fn):
    lines, n = [], 0
    while n < target_chars:
        l = line_fn(rng)
        lines.append(l)
        n += len(l) + 1
    return lines


def place(rng, lines, needle_lines):
    at = rng.randint(len(lines) // 10, len(lines) - 1)
    return lines[:at] + needle_lines + lines[at:]


# Each generator returns (tool_name, tool_input, tool_result, question, expect).
def gen_tsc_build(rng, uid):
    def line(r):
        return (f"src/{r.choice(AREAS)}/{r.choice(WORDS)}{r.randint(1,99)}.tsx"
                f"({r.randint(1,900)},{r.randint(1,80)}): warning TS6133: "
                f"{r.choice(WORDS)}Result is declared but its value is never read.")
    lines = fill(rng, 60000 * 4, line)
    needle = (f"src/billing/invoice_{uid}.ts({rng.randint(1,900)},{rng.randint(1,80)}): "
              f"error TS2345: Argument of type string is not assignable to parameter of type number.")
    lines = place(rng, lines, [needle])
    return ("Bash", {"command": "npx tsc --noEmit"}, "\n".join(lines),
            "The TypeScript build failed. Which source file contains the actual error (not a warning)?",
            f"invoice_{uid}.ts")


def gen_pytest(rng, uid):
    def line(r):
        return (f"tests/test_{r.choice(AREAS)}.py::test_{r.choice(WORDS)}_"
                f"{r.choice(WORDS)}_{r.randint(1,999)} PASSED [ {r.randint(1,99):2d}%]")
    lines = fill(rng, 30000 * 4, line)
    a, b = rng.randint(100, 499), rng.randint(500, 999)
    needle = [f"FAILED tests/test_ledger.py::test_balance_rounding_{uid} - AssertionError: assert {a} == {b}",
              f"E       assert {a} == {b}"]
    lines = place(rng, lines, needle)
    return ("Bash", {"command": "pytest -q"}, "\n".join(lines),
            "One test failed. Which one? Give its full test name.",
            f"test_balance_rounding_{uid}")


def gen_api_json(rng, uid):
    rows, n = [], 0
    while n < 40000 * 4:
        r = {"id": rng.randint(100, 9999), "title": f"{rng.choice(WORDS)} {rng.choice(AREAS)} flow",
             "state": rng.choice(["open", "closed"]), "comments": rng.randint(0, 99),
             "labels": rng.sample(["bug", "feat", "docs", "ci", "perf"], 2)}
        rows.append(r)
        n += len(json.dumps(r)) + 2
    nid = 10000 + (uid % 90000)
    rows.insert(rng.randint(len(rows) // 10, len(rows) - 1),
                {"id": nid, "title": "shard rebalance loops forever", "state": "open",
                 "comments": uid, "labels": ["bug", "perf"]})
    return ("mcp__github__list_issues", {"repo": "acme/platform"}, json.dumps(rows),
            f"How many comments does issue {nid} have?", str(uid))


def gen_source_file(rng, uid):
    fns = []
    for i in range(220):
        w = rng.choice(WORDS)
        fns.append(f"def handle_{w}_{i}(payload):\n"
                   f"    \"\"\"Route {w} payloads for channel {i}.\"\"\"\n"
                   f"    if not payload:\n"
                   f"        return None\n"
                   f"    return {{\"channel\": {i}, \"size\": len(payload)}}\n")
    fns.insert(rng.randint(20, 200),
               f"def get_shard_seed():\n"
               f"    \"\"\"Seed for shard placement. Changing this reshuffles every shard.\"\"\"\n"
               f"    return {uid}\n")
    return ("Read", {"file_path": "src/core/shards.py"}, "# shards.py\n" + "\n".join(fns),
            "What number does get_shard_seed() return?", str(uid))


def gen_git_log(rng, uid):
    hexc = "0123456789abcdef"
    def entry(r, path):
        h = "".join(r.choice(hexc) for _ in range(40))
        return (f"commit {h}\nAuthor: dev{r.randint(1,20)} <dev@acme.io>\n"
                f"Date:   2026-0{r.randint(1,7)}-{r.randint(10,28)}\n\n"
                f"    {r.choice(WORDS)} {r.choice(AREAS)} handling\n\n"
                f" src/{r.choice(AREAS)}/{path} | {r.randint(1,40)} +-\n")
    lines, n = [], 0
    while n < 50000 * 4:
        e = entry(rng, f"{rng.choice(WORDS)}.py")
        lines.append(e)
        n += len(e)
    short = f"{uid:05x}{''.join(rng.choice(hexc) for _ in range(3))}"
    h = short + "".join(rng.choice(hexc) for _ in range(32))
    needle = (f"commit {h}\nAuthor: dev7 <dev@acme.io>\nDate:   2026-06-30\n\n"
              f"    fix double refund on retry\n\n payments/refund.py | 12 +-\n")
    lines = place(rng, lines, [needle])
    return ("Bash", {"command": "git log --stat"}, "\n".join(lines),
            "Which commit modified payments/refund.py? Answer with the first 8 characters of its hash.",
            short)


def gen_server_log(rng, uid):
    def line(r):
        return (f"2026-07-18T{r.randint(0,23):02d}:{r.randint(0,59):02d}:{r.randint(0,59):02d}Z "
                f"{r.choice(AREAS)} level=info request_id=R-{r.randint(0,99999):05d} "
                f"status={r.choice([200,200,201,204,404])} latency_ms={r.randint(40,900)}")
    lines = fill(rng, 90000 * 4, line)
    needle = ["2026-07-18T11:22:33Z ingest level=error unhandled exception",
              "Traceback (most recent call last):",
              "  File \"/app/ingest/consumer.py\", line 214, in dispatch",
              "    shard = resolve_shard(msg.key)",
              f"ValueError: invalid shard id {uid}"]
    lines = place(rng, lines, needle)
    return ("Bash", {"command": "kubectl logs ingest-7d9f -n prod --tail=-1"}, "\n".join(lines),
            "The service crashed once — what is the exact exception message?", str(uid))


def gen_pip_freeze(rng, uid):
    def line(r):
        return (f"{r.choice(WORDS)}-{r.choice(AREAS)}-{r.choice(WORDS)}=="
                f"{r.randint(0,9)}.{r.randint(0,30)}.{r.randint(0,30)}")
    lines = fill(rng, 20000 * 4, line)
    v = f"{uid % 9}.{uid % 97}.{uid % 89}"
    lines = place(rng, lines, [f"tenant-shard-resolver=={v}"])
    return ("Bash", {"command": "pip freeze"}, "\n".join(lines),
            "Which version of tenant-shard-resolver is installed?", v)


def gen_rg_results(rng, uid):
    def line(r):
        return (f"src/{r.choice(AREAS)}/{r.choice(WORDS)}.py:{r.randint(1,999)}:"
                f"    shard = resolve_tenant_shard(ctx.tenant)")
    lines = fill(rng, 30000 * 4, line)
    ln = 1000 + (uid % 9000)
    lines = place(rng, lines, [f"src/core/shards.py:{ln}:def resolve_tenant_shard(tenant_id: str) -> int:"])
    return ("Grep", {"pattern": "resolve_tenant_shard"}, "\n".join(lines),
            "On which line number is resolve_tenant_shard DEFINED (not called)?", str(ln))


def gen_java_trace(rng, uid):
    def line(r):
        return (f"\tat com.acme.{r.choice(AREAS)}.{r.choice(WORDS).capitalize()}Service."
                f"{r.choice(WORDS)}({r.choice(WORDS).capitalize()}Service.java:{r.randint(10,999)})")
    lines = fill(rng, 40000 * 4, line)
    lines.insert(0, "Exception in thread \"main\" org.springframework.web.util.NestedServletException: Handler dispatch failed")
    needle = [f"Caused by: java.sql.SQLException: Deadlock detected on table ORDERS_{uid}",
              "\tat com.acme.orders.OrderRepository.lockRow(OrderRepository.java:88)"]
    lines = place(rng, lines, needle)
    return ("Bash", {"command": "cat /var/log/app/crash.log"}, "\n".join(lines),
            "What is the ROOT cause of this crash (the deepest Caused by)?", f"ORDERS_{uid}")


def gen_k8s_config(rng, uid):
    def block(r, name):
        envs = "\n".join(f"        - name: {w.upper()}_LIMIT\n          value: \"{r.randint(1,999)}\""
                         for w in r.sample(WORDS, 6))
        return (f"---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {name}\n"
                f"spec:\n  replicas: {r.randint(1,9)}\n  template:\n    spec:\n      containers:\n"
                f"      - name: {name}\n        image: registry.acme.io/{name}:1.{r.randint(0,60)}\n"
                f"        env:\n{envs}\n")
    blocks, n = [], 0
    while n < 60000 * 4:
        b = block(rng, f"{rng.choice(AREAS)}-{rng.choice(WORDS)}")
        blocks.append(b)
        n += len(b)
    salt = f"{uid:05x}{rng.randint(16,255):02x}"
    nb = block(rng, "billing-worker").replace(
        "        env:\n", f"        env:\n        - name: SHARD_SALT\n          value: \"{salt}\"\n", 1)
    blocks = place(rng, blocks, [nb])
    return ("Bash", {"command": "kubectl get deploy -o yaml -n prod"}, "\n".join(blocks),
            "What is the value of the SHARD_SALT env var in the billing-worker deployment?", salt)


GENS = {"tsc-build": gen_tsc_build, "pytest": gen_pytest, "api-json": gen_api_json,
        "source-file": gen_source_file, "git-log": gen_git_log, "server-log": gen_server_log,
        "pip-freeze": gen_pip_freeze, "rg-results": gen_rg_results,
        "java-trace": gen_java_trace, "k8s-config": gen_k8s_config}

rng = random.Random(f"{SCEN}-{SEED}")
uid = rng.randint(10000, 99999)
tool, tin, tres, question, expect = GENS[SCEN](rng, uid)

req = {"model": MODEL, "max_tokens": 2000, "stream": True,
       "thinking": {"type": "enabled", "budget_tokens": 1024},
       "tools": [{"name": tool.split("__")[-1], "description": "dev tool",
                  "input_schema": {"type": "object", "properties": {}}}],
       "messages": [
           {"role": "user", "content": question},
           {"role": "assistant", "content": [
               {"type": "thinking", "thinking": "Let me gather the data first.", "signature": "sig"},
               {"type": "text", "text": "Checking."},
               {"type": "tool_use", "id": "toolu_ev1", "name": tool.split("__")[-1], "input": tin}]},
           {"role": "user", "content": [
               {"type": "tool_result", "tool_use_id": "toolu_ev1", "content": tres},
               {"type": "text", "text": question + " Answer concisely."}]}]}

body = json.dumps(req).encode()
conn = http.client.HTTPConnection(LITELLM_HOST, LITELLM_PORT, timeout=600)
t0 = time.monotonic()
conn.request("POST", "/v1/messages", body=body,
             headers={"content-type": "application/json", "x-api-key": "dummy"})
resp = conn.getresponse()

expected_types = {"text_delta": "text", "thinking_delta": "thinking",
                  "signature_delta": "thinking", "input_json_delta": "tool_use"}
started, stopped, mism = {}, set(), []
text, err, in_tok, out_tok = "", None, None, None
first_delta = None
buf = b""
while True:
    chunk = resp.read(4096)
    if not chunk:
        break
    buf += chunk
    while b"\n" in buf:
        line, buf = buf.split(b"\n", 1)
        if not line.startswith(b"data: "):
            continue
        try:
            d = json.loads(line[6:])
        except Exception:
            continue
        t = d.get("type")
        if t == "content_block_start":
            started[d["index"]] = d["content_block"]["type"]
        elif t == "content_block_stop":
            stopped.add(d["index"])
        elif t == "content_block_delta":
            if first_delta is None:
                first_delta = time.monotonic()
            dt = d["delta"]["type"]
            want = expected_types.get(dt)
            if want and started.get(d["index"]) != want:
                mism.append(dt)
            if dt == "text_delta":
                text += d["delta"].get("text", "")
        elif t == "message_delta":
            u = d.get("usage", {})
            out_tok = u.get("output_tokens") or out_tok
            in_tok = u.get("input_tokens") or in_tok
        elif t == "error":
            err = json.dumps(d.get("error", {}))[:80]

total = time.monotonic() - t0
# comma-strip: models write 14643 as "14,643"; a fair check must not fail on formatting
found = expect in text or expect in text.replace(",", "")
clean = not mism and not (set(started) - stopped) and not err
ok = found and clean
print(json.dumps({"scenario": SCEN, "seed": SEED, "ok": ok, "found": found, "clean": clean,
                  "expect": expect, "in_tok": in_tok, "out_tok": out_tok,
                  "ttft_s": round((first_delta or time.monotonic()) - t0, 2),
                  "total_s": round(total, 2), "err": err,
                  "answer": text.strip()[:120]}))
sys.exit(0 if ok else 1)

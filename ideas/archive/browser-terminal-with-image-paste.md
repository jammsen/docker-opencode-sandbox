# Feature Idea: Browser-Based Terminal with Image Paste Support

## Problem

The current workflow to interact with the agent harness is:

```
Gaming PC → Windows Terminal → PowerShell → SSH → dockerdevnode → Docker container
```

This means:
- No way to paste/upload screenshots or images to the agent
- Terminal is text-only end to end
- Starting the harness always requires an SSH session

## Proposed Solution

Replace the SSH terminal interaction with a **browser-based terminal** (wetty or ttyd) running inside the container on port 1111.

```
Gaming PC → Browser → http://dockerdevnode:1111 → Docker container (agent inside)
```

The SSH access to the dockerdevnode VM itself stays the same — it is still needed for host-level management. Only the *interaction with the agent inside the container* moves to the browser.

---

## Architecture Changes Required

### 1. Container startup model: `run` → `up`

Currently `start.sh` uses `docker compose run --rm`, which is interactive and ephemeral.

For a browser terminal to work, the container must be long-running and start automatically. This means switching to `docker compose up -d` with `restart: unless-stopped` in `compose.yml`.

The `start.sh` / tool-selection menu would need to be rethought:
- Either bake the tool choice into the image/config at startup
- Or have wetty present the menu in the browser on first connect
- Or drop the multi-tool menu and pick one tool as the default for this mode

### 2. Entrypoint change: wetty/ttyd wraps the agent

The container's main process changes from `opencode`/`omp` directly to wetty or ttyd, which then spawns the chosen agent tool as its child process when a browser connects.

**Candidate tools:**
- **[wetty](https://github.com/butlerx/wetty)** — Node.js, supports file uploads via drag-drop in the browser, HTTPS-capable
- **[ttyd](https://github.com/tsl0922/ttyd)** — C binary, very lightweight, supports basic file transfer via ZMODEM

### 3. Image/file upload flow

With wetty:
1. User opens `http://dockerdevnode:1111` in browser
2. Drags and drops a screenshot onto the terminal window
3. wetty saves the file to a configurable upload directory inside the container
4. File lands at e.g. `/home/agent/workspace/uploads/screenshot.png`
5. User tells the agent: "there is a screenshot at `/home/agent/workspace/uploads/screenshot.png`"
6. If the model is multimodal and opencode supports image input, the agent can include it

---

## Security Requirements (NON-NEGOTIABLE)

The existing hardening **must be fully preserved**. This feature must not weaken any of the following:

| Existing control | Must stay | Notes |
|---|---|---|
| Non-root agent user via `gosu` | ✅ | wetty/ttyd must also drop to `agent` before spawning the tool |
| `no-new-privileges` | ✅ | No exceptions |
| `cap_drop: ALL` + minimal `cap_add` | ✅ | wetty/ttyd does not need any additional capabilities |
| `read_only` filesystem model | ✅ | Uploads land in the already-writable `./workspace` volume only |
| Bridge network only | ✅ | No `network_mode: host` |
| Pinned base image digest | ✅ | wetty/ttyd added via apt or pinned binary, not via a floating tag |
| Config mounts remain read-only | ✅ | Upload dir is separate from config mounts |

### Additional security considerations for this feature

- **wetty/ttyd must listen only on `0.0.0.0:1111` inside the container**, mapped to `1111` on the host — same as the current port mapping
- **Authentication**: the browser terminal is unauthenticated by default in both wetty and ttyd. This MUST be addressed before use:
  - Preferred: put a reverse proxy (nginx) in front with basic auth or client certificates
  - Acceptable for LAN-only: firewall the port to trusted IPs only at the VM/cloud-security-group level
  - Do NOT leave an unauthenticated terminal exposed on a public IP under any circumstances
- **Upload directory**: restrict to `/home/agent/workspace/uploads/` only, with a configurable size limit to prevent disk exhaustion
- **wetty runs as Node.js**: the wetty process itself should run as root only for the initial bind, then drop to `agent` — consistent with how `gosu` is used in the current entrypoint
- **HTTPS**: if the dockerdevnode is reachable from outside the LAN, TLS is required. wetty supports a `--ssl-key` / `--ssl-cert` flag. Consider a self-signed cert at minimum.

---

## Open Questions

1. **Tool selection menu**: currently the entrypoint shows an interactive numbered menu. With an always-running container, how is the tool chosen? Options:
   - Always default to the first entry in `TOOLS`
   - Accept `DEFAULT_TOOL` as a required env var when using this mode
   - Show the menu in the browser terminal on first connect (this works fine with wetty/ttyd)

2. **Session persistence**: `docker compose run --rm` destroys the container on exit, which is a clean-slate guarantee. With `restart: unless-stopped`, the container persists. The reset script (`scripts/reset-sandbox.sh`) still handles data cleanup, but the operational model is different.

3. **Multiple simultaneous browser connections**: both wetty and ttyd support multiple connections. Should they share the same terminal session (tmux-style) or each get an isolated session? For a single-user sandbox, shared is simpler but isolated is safer.

4. **Port conflict with dev servers**: port 1111 is used for the browser terminal in this design. The agent can no longer use port 1111 to host dev servers (Vite, etc.) at the same time. Options:
   - Accept this tradeoff (two modes: terminal-mode vs dev-server-mode, can't do both at once)
   - Expose a second port (e.g. 1112) for dev servers — requires a second `ports` entry in `compose.yml`
   - Run wetty/ttyd on a sub-path with a reverse proxy sharing port 1111

---

## Implementation Sketch

```
Dockerfile additions:
  - Install wetty (via npm/apt) or ttyd (via apt/binary)
  - Install nginx if a reverse proxy with auth is desired

compose.yml:
  - restart: unless-stopped
  - ports: keep "1111:1111/tcp"
  - Remove stdin_open / tty (wetty manages its own pty)

entrypoint.sh changes:
  - After gosu setup, instead of exec gosu agent "$TOOL":
    exec gosu agent wetty --port 1111 --command "$TOOL" [--upload-dir /home/agent/workspace/uploads]
```

---

## References

- wetty: https://github.com/butlerx/wetty
- ttyd: https://github.com/tsl0922/ttyd
- Current security model: see `README.md` → Security Notes section
- Port mapping: see `compose.yml` and `start.sh` (`--service-ports` flag required for `docker compose run`)

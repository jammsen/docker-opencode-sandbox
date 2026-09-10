# Background services and the foreground terminal — supervised sidecars
# restart on crash without touching wetty/sessions.

_supervise() { # <name> <restart_delay_s> <cmd...>
    local name="$1" delay="$2"; shift 2
    local rc=0
    while true; do
        # || rc=$? keeps set -e from exiting the subshell when the sidecar crashes.
        "$@" || rc=$?
        ew "> [Supervisor] $name exited (exit ${rc}) — restarting in ${delay} s" >&2
        rc=0
        sleep "$delay"
    done
}

start_upload_server() {
    # Image upload companion (addon — 30 s restart delay)
    ( _supervise upload-server 30 gosu agent node /upload-server.js ) &
    e "> Upload server started on port 1112 — https://<your-server-ip>:1112"
}

start_claude_shim() {
    # Claude→LiteLLM rewrite proxy (critical for image analysis — 5 s restart
    # delay). Lifts images out of Claude Code's tool_result blocks so LiteLLM
    # forwards them instead of dropping them. Claude Code reaches it via
    # ANTHROPIC_BASE_URL=http://127.0.0.1:4001.
    ( _supervise claude-shim 5 gosu agent node /claude-shim.js ) &
    e "> Claude image-rewrite proxy started on 127.0.0.1:4001 → ${LITELLM_UPSTREAM:-http://agentic-litellm:4000}"
}

start_wetty() {
    ei "> Starting WeTTY browser terminal on port 1111..."
    ei "> Connect at: https://<your-server-ip>:1111  (accept the self-signed cert warning once)"
    # wetty must run as root so it detects localhost and uses local/command mode
    # instead of SSH. agent-session.sh drops to the agent user immediately on startup.
    exec wetty \
        --port 1111 \
        --host 0.0.0.0 \
        --command /agent-session.sh \
        --title "Agentic Harness Sandbox" \
        --allow-iframe \
        --ssl-key /etc/wetty/key.pem \
        --ssl-cert /etc/wetty/cert.pem
}

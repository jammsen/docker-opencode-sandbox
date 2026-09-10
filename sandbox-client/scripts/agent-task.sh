#!/usr/bin/env bash
# agent-task — run a one-shot, headless Claude Code task as the unprivileged 'agent' user.
#
# Usage (from the host):
#   docker exec agentic-harness-sandbox agent-task "Summarise WORKLOG.md in 3 bullet points"
#   docker exec -i agentic-harness-sandbox agent-task "..."        # -i to pipe data in on stdin
#   docker exec agentic-harness-sandbox agent-task "..." --permission-mode plan   # override autonomy
#
# Why this exists (security):
#   A plain `docker exec agentic-harness-sandbox claude ...` runs Claude as ROOT — the container's
#   entrypoint runs as root, and exec inherits that user. This wrapper ALWAYS re-execs itself under
#   gosu to drop root -> agent (the same privilege-drop path agent-session.sh uses for browser
#   sessions), so a task can never run with more privilege than an interactive session, regardless of
#   how it is invoked. With no-new-privileges + cap_drop:ALL in effect, there is no path back to root.

# exec starts as root for setup; drop to the agent user immediately and re-enter this script.
# gosu preserves the environment, so HOME=/home/agent and the tool PATH carry through.
if [[ "${EUID}" -eq 0 ]]; then
    exec /usr/sbin/gosu agent "$0" "$@"
fi

set -euo pipefail

if [[ $# -eq 0 ]]; then
    echo "Usage: agent-task \"<prompt>\" [extra claude flags]" >&2
    exit 64
fi

# All agent tools treat the workspace as the project root.
cd /home/agent/workspace

# `-p`/`--print` runs Claude non-interactively and prints the final result to stdout.
# The container itself is the security boundary (unprivileged user, cap_drop:ALL, network isolation,
# writable fs limited to workspace+data), so default to autonomous tool use for a usable task runner.
# Pass your own --permission-mode (e.g. plan) or --dangerously-skip-permissions to override.
mode=(--permission-mode bypassPermissions)
_prev=""
for arg in "$@"; do
    case "$arg" in
        --permission-mode=*|--dangerously-skip-permissions) mode=() ;;
        --permission-mode)
            # bare form: next arg must be the value; if it's missing or looks like a flag, error out
            mode=()
            _prev="--permission-mode"
            ;;
        *)
            if [[ "$_prev" = "--permission-mode" && ("$arg" = -* || -z "$arg") ]]; then
                echo "Usage: agent-task \"<prompt>\" --permission-mode <value>" >&2
                exit 64
            fi
            _prev=""
            ;;
    esac
done
if [[ "$_prev" = "--permission-mode" ]]; then
    echo "agent-task: --permission-mode requires a value (e.g. --permission-mode plan)" >&2
    exit 64
fi

exec claude -p "${mode[@]}" "$@"

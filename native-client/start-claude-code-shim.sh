#!/usr/bin/env bash
# start-claude-code-shim.sh — run claude-shim.js standalone (no Docker). This is ONLY needed for
# Claude Code — OpenCode and OMP talk to the server directly, no shim involved. Reads the env
# setup.sh wrote and execs node in the foreground; Ctrl+C stops it. Run this once in a terminal
# you leave open (or under your own supervisor — systemd --user, tmux, launchd, whatever you
# already use), then point Claude Code at http://127.0.0.1:3999 as described by setup.sh.
set -euo pipefail

CONFIG_DIR="${AGENTIC_NATIVE_CONFIG_DIR:-$HOME/.config/agentic-harness-native}"
ENVFILE="$CONFIG_DIR/env"

command -v node >/dev/null || { echo ">>> node is required to run claude-shim.js" >&2; exit 1; }
[[ -f "$ENVFILE" ]] || { echo ">>> $ENVFILE not found — run ./setup.sh first" >&2; exit 1; }

# shellcheck source=/dev/null
set -a; source "$ENVFILE"; set +a

echo "> starting claude-shim on 127.0.0.1:3999 -> $LITELLM_UPSTREAM (catalog: $MODELS_FILE)"
exec node "$(dirname "$0")/claude-shim.js"

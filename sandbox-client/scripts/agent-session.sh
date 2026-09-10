#!/usr/bin/env bash
# Runs inside the browser terminal — spawned by wetty for each browser connection.
# Self-wraps in tmux so closing the browser tab detaches rather than kills the session.
# On reconnect, tmux reattaches to the same running agent.
# Inherits AVAILABLE_TOOLS_ENV, DEFAULT_TOOL, TOOLS from entrypoint.sh.

# wetty must run as root for local/command mode; drop to agent user immediately.
# gosu preserves environment variables so all exported vars from entrypoint.sh carry through.
if [[ "${EUID}" -eq 0 ]]; then
    exec /usr/sbin/gosu agent "$0" "$@"
fi

set -euo pipefail

# --- tmux session persistence ---
# TMUX is set when already inside a session — skip this block if so.
if [[ -z "${TMUX:-}" ]]; then

    # Parse running tmux sessions for this user.
    SESSION_IDS=()    # "sandbox-..." — used for tmux attach -t
    SESSION_LABELS=() # "sandbox-...  (Detached)" — shown to user
    while IFS=' ' read -r _name _status; do
        [[ -n "$_name" ]] || continue
        SESSION_IDS+=("$_name")
        SESSION_LABELS+=("$_name  ($_status)")
    done < <(tmux list-sessions -F '#{session_name} #{?session_attached,Attached,Detached}' 2>/dev/null || true)

    # Model catalog gate: no brain/vision configured -> nothing else makes sense (every session
    # and tool would run into gateway errors), so sessions are shown in RED and disabled, and the
    # model configuration is the default. The catalog is global (one file, all sessions), so the
    # wizard lives here on the first screen, not per session.
    RED=$'\033[0;31m'; NC=$'\033[0m'
    _models_ok() { MODELS_STATUS="$(model-config status 2>/dev/null)"; }

    # Present picker with re-prompt on invalid input. Always shown — even with
    # no sessions — so the terminal has time to size correctly before tmux
    # starts. Attach is multiattach by default; window-size latest (tmux.conf)
    # sizes the session to the most recently active client.
    _NEW=$((${#SESSION_IDS[@]} + 1))
    _WIZ=$((${#SESSION_IDS[@]} + 2))
    while true; do
        if _models_ok; then MODELS_OK=1; else MODELS_OK=0; fi
        echo ""
        if [[ $MODELS_OK -eq 1 ]]; then
            echo "$MODELS_STATUS"
            _DEF=1
        else
            echo "${RED}>>> No usable model configuration — set up models first (option $_WIZ).${NC}"
            _DEF=$_WIZ
        fi
        echo ""
        echo "Existing sessions:"
        for i in "${!SESSION_LABELS[@]}"; do
            if [[ $MODELS_OK -eq 0 ]]; then
                echo "  $((i+1)). ${RED}${SESSION_LABELS[$i]}  (needs model configuration)${NC}"
            elif [[ $i -eq 0 ]]; then
                echo "  $((i+1)). ${SESSION_LABELS[$i]}  (default)"
            else
                echo "  $((i+1)). ${SESSION_LABELS[$i]}"
            fi
        done
        if [[ $MODELS_OK -eq 0 ]]; then
            echo "  $_NEW. ${RED}Start a new session  (needs model configuration)${NC}"
            echo "  $_WIZ. Model configuration  (default)"
        else
            echo "  $_NEW. Start a new session"
            echo "  $_WIZ. Model configuration"
        fi
        echo ""
        read -r -p "Enter selection [$_DEF]: " _SEL
        _SEL="${_SEL:-$_DEF}"

        if [[ "$_SEL" =~ ^[0-9]+$ ]] && [[ "$_SEL" -eq "$_WIZ" ]]; then
            model-config || true          # returns here; the gate is re-evaluated at the top of the loop
        elif [[ "$_SEL" =~ ^[0-9]+$ ]] && [[ "$_SEL" -ge 1 ]] && [[ "$_SEL" -le "$_NEW" ]] && [[ $MODELS_OK -eq 0 ]]; then
            echo "  ${RED}Set up models first (option $_WIZ).${NC}"
        elif [[ "$_SEL" =~ ^[0-9]+$ ]] && [[ "$_SEL" -ge 1 ]] && [[ "$_SEL" -le "${#SESSION_IDS[@]}" ]]; then
            exec tmux attach-session -t "${SESSION_IDS[$((${_SEL}-1))]}"
        elif [[ "$_SEL" =~ ^[0-9]+$ ]] && [[ "$_SEL" -eq "$_NEW" ]]; then
            exec tmux new-session -s "sandbox-started-$(date +%Y-%m-%d-%H-%M-%S)" "$0"
        else
            echo "  Invalid — enter a number between 1 and $_WIZ"
        fi
    done
fi
# --- From here on we are inside a tmux session ---

# Tool list is built and validated once by entrypoint.sh, exported as AVAILABLE_TOOLS_ENV.
if [[ -z "${AVAILABLE_TOOLS_ENV:-}" ]]; then
    echo ">>> AVAILABLE_TOOLS_ENV is not set — was this session started through entrypoint.sh?"
    exit 1
fi
read -ra AVAILABLE_TOOLS <<< "$AVAILABLE_TOOLS_ENV"

# Select tool — skip menu if DEFAULT_TOOL is set or only one tool exists.
# (The model-catalog gate sits on the first screen: this menu is only reachable when configured.)
TOOL=""
if [[ -n "${DEFAULT_TOOL:-}" ]]; then
    for _t in "${AVAILABLE_TOOLS[@]}"; do
        if [[ "$_t" = "$DEFAULT_TOOL" ]]; then
            TOOL="$_t"
            break
        fi
    done
    if [[ -z "$TOOL" ]]; then
        echo ">>> DEFAULT_TOOL='$DEFAULT_TOOL' not available. Available: ${AVAILABLE_TOOLS[*]}"
        exit 1
    fi
elif [[ ${#AVAILABLE_TOOLS[@]} -eq 1 ]]; then
    TOOL="${AVAILABLE_TOOLS[0]}"
else
    echo ""
    echo "Select which tool to start:"
    for i in "${!AVAILABLE_TOOLS[@]}"; do
        if [[ $i -eq 0 ]]; then
            echo "  $((i+1)). ${AVAILABLE_TOOLS[$i]}  (default)"
        else
            echo "  $((i+1)). ${AVAILABLE_TOOLS[$i]}"
        fi
    done
    echo ""
    read -r -p "Enter selection [1]: " SELECTION
    case "$SELECTION" in
        ""|1) TOOL="${AVAILABLE_TOOLS[0]}" ;;
        *)
            if [[ "$SELECTION" =~ ^[0-9]+$ ]] && \
               [[ "$SELECTION" -ge 2 ]] && \
               [[ "$((SELECTION-1))" -lt "${#AVAILABLE_TOOLS[@]}" ]]; then
                TOOL="${AVAILABLE_TOOLS[$((SELECTION-1))]}"
            else
                echo ">>> Invalid selection '$SELECTION' — defaulting to ${AVAILABLE_TOOLS[0]} in 3 seconds..."
                sleep 3
                TOOL="${AVAILABLE_TOOLS[0]}"
            fi
            ;;
    esac
    echo ""
fi

# Start all tools from the workspace directory.
# omp auto-switches away from ~ unless --allow-home is passed, and opencode
# uses CWD as its project root — both need a proper starting directory.
cd /home/agent/workspace

exec "$TOOL"

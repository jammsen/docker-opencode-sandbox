# Workspace and agent-tool discovery — builds the tool list agent-session.sh
# presents in the browser.

check_workspace() {
    if [[ ! -d "$APP_HOME/workspace" ]]; then
        ee ">>> [Entrypoint] Workspace directory '$APP_HOME/workspace' not found — is the volume mounted?"
        exit 1
    fi
}

detect_tools() {
    # Ordered list from TOOLS (defined in Dockerfile, overridable in compose.yml).
    # First entry is the default. Each name is validated and checked against
    # installed binaries.
    local tools_list tool valid
    AVAILABLE_TOOLS=()
    IFS=',' read -ra tools_list <<< "$TOOLS"
    for tool in "${tools_list[@]}"; do
        tool="${tool// /}"
        # Tool names must be safe to eval in the command -v check below.
        if ! [[ "$tool" =~ ^[a-zA-Z0-9_-]+$ ]]; then
            ew "> [Warning] Skipping invalid tool name '$tool' in TOOLS"
            continue
        fi
        if gosu "$APP_USER":"$APP_GROUP" bash -c "command -v '$tool'" &>/dev/null; then
            AVAILABLE_TOOLS+=("$tool")
        else
            ew "> [Warning] Tool '$tool' listed in TOOLS but not found — skipping"
        fi
    done

    if [[ ${#AVAILABLE_TOOLS[@]} -eq 0 ]]; then
        ee ">>> [Entrypoint] No tools available. Ensure at least one tool binary is installed in the image."
        exit 1
    fi

    # If DEFAULT_TOOL is set, validate it now so we fail fast before wetty starts.
    if [[ -n "${DEFAULT_TOOL:-}" ]]; then
        valid=false
        for tool in "${AVAILABLE_TOOLS[@]}"; do
            [[ "$tool" = "$DEFAULT_TOOL" ]] && valid=true && break
        done
        if [[ "$valid" = "false" ]]; then
            ee ">>> [Entrypoint] DEFAULT_TOOL='$DEFAULT_TOOL' not available. Available: ${AVAILABLE_TOOLS[*]}"
            exit 1
        fi
    fi

    # Space-separated string — inherited by agent-session.sh via wetty.
    export AVAILABLE_TOOLS_ENV="${AVAILABLE_TOOLS[*]}"
}

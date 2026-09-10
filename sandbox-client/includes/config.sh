# Tool configuration — syncs Claude Code config, renders tool configs from the
# model catalog, links opencode auth. All sources are mounted by compose.yml.

sync_claude_config() {
    # Runs on every start so config changes always take effect. Sources are
    # mounted read-only at ~/.config/claude-*; ~/.claude/ is a rw volume
    # (session state lives there alongside the synced files). ~/.claude.json is
    # in the writable container layer — written here so onboarding/trust state
    # is always correct even after a container restart or recreation.
    local src_settings="$APP_HOME/.config/claude-settings.json"
    local src_claude_md="$APP_HOME/.config/claude-CLAUDE.md"
    local src_agents="$APP_HOME/.config/claude-agents"
    local src_json="$APP_HOME/.config/claude.json"
    local claude_dir="$APP_HOME/.claude"
    local claude_json="$APP_HOME/.claude.json"

    [[ -f "$src_settings" ]] || return 0
    mkdir -p "$claude_dir/agents"
    chown "$APP_USER":"$APP_GROUP" "$claude_dir" "$claude_dir/agents"
    install -m644 -o "$APP_USER" -g "$APP_GROUP" "$src_settings" "$claude_dir/settings.json"
    install -m644 -o "$APP_USER" -g "$APP_GROUP" "$src_claude_md" "$claude_dir/CLAUDE.md"
    if [[ -d "$src_agents" ]]; then
        rm -f "$claude_dir/agents/"*.md 2>/dev/null || true
        find "$src_agents" -name '*.md' | while IFS= read -r f; do
            install -m644 -o "$APP_USER" -g "$APP_GROUP" "$f" "$claude_dir/agents/$(basename "$f")"
        done
    fi
    [[ -f "$src_json" ]] && install -m600 -o "$APP_USER" -g "$APP_GROUP" "$src_json" "$claude_json"
    e "> Claude Code config synced to $claude_dir and $claude_json"
}

# Tool configs are rendered from the model catalog (~/.config/models/models.yml) by render-models —
# the same script the model-config wizard runs after "write", so a wizard change and a container
# start produce identical files. No catalog yet -> nothing rendered; the session menu gates the
# tools until the wizard has run.
render_tool_templates() {
    export APP_HOME APP_USER APP_GROUP        # readonly in the entrypoint, so pass by export not prefix
    /usr/local/bin/render-models || ew "> [Warning] render-models failed — tool configs may be stale"
    chown "$APP_USER":"$APP_GROUP" "$APP_HOME/.config/opencode" "$APP_HOME/.omp" "$APP_HOME/.omp/agent" 2>/dev/null || true
}

render_mcp_config() {
    # omp's mcp.json isn't catalog-derived, just needs SEARXNG_URL substituted — a plain sed
    # render, not routed through render-models. Source is a template (__SEARXNG_URL__ placeholder)
    # mounted read-only; destination is generated fresh on every start.
    local tpl="$APP_HOME/.config/templates/omp-mcp.json"
    local dst="$APP_HOME/.omp/agent/mcp.json"

    [[ -f "$tpl" ]] || return 0
    mkdir -p "$(dirname "$dst")"
    sed "s#__SEARXNG_URL__#${SEARXNG_URL:?SEARXNG_URL not set}#g" "$tpl" > "$dst.tmp" \
        && mv -f "$dst.tmp" "$dst" \
        && chown "$APP_USER":"$APP_GROUP" "$dst"
    e "> Rendered mcp.json with SEARXNG_URL=${SEARXNG_URL}"
}

link_opencode_auth() {
    # Link auth.json into place instead of bind-mounting it directly at
    # .local/share/opencode/auth.json — that path is nested inside the
    # .local/share/opencode dir mount, and Docker Desktop for Mac's virtiofs
    # backend fails to create nested mountpoints ("mountpoint ... is outside of
    # rootfs"). The source stays a live bind mount at a non-nested path, so
    # host edits to config/opencode/auth.json still apply immediately.
    local auth_src="$APP_HOME/.config/opencode-auth.json"
    local data_dir="$APP_HOME/.local/share/opencode"

    [[ -f "$auth_src" ]] || return 0
    mkdir -p "$data_dir"
    chown "$APP_USER":"$APP_GROUP" "$data_dir"
    ln -sf "$auth_src" "$data_dir/auth.json"
    e "> opencode auth.json linked into $data_dir"
}

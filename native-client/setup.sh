#!/usr/bin/env bash
# setup.sh — overview-driven manager for native (no Docker) Claude Code, OpenCode, and OMP: check
# what's installed and configured, install a missing tool, or point one at a running ../server/
# instance. Same shape as the sandbox's model-config.sh and the server's own model-config.sh —
# show current state first, then a lettered menu — not a forced linear wizard.
#
#   - Claude Code speaks Anthropic's wire format only, so it goes through claude-shim.js (this
#     directory) for translation/dispatch — same logic as the sandbox client's shim, just running
#     locally instead of in a container. Needs node.
#   - OpenCode and OMP already speak OpenAI natively, so they're pointed straight at the resolved
#     server's own address — no shim, no node needed for them.
#
# Installs a tool via its official installer if you ask (same ones the sandbox's Dockerfile uses).
# Any existing config this touches is backed up first, next to the original file, timestamped —
# same convention as the sandbox wizard's RESET backups.
set -euo pipefail

CONFIG_DIR="${AGENTIC_NATIVE_CONFIG_DIR:-$HOME/.config/agentic-harness-native}"
CATALOG="$CONFIG_DIR/models.json"
ENVFILE="$CONFIG_DIR/env"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
OC_CONFIG="$HOME/.config/opencode/opencode.json"
OMP_MODELS="$HOME/.omp/agent/models.yml"
OMP_CONFIG="$HOME/.omp/agent/config.yml"
OMP_MCP="$HOME/.omp/agent/mcp.json"

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; DIM=$'\033[2m'; NC=$'\033[0m'
e()  { echo "$*"; }
ei() { echo "${DIM}$*${NC}"; }
ew() { echo "${YELLOW}$*${NC}"; }
ee() { echo "${RED}$*${NC}" >&2; }
es() { echo "${GREEN}$*${NC}"; }

command -v jq >/dev/null || { ee ">>> jq is required (apt install jq / brew install jq, or run this script's 'r' menu option once jq is present)"; exit 1; }

# The official installers (opencode.ai, omp.sh, claude.ai) each drop the binary in its own
# directory and add a PATH line to ~/.bashrc — which only takes effect in a NEW interactive shell.
# A plain `bash setup.sh` (this script, right now, including your very next run) never sources
# that, so a tool installed a moment ago — in this run or any earlier one — can still look "not
# installed" here even though it's genuinely on disk. Check the well-known install locations
# ourselves, every time, before reporting status on anything.
refresh_path_for() {
    local bin="$1" d
    for d in "$HOME/.local/bin" "$HOME/.opencode/bin" "$HOME/.omp/bin" "$HOME/.claude/bin" "$HOME/bin"; do
        [[ -x "$d/$bin" ]] || continue
        case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH"; export PATH ;; esac
    done
}
refresh_all_paths() { local b; for b in claude opencode omp; do refresh_path_for "$b"; done; refresh_nvm_node; }

# If node was installed via nvm (see install_node_via_nvm below), it doesn't live in one of
# the fixed directories refresh_path_for scans — nvm keeps versions under ~/.nvm/versions/node/*
# and picks the active one via shell functions sourced from nvm.sh. Re-source it and select the
# active version every time, same reasoning as refresh_path_for: a plain `bash setup.sh` never
# sources ~/.bashrc, so this wouldn't otherwise show up until a new interactive shell.
refresh_nvm_node() {
    [[ -s "$HOME/.nvm/nvm.sh" ]] || return 0
    export NVM_DIR="$HOME/.nvm"
    # shellcheck disable=SC1091
    \. "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || return 0
    nvm use default >/dev/null 2>&1 || nvm use node >/dev/null 2>&1 || true
}

# mcp-searxng (and its undici dependency) hard-require Node >=22 (undici's fetch/File shim is
# missing on older runtimes: "ReferenceError: File is not defined" at startup) — plain distro
# `nodejs` packages are frequently older than that (e.g. Ubuntu 24.04 ships 18.19.1), so a present
# `node`/`npx` on PATH is not sufficient on its own for searXNG specifically.
node_major() { command -v node >/dev/null && node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0; }
node_ok_for_searxng() { [[ "$(node_major)" -ge 22 ]]; }
node_version_str() { command -v node >/dev/null && echo "v$(node -v | tr -d v)" || echo "not installed"; }

backup() {
    local f="$1"
    [[ -f "$f" ]] || return 0
    cp "$f" "$f.bak-$(date +%Y%m%d%H%M%S)"
    echo "  backed up $f"
}

# ---------------------------------------------------------------- status
installed() { command -v "$1" >/dev/null; }

claude_configured() {
    [[ -f "$CLAUDE_SETTINGS" ]] || return 1
    [[ "$(jq -r '.env.ANTHROPIC_BASE_URL // ""' "$CLAUDE_SETTINGS" 2>/dev/null)" == "http://127.0.0.1:4001" ]] || return 1
    [[ -f "$CATALOG" ]]
}
claude_summary() {
    local up brain vision
    up="$(grep -m1 '^LITELLM_UPSTREAM=' "$ENVFILE" 2>/dev/null | cut -d= -f2-)"
    brain="$(jq -r '.roles.brain // "?"' "$CATALOG" 2>/dev/null)"
    vision="$(jq -r '.roles.vision // ""' "$CATALOG" 2>/dev/null)"
    echo "server $up, brain=$brain${vision:+, vision=$vision}"
}

opencode_configured() { [[ -f "$OC_CONFIG" ]] && jq -e '.provider.upstream' "$OC_CONFIG" >/dev/null 2>&1; }
opencode_searxng_configured() { [[ -f "$OC_CONFIG" ]] && jq -e '.mcp.searxng' "$OC_CONFIG" >/dev/null 2>&1; }
opencode_summary() {
    local url model searxng="no"
    url="$(jq -r '.provider.upstream.options.baseURL // "?"' "$OC_CONFIG" 2>/dev/null)"
    model="$(jq -r '.model // "?"' "$OC_CONFIG" 2>/dev/null)"
    opencode_searxng_configured && searxng="yes"
    echo "server $url, model=$model, searxng=$searxng"
}

omp_configured() { [[ -f "$OMP_MODELS" ]] && grep -q '^  upstream:' "$OMP_MODELS" 2>/dev/null; }
omp_searxng_configured() { [[ -f "$OMP_MCP" ]] && jq -e '.mcpServers.searxng' "$OMP_MCP" >/dev/null 2>&1; }
omp_summary() {
    local url brain searxng="no"
    url="$(grep -m1 'baseUrl:' "$OMP_MODELS" 2>/dev/null | sed 's/.*baseUrl: *//')"
    brain="$(grep -m1 'default:' "$OMP_CONFIG" 2>/dev/null | sed 's/.*default: *//')"
    omp_searxng_configured && searxng="yes"
    echo "server $url, model=$brain, searxng=$searxng"
}

overview() {
    refresh_all_paths   # unconditional, every call — never show stale install status
    echo ""
    e "Native client  ${DIM}(no Docker — Claude Code / OpenCode / OMP)${NC}"
    echo ""
    local curl_s jq_s nvm_s node_s
    curl_s="$(command -v curl >/dev/null && echo "${GREEN}OK${NC}" || echo "${RED}missing${NC}")"
    jq_s="$(command -v jq >/dev/null && echo "${GREEN}OK${NC}" || echo "${RED}missing${NC}")"
    nvm_s="$([[ -s "$HOME/.nvm/nvm.sh" ]] && echo "${GREEN}OK${NC}" || echo "${RED}not installed${NC}")"
    if ! command -v node >/dev/null; then
        node_s="${RED}not installed${NC}"
    elif node_ok_for_searxng; then
        node_s="${GREEN}v$(node -v | tr -d v) OK${NC}"
    else
        node_s="${YELLOW}v$(node -v | tr -d v) — too old for searXNG, needs >=22${NC}"
    fi
    printf "  Requirements: curl %s, jq %s, nvm %s, node %s\n" "$curl_s" "$jq_s" "$nvm_s" "$node_s"
    echo ""
    local name inst conf summary
    for name in claude opencode omp; do
        case "$name" in
            claude)   inst=$(installed claude && echo y || echo n);   conf=$(claude_configured && echo y || echo n) ;;
            opencode) inst=$(installed opencode && echo y || echo n); conf=$(opencode_configured && echo y || echo n) ;;
            omp)      inst=$(installed omp && echo y || echo n);      conf=$(omp_configured && echo y || echo n) ;;
        esac
        local label; case "$name" in claude) label="Claude Code";; opencode) label="OpenCode";; omp) label="OMP";; esac
        local istr="${RED}not installed${NC}"; [[ "$inst" == y ]] && istr="${GREEN}installed${NC}"
        if [[ "$conf" == y ]]; then
            case "$name" in
                claude)   summary="$(claude_summary)" ;;
                opencode) summary="$(opencode_summary)" ;;
                omp)      summary="$(omp_summary)" ;;
            esac
            printf "  %-12s %s  ${DIM}—${NC} configured: %s\n" "$label" "$istr" "$summary"
        else
            printf "  %-12s %s  ${DIM}—${NC} not configured\n" "$label" "$istr"
        fi
        if [[ "$name" == "claude" ]]; then
            local nstr="${RED}NOT installed${NC} — claude-shim.js won't run without it"
            command -v node >/dev/null && nstr="${GREEN}installed${NC}"
            printf "    ${DIM}└─ node (for claude-shim.js, not for claude itself):${NC} %s\n" "$nstr"
        fi
        if [[ "$name" == "opencode" ]] && opencode_searxng_configured && ! node_ok_for_searxng; then
            printf "    ${DIM}└─${NC} ${YELLOW}searxng configured but will fail — node is $(node_version_str), mcp-searxng needs >=22${NC}\n"
        fi
        if [[ "$name" == "omp" ]] && omp_searxng_configured && ! node_ok_for_searxng; then
            printf "    ${DIM}└─${NC} ${YELLOW}searxng configured but will fail — node is $(node_version_str), mcp-searxng needs >=22${NC}\n"
        fi
    done
    echo ""
}

# ---------------------------------------------------------------- install
install_tool() {
    local bin="$1" name="$2" cmd="$3"
    if installed "$bin"; then es "$name is already installed"; return 0; fi
    read -r -p "Install $name now? [y/N]: " ans
    [[ "${ans,,}" == "y" ]] || return 1
    eval "$cmd"
    local path_before="$PATH"
    refresh_path_for "$bin"
    installed "$bin" || { ew "install ran, but '$bin' wasn't found in any known install location — check the installer's own output above"; return 1; }
    if [[ "$PATH" != "$path_before" ]]; then
        ei "  (added to PATH for this session only, so it shows up below right away — a new"
        ei "   shell picks it up on its own via the line the installer added to your shell rc)"
    fi
    es "$name installed"
}

NVM_VERSION="v0.40.7"   # nvm's own installer version, pinned — see nodejs.org/en/download

# Distro `nodejs`/`npm` packages (apt in particular) are routinely years behind — this host's
# apt nodejs is 18.19.1, but mcp-searxng's undici dependency hard-requires >=22 (crashes with
# "File is not defined" below that). So node isn't handled as a distro package at all here:
# install nvm first (nodejs.org's own recommended installer, pinned above), then the current LTS
# release through it, same as nodejs.org's own instructions — this covers both "no node yet" and
# "node too old for searXNG" the same way, and stays current as new LTS lines ship.
install_node_via_nvm() {
    if node_ok_for_searxng; then es "node already OK for searXNG ($(node_version_str))"; return 0; fi
    echo "node: $(node_version_str) — need >=22 (mcp-searxng's requirement; also covers claude-shim.js)"
    read -r -p "Install nvm + current Node LTS + npm via nvm (nodejs.org's own recommended way)? [y/N]: " ans
    [[ "${ans,,}" == "y" ]] || return 1
    export NVM_DIR="$HOME/.nvm"
    if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
        curl -o- "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | bash
    fi
    # shellcheck disable=SC1091
    \. "$NVM_DIR/nvm.sh"
    nvm install --lts
    nvm alias default 'lts/*' >/dev/null 2>&1 || true
    refresh_nvm_node
    if node_ok_for_searxng; then
        es "node $(node -v) / npm $(npm -v) installed via nvm"
        ee ">>> restart your terminal / log out and back in before running opencode/omp/the shim — this session won't see the new node until you do"
    else
        ew "still not >=22 — check the install output above"; return 1
    fi
}

action_install_requirements() {
    echo ""
    echo "Requirements: curl, jq (to run this script), node+npm (for claude-shim.js and for"
    echo "searXNG's 'npx mcp-searxng', which needs Node >=22 specifically)."
    local need=()
    command -v curl >/dev/null || need+=("curl")
    command -v jq   >/dev/null || need+=("jq")
    if [[ ${#need[@]} -gt 0 ]]; then
        echo "Missing: ${need[*]}"
        if command -v apt-get >/dev/null; then
            read -r -p "Install via 'sudo apt-get install -y ${need[*]}'? [y/N]: " ans
            if [[ "${ans,,}" == "y" ]]; then sudo apt-get update && sudo apt-get install -y "${need[@]}"; fi
        elif command -v brew >/dev/null; then
            read -r -p "Install via 'brew install ${need[*]}'? [y/N]: " ans
            if [[ "${ans,,}" == "y" ]]; then brew install "${need[@]}"; fi
        else
            ew "no apt-get or brew found — install manually: ${need[*]}"
        fi
    fi
    command -v curl >/dev/null && es "curl OK" || ew "curl still missing"
    command -v jq   >/dev/null && es "jq OK"   || ew "jq still missing"
    install_node_via_nvm || true
}

action_install() {
    echo ""
    echo "  1) Claude Code"
    echo "  2) OpenCode"
    echo "  3) OMP"
    echo "  4) All not-yet-installed"
    read -r -p "Install which? (numbers like 1,3 or 'all', empty = cancel): " sel
    [[ -n "$sel" ]] || return 0
    case "${sel,,}" in
        all|4)
            installed claude   || install_tool claude   "Claude Code" 'curl -fsSL https://claude.ai/install.sh | bash' || true
            installed opencode || install_tool opencode  "OpenCode"    'curl -fsSL https://opencode.ai/install | bash' || true
            installed omp      || install_tool omp       "OMP"         'curl -fsSL https://omp.sh/install | sh' || true
            ;;
        *)
            [[ "$sel" == *1* ]] && { install_tool claude   "Claude Code" 'curl -fsSL https://claude.ai/install.sh | bash' || true; }
            [[ "$sel" == *2* ]] && { install_tool opencode "OpenCode"    'curl -fsSL https://opencode.ai/install | bash' || true; }
            [[ "$sel" == *3* ]] && { install_tool omp      "OMP"         'curl -fsSL https://omp.sh/install | sh' || true; }
            ;;
    esac
    if [[ "$sel" == *1* || "${sel,,}" == "all" || "$sel" == "4" ]] && ! command -v node >/dev/null; then
        ew "note: Claude Code itself doesn't need node, but this project's claude-shim.js does"
        ew "(it's a plain .js file, not a compiled binary) — install Node.js separately (nodejs.org)"
    fi
}

# ---------------------------------------------------------------- configure (point at a server)
ctx_for_id() {
    local id="$1" i
    for i in "${!ids[@]}"; do [[ "${ids[$i]}" == "$id" ]] && { echo "${ctxs[$i]:-131072}"; return; }; done
    echo "131072"
}

action_configure() {
    # 1. which tool(s) — first, before anything else is asked
    local line_claude line_opencode line_omp
    line_claude="$(installed claude && echo installed || echo "not installed")"
    claude_configured && line_claude="$line_claude — $(claude_summary)"
    line_opencode="$(installed opencode && echo installed || echo "not installed")"
    opencode_configured && line_opencode="$line_opencode — $(opencode_summary)"
    line_omp="$(installed omp && echo installed || echo "not installed")"
    omp_configured && line_omp="$line_omp — $(omp_summary)"

    echo ""
    echo "Which tool do you want to configure?"
    echo "  1) Claude Code   ($line_claude)"
    echo "  2) OpenCode      ($line_opencode)"
    echo "  3) OMP           ($line_omp)"
    echo "  4) All three"
    read -r -p "Choice (numbers like 1,3 or 'all', empty = cancel): " tool_sel
    [[ -n "$tool_sel" ]] || return 0
    local want_claude=false want_opencode=false want_omp=false
    case "${tool_sel,,}" in
        all|4) want_claude=true; want_opencode=true; want_omp=true ;;
        *)
            [[ "$tool_sel" == *1* ]] && want_claude=true
            [[ "$tool_sel" == *2* ]] && want_opencode=true
            [[ "$tool_sel" == *3* ]] && want_omp=true
            ;;
    esac

    # 2. make sure each selected tool is actually usable before asking anything else about it —
    # no point picking a server for a tool you don't have and don't want to install right now.
    if $want_claude && ! installed claude; then
        ew "Claude Code isn't installed."
        install_tool claude "Claude Code" 'curl -fsSL https://claude.ai/install.sh | bash' || want_claude=false
    fi
    if $want_opencode && ! installed opencode; then
        ew "OpenCode isn't installed."
        install_tool opencode "OpenCode" 'curl -fsSL https://opencode.ai/install | bash' || want_opencode=false
    fi
    if $want_omp && ! installed omp; then
        ew "OMP isn't installed."
        install_tool omp "OMP" 'curl -fsSL https://omp.sh/install | sh' || want_omp=false
    fi
    if ! $want_claude && ! $want_opencode && ! $want_omp; then
        ew "nothing left to configure"
        return 0
    fi

    # 3. server address — incl. /v1, matching ../sandbox-client/scripts/model-config.sh's and
    # ../server/model-config.sh's exact convention, defaulting to whichever selected tool already
    # has one configured (so "just checking/re-running" never makes you retype it).
    local default_url=""
    if $want_claude && [[ -f "$ENVFILE" ]]; then
        local up; up="$(grep -m1 '^LITELLM_UPSTREAM=' "$ENVFILE" 2>/dev/null | cut -d= -f2-)"
        [[ -n "$up" ]] && default_url="${up%/}/v1"
    fi
    if [[ -z "$default_url" ]] && $want_opencode && [[ -f "$OC_CONFIG" ]]; then
        default_url="$(jq -r '.provider.upstream.options.baseURL // ""' "$OC_CONFIG" 2>/dev/null)"
    fi
    if [[ -z "$default_url" ]] && $want_omp && [[ -f "$OMP_MODELS" ]]; then
        default_url="$(grep -m1 'baseUrl:' "$OMP_MODELS" 2>/dev/null | sed 's/.*baseUrl: *//')"
    fi

    echo
    local server_url
    if [[ -n "$default_url" ]]; then
        read -r -p "Server address incl. /v1 [$default_url]: " server_url
        server_url="${server_url:-$default_url}"
    else
        read -r -p "Server address incl. /v1 (e.g. http://10.0.0.25:4000/v1; empty = cancel): " server_url
        [[ -n "$server_url" ]] || return 0
    fi
    server_url="${server_url%/}"
    [[ "$server_url" =~ ^https?:// ]] || { ew "must start with http:// or https://"; return 0; }
    [[ "$server_url" == */v1 ]] || { ew "URL should end in /v1 (appending it)"; server_url="$server_url/v1"; }

    # 4. function check — confirm it actually answers and see what it really serves before
    # asking anything else. /model/info (LiteLLM-specific, richer) first, falling back to plain
    # /v1/models for a raw vLLM box — same two-step probe as the other wizards in this repo.
    echo
    echo "Checking $server_url ..."
    ids=(); ctxs=()
    local probe_base="${server_url%/v1}"
    body="$(curl -fsS -m 10 "$probe_base/model/info" 2>/dev/null || true)"
    if [[ -n "$body" ]] && echo "$body" | jq -e '.data' >/dev/null 2>&1; then
        while IFS=$'\t' read -r id ctx; do
            [[ -n "$id" ]] || continue
            ids+=("$id"); ctxs+=("${ctx:-}")
        done < <(echo "$body" | jq -r '.data[]? | [.model_name, (.model_info.max_model_len // "")] | @tsv')
    fi
    if [[ ${#ids[@]} -eq 0 ]]; then
        body="$(curl -fsS -m 10 "$server_url/models" 2>/dev/null || true)"
        while IFS=$'\t' read -r id ctx; do
            [[ -n "$id" ]] || continue
            [[ "$id" == "*" ]] && continue
            ids+=("$id"); ctxs+=("${ctx:-}")
        done < <(echo "$body" | jq -r '.data[]? | [.id, (.max_model_len // "")] | @tsv' 2>/dev/null || true)
    fi
    if [[ ${#ids[@]} -eq 0 ]]; then
        ew "could not find any real models at $server_url"
        ew "if it reported a literal '*', the server's litellm is still the old wildcard placeholder"
        ew "— ask whoever runs it to set up server/config/models.json."
        return 0
    fi
    es "reachable — reports ${#ids[@]} real model(s)"

    # 5. the rest — pick brain/vision, write config for each selected tool
    echo "Models on this server:"
    for i in "${!ids[@]}"; do printf "  %d) %-30s ctx %s\n" "$((i+1))" "${ids[$i]}" "${ctxs[$i]:-?}"; done
    echo

    # "brain" / "vision" are Claude Code concepts only (claude-shim's image-reroute logic) —
    # OpenCode and OMP just get one model, no role concept at all, so don't ask a vision
    # question that would never be used for them.
    local sel brain brain_vision_ans brain_vision vision=""
    local brain_prompt="Which model is your brain (number, required): "
    $want_claude || brain_prompt="Which model do you want to use (number, required): "
    while true; do
        read -r -p "$brain_prompt" sel
        [[ "$sel" =~ ^[0-9]+$ ]] && [[ "$sel" -ge 1 && "$sel" -le ${#ids[@]} ]] && { brain="${ids[$((sel-1))]}"; break; }
        ew "enter a number from the list"
    done
    brain_vision=true
    if $want_claude; then
        read -r -p "Is '$brain' vision-capable? [y/N]: " brain_vision_ans
        brain_vision=false; [[ "${brain_vision_ans,,}" == "y" ]] && brain_vision=true

        if [[ "$brain_vision" == "false" ]]; then
            echo
            echo "Your brain is text-only. Optionally pick a vision-capable model for image requests"
            echo "(leave empty to just drop images with a note instead)."
            read -r -p "Vision model (number, empty = none): " sel
            if [[ -n "$sel" ]]; then
                [[ "$sel" =~ ^[0-9]+$ ]] && [[ "$sel" -ge 1 && "$sel" -le ${#ids[@]} ]] && vision="${ids[$((sel-1))]}"
            fi
        fi
    fi

    # searXNG web search — same MCP server the sandbox wires up (mcp-searxng via npx), but only
    # meaningful for OpenCode/OMP: neither the sandbox nor this script gives Claude Code a search
    # MCP server, so don't ask about it unless one of those two is actually selected.
    local searxng_url=""
    if $want_opencode || $want_omp; then
        # prefer whatever's already configured for a selected tool over a freshly-guessed
        # default, so re-running this against an existing setup doesn't silently change it.
        local searxng_default=""
        if $want_opencode && opencode_searxng_configured; then
            searxng_default="$(jq -r '.mcp.searxng.environment.SEARXNG_URL // ""' "$OC_CONFIG" 2>/dev/null)"
        fi
        if [[ -z "$searxng_default" ]] && $want_omp && omp_searxng_configured; then
            searxng_default="$(jq -r '.mcpServers.searxng.env.SEARXNG_URL // ""' "$OMP_MCP" 2>/dev/null)"
        fi
        local already=""
        [[ -n "$searxng_default" ]] && already=" ${DIM}(already configured)${NC}"
        if [[ -z "$searxng_default" ]]; then
            local host=""
            [[ "$server_url" =~ ^https?://([^/:]+) ]] && host="${BASH_REMATCH[1]}"
            [[ -n "$host" ]] && searxng_default="http://$host:8080"
        fi
        echo
        if [[ -n "$searxng_default" ]]; then
            read -r -p "SearXNG address for web search [$searxng_default]$already (empty = skip): " searxng_url
            searxng_url="${searxng_url:-$searxng_default}"
        else
            read -r -p "SearXNG address for web search (empty = skip): " searxng_url
        fi
        if [[ -n "$searxng_url" ]] && ! node_ok_for_searxng; then
            ew "mcp-searxng needs Node >=22 to start (undici dependency) — node here is"
            ew "$(node_version_str), so it'll be written to config but fail/show 'Disabled' in the tool as-is."
            install_node_via_nvm || true
        fi
    fi

    mkdir -p "$CONFIG_DIR"

    if $want_claude; then
        echo; echo "-- Claude Code --"
        local tmp; tmp="$(mktemp)"
        {
          echo "{"
          echo "  \"servers\": {\"upstream\": {\"url\": \"$server_url\", \"models\": {"
          echo "    \"$brain\": {\"vision\": $brain_vision}"
          if [[ -n "$vision" && "$vision" != "$brain" ]]; then echo "    ,\"$vision\": {\"vision\": true}"; fi
          echo "  }}},"
          echo "  \"roles\": {\"brain\": \"upstream/$brain\"$( [[ -n "$vision" ]] && echo ", \"vision\": \"upstream/$vision\"" )}"
          echo "}"
        } > "$tmp"
        jq '.' "$tmp" > "$CATALOG"; rm -f "$tmp"
        cat > "$ENVFILE" <<EOF
LITELLM_UPSTREAM=$probe_base
MODELS_FILE=$CATALOG
EOF
        echo "  wrote $CATALOG"
        echo "  wrote $ENVFILE"
        mkdir -p "$HOME/.claude"
        backup "$CLAUDE_SETTINGS"
        [[ -f "$CLAUDE_SETTINGS" ]] || echo '{}' > "$CLAUDE_SETTINGS"
        tmp="$(mktemp)"
        jq '.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4001"
          | .env.ANTHROPIC_API_KEY = "dummy"
          | .env.ANTHROPIC_DEFAULT_OPUS_MODEL = "opus"
          | .env.ANTHROPIC_DEFAULT_SONNET_MODEL = "sonnet"
          | .env.ANTHROPIC_DEFAULT_HAIKU_MODEL = "haiku"
          | .env.ANTHROPIC_DEFAULT_FABLE_MODEL = "fable"' \
          "$CLAUDE_SETTINGS" > "$tmp" && mv "$tmp" "$CLAUDE_SETTINGS"
        echo "  merged env vars into $CLAUDE_SETTINGS (existing settings preserved)"
        if ! command -v node >/dev/null; then
            ew "  note: 'node' isn't on PATH — install Node.js before running ./start-claude-code-shim.sh"
        fi
    fi

    if $want_opencode; then
        echo; echo "-- OpenCode --"
        mkdir -p "$HOME/.config/opencode"
        backup "$OC_CONFIG"
        [[ -f "$OC_CONFIG" ]] || echo '{"$schema": "https://opencode.ai/config.json"}' > "$OC_CONFIG"
        local tmp; tmp="$(mktemp)"
        jq --arg url "$server_url" --arg brain "$brain" '
          .provider.upstream = {
            "npm": "@ai-sdk/openai-compatible", "name": "upstream",
            "options": {"baseURL": $url},
            "models": {($brain): {"name": $brain}}
          } | .model = ("upstream/" + $brain)' \
          "$OC_CONFIG" > "$tmp" && mv "$tmp" "$OC_CONFIG"
        echo "  merged provider into $OC_CONFIG (existing settings preserved)"
        if [[ -n "$searxng_url" ]]; then
            tmp="$(mktemp)"
            jq --arg url "$searxng_url" '
              .mcp.searxng = {
                "type": "local", "command": ["npx", "-y", "mcp-searxng"],
                "environment": {"SEARXNG_URL": $url, "SEARXNG_MAX_RESULTS": "10", "SEARXNG_LITE_TOOLS": "true"},
                "enabled": true
              }' "$OC_CONFIG" > "$tmp" && mv "$tmp" "$OC_CONFIG"
            echo "  added searxng MCP server ($searxng_url) to $OC_CONFIG"
        fi
    fi

    if $want_omp; then
        echo; echo "-- OMP --"
        mkdir -p "$HOME/.omp/agent"
        backup "$OMP_MODELS"; backup "$OMP_CONFIG"
        cat > "$OMP_MODELS" <<EOF
providers:
  upstream:
    baseUrl: $server_url
    apiKey: dummy
    api: openai-completions
    auth: apiKey
    models:
      - id: $brain
        name: $brain
        contextWindow: $(ctx_for_id "$brain")
        maxTokens: 16384
        systemPromptSize: 4096
EOF
        cat > "$OMP_CONFIG" <<EOF
modelRoles:
  default: $brain
  slow: $brain
EOF
        echo "  wrote $OMP_MODELS"
        echo "  wrote $OMP_CONFIG (existing settings replaced — OMP config is small, review it if you had one)"
        if [[ -n "$searxng_url" ]]; then
            backup "$OMP_MCP"
            tmp="$(mktemp)"
            jq -n --arg url "$searxng_url" '{
              "mcpServers": {"searxng": {
                "type": "stdio", "command": "npx", "args": ["-y", "mcp-searxng@1.8.0"],
                "env": {"SEARXNG_URL": $url, "SEARXNG_MAX_RESULTS": "10", "SEARXNG_LITE_TOOLS": "true"}
              }}
            }' > "$tmp" && mv "$tmp" "$OMP_MCP"
            echo "  wrote $OMP_MCP ($searxng_url)"
        fi
    fi

    echo
    es "Done."
    $want_claude   && echo "Claude Code: run ./start-claude-code-shim.sh once (keeps claude-shim running), then 'claude' as usual." || true
    $want_opencode && echo "OpenCode: run 'opencode' — model is already selected." || true
    $want_omp      && echo "OMP: run 'omp' — model is already selected." || true
    true
}

# ---------------------------------------------------------------- main menu
while true; do
    overview
    echo "  r) install requirements   i) install a tool         c) configure a tool (point at a server, install searxng mcp)"
    echo "  q) quit"
    read -r -p "Choice: " choice
    case "$choice" in
        r) action_install_requirements ;;
        i) action_install ;;
        c) action_configure ;;
        q) break ;;
        *) ew "unknown choice" ;;
    esac
done

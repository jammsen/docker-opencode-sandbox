#!/usr/bin/env bash
# model-config — interactive model catalog wizard (runs INSIDE the sandbox, entry in the session menu).
#
# Manages ~/.config/models/models.yml (mounted rw from ./config/models): servers, the models you
# picked from each, and the two roles (brain / vision). Every other catalog model stays selectable
# in the tools. Design + flow: ideas/done/model-catalog.md.
#
#   model-config            interactive menu
#   model-config status     one line + exit 0 (configured) / 1 (not configured) — used by agent-session.sh
#   model-config render     regenerate the tool configs from the catalog (also runs after "write")
#
# Edits happen on a scratch copy; nothing touches models.yml until "write & exit".

# Never run as root: same drop path as agent-session.sh / agent-task.
if [[ "${EUID}" -eq 0 ]]; then
    exec /usr/sbin/gosu agent "$0" "$@"
fi
set -euo pipefail

# colors.sh ships in the image at /includes; fall back to plain echo when run elsewhere (tests).
if [[ -f /includes/colors.sh ]]; then
    # shellcheck source=/dev/null
    source /includes/colors.sh
else
    e()  { echo "$*"; }; ei() { echo "$*"; }; ew() { echo "$*"; }; ee() { echo "$*" >&2; }; es() { echo "$*"; }
fi
RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; DIM=$'\033[2m'; NC=$'\033[0m'

CFG_DIR="${MODELS_DIR:-$HOME/.config/models}"
CFG="$CFG_DIR/models.yml"
EXAMPLE="$CFG_DIR/models.example.yml"
WORK=""                                   # scratch copy, set by load_work
PROBE_TIMEOUT="${PROBE_TIMEOUT:-10}"

command -v yq >/dev/null || { ee ">>> yq not found — the sandbox image ships it; is this running inside the container?"; exit 1; }

# ---------------------------------------------------------------- yaml helpers (yq v4, strenv for safety)
_y() { yq "$@" "$WORK"; }                 # read from scratch
_yi() { yq -i "$@" "$WORK"; }             # write to scratch
servers()        { _y -r '.servers // {} | keys | .[]'; }
server_url()     { S="$1" _y -r '.servers[strenv(S)].url // ""'; }
server_models()  { S="$1" _y -r '.servers[strenv(S)].models // {} | keys | .[]'; }
model_field()    { S="$1" M="$2" F="$3" _y -r '.servers[strenv(S)].models[strenv(M)][strenv(F)] // ""'; }
role()           { R="$1" _y -r '.roles[strenv(R)] // ""'; }
all_models()     { local s; for s in $(servers); do local m; for m in $(server_models "$s"); do echo "$s/$m"; done; done; }
model_exists()   { local ref="$1"; all_models | grep -Fx -- "$ref" >/dev/null; }   # no -q: SIGPIPE under pipefail
count_models()   { all_models | wc -l | tr -d ' '; }

# ---------------------------------------------------------------- state
load_work() {
    mkdir -p "$CFG_DIR"
    WORK="$(mktemp "${TMPDIR:-/tmp}/models.XXXXXX.yml")"
    trap 'rm -f "$WORK"' EXIT
    if [[ -s "$CFG" ]]; then
        cp "$CFG" "$WORK"
    else
        printf 'servers: {}\nroles: {}\n' > "$WORK"
    fi
    yq -e '.' "$WORK" >/dev/null 2>&1 || { ee ">>> $CFG is not valid YAML — fix or reset it"; exit 1; }
}

# validate: exit 0 + no output when the catalog is usable; otherwise print reasons.
validate() {
    local ok=0 b v
    b="$(role brain)"; v="$(role vision)"
    if [[ $(count_models) -eq 0 ]]; then echo "no models in the catalog"; ok=1; fi
    if [[ -z "$b" ]]; then echo "role 'brain' is not assigned"; ok=1
    elif ! model_exists "$b"; then echo "role 'brain' -> '$b' does not exist"; ok=1; fi
    # vision is OPTIONAL (none = brain answers everything, images are dropped with a note) but must be able to see
    if [[ -n "$v" ]]; then
        if ! model_exists "$v"; then echo "role 'vision' -> '$v' does not exist"; ok=1
        elif [[ "$(model_field "${v%%/*}" "${v#*/}" vision)" != "true" ]]; then echo "role 'vision' -> '$v' is marked vision: false"; ok=1; fi
    fi
    local u
    for s in $(servers); do
        u="$(server_url "$s")"
        [[ "$u" =~ ^https?://[^[:space:]/]+(/[^[:space:]]*)?$ ]] || { echo "server '$s': url '$u' is not a valid http(s) URL"; ok=1; }
    done
    # every model needs the numeric fields the tools render
    local ref s m f val
    for ref in $(all_models); do
        s="${ref%%/*}"; m="${ref#*/}"
        for f in context max_tokens; do
            val="$(model_field "$s" "$m" "$f")"
            [[ "$val" =~ ^[0-9]+$ ]] || { echo "$ref: '$f' must be a number (is '$val')"; ok=1; }
        done
    done
    # duplicate ids across servers -> the alias becomes server/id; just warn
    all_models | awk -F/ '{print $2}' | sort | uniq -d | while read -r dup; do
        [[ -n "$dup" ]] && echo "note: model id '$dup' exists on more than one server — its alias will be <server>/$dup"
    done
    return $ok
}

# ---------------------------------------------------------------- display
overview() {
    local s n url mark b v i=0
    b="$(role brain)"; v="$(role vision)"
    echo ""
    e "Model configuration  ${DIM}($CFG)${NC}"
    echo ""
    echo "Servers"
    if [[ -z "$(servers)" ]]; then
        echo "  ${DIM}(none)${NC}"
    fi
    for s in $(servers); do
        i=$((i+1)); url="$(server_url "$s")"; n="$(server_models "$s" | wc -l | tr -d ' ')"; mark=""
        [[ "$b" == "$s/"* ]] && mark+=" ${GREEN}[brain]${NC}"
        [[ "$v" == "$s/"* ]] && mark+=" ${GREEN}[vision]${NC}"
        printf "  %d) %-14s %-36s %s model(s)%s\n" "$i" "$s" "$url" "$n" "$mark"
        local m
        for m in $(server_models "$s"); do
            local vis=""
            [[ "$(model_field "$s" "$m" vision)" == "true" ]] && vis=" vision"
            printf "       - %-28s %-26s ctx %-8s max %-6s${DIM}%s${NC}\n" "$m" "$(model_field "$s" "$m" name)" \
                "$(model_field "$s" "$m" context)" "$(model_field "$s" "$m" max_tokens)" "$vis"
        done
    done
    echo ""
    echo "Roles"
    printf "  brain  = %s\n" "${b:-${RED}(unassigned)${NC}}"
    printf "  vision = %s\n" "${v:-${DIM}(none — images will be dropped with a note; analyze-image disabled)${NC}}"
    echo ""
    local problems
    if problems="$(validate)"; then
        [[ -n "$problems" ]] && echo "${YELLOW}$problems${NC}"
    else
        echo "${RED}Not usable yet:${NC}"; echo "$problems" | sed "s/^/  ${RED}- /; s/$/${NC}/"
    fi
    echo ""
}

# ---------------------------------------------------------------- pickers
# pick_server -> echoes server name or "" (cancel)
pick_server() {
    local list=() s i
    for s in $(servers); do list+=("$s"); done
    [[ ${#list[@]} -gt 0 ]] || { ew "No servers yet." >&2; echo ""; return 0; }
    for i in "${!list[@]}"; do echo "  $((i+1))) ${list[$i]}  $(server_url "${list[$i]}")" >&2; done
    local sel; read -r -p "Server number (empty = cancel): " sel
    if [[ "$sel" =~ ^[0-9]+$ ]] && [[ $sel -ge 1 && $sel -le ${#list[@]} ]]; then echo "${list[$((sel-1))]}"; else echo ""; fi
}

# pick_model [vision] [none] -> echoes "server/id", "none" (if allowed and chosen) or "" (cancel/keep).
# "vision" lists vision-capable models first (all models if there is none); "none" adds an n) entry.
pick_model() {
    local only_vision="${1:-}" allow_none="${2:-}" list=() ref i s m
    for ref in $(all_models); do
        s="${ref%%/*}"; m="${ref#*/}"
        if [[ "$only_vision" == "vision" && "$(model_field "$s" "$m" vision)" != "true" ]]; then continue; fi
        list+=("$ref")
    done
    if [[ ${#list[@]} -eq 0 && "$only_vision" == "vision" ]]; then
        ew "No vision-capable model in the catalog (mark one with vision=yes when adding it)." >&2
        [[ -n "$allow_none" ]] || { echo ""; return 0; }
    elif [[ ${#list[@]} -eq 0 ]]; then
        ew "No matching models in the catalog." >&2; echo ""; return 0
    fi
    for i in "${!list[@]}"; do
        s="${list[$i]%%/*}"; m="${list[$i]#*/}"
        local vis=""; [[ "$(model_field "$s" "$m" vision)" == "true" ]] && vis=" ${DIM}(vision)${NC}"
        echo "  $((i+1))) ${list[$i]}  — $(model_field "$s" "$m" name)$vis" >&2
    done
    [[ -n "$allow_none" ]] && echo "  n) none" >&2
    local sel; read -r -p "Model number (empty = keep current): " sel
    if [[ -n "$allow_none" && "${sel,,}" == "n" ]]; then echo "none"
    elif [[ "$sel" =~ ^[0-9]+$ ]] && [[ $sel -ge 1 && $sel -le ${#list[@]} ]]; then echo "${list[$((sel-1))]}"; else echo ""; fi
}

# ---------------------------------------------------------------- probing + adding models
# probe_models <url> -> lines "id<TAB>max_model_len" ; returns 1 on failure
probe_models() {
    local url="$1" body
    body="$(curl -fsS -m "$PROBE_TIMEOUT" "$url/models" 2>/dev/null)" || return 1
    echo "$body" | jq -r '.data[]? | [.id, (.max_model_len // "")] | @tsv' 2>/dev/null
}

# add_models_from_server <server> [preselected-ids...]: probe (or manual), multi-select, per-model details
add_models_from_server() {
    local s="$1" url ids=() ctxs=() line
    url="$(server_url "$s")"
    ei "Looking up models on $url/models ..."
    local probed=0
    if probed_out="$(probe_models "$url")" && [[ -n "$probed_out" ]]; then
        probed=1
        while IFS=$'\t' read -r id ctx; do
            [[ -n "$id" ]] || continue
            ids+=("$id"); ctxs+=("${ctx:-}")
        done <<< "$probed_out"
    else
        ew "Could not list models from $url (unreachable, or not an OpenAI-compatible /v1)."
        local ans; read -r -p "Enter model ids by hand instead? [y/N]: " ans
        [[ "${ans,,}" == "y" ]] || return 0
        local manual; read -r -p "Model ids (space-separated): " manual
        for id in $manual; do ids+=("$id"); ctxs+=(""); done
    fi
    [[ ${#ids[@]} -gt 0 ]] || { ew "No models to add."; return 0; }

    echo ""; echo "Models on $s:"
    local i already
    for i in "${!ids[@]}"; do
        already=""; server_models "$s" | grep -Fx -- "${ids[$i]}" >/dev/null && already=" ${DIM}(already in catalog)${NC}"
        printf "  %d) %-40s ctx %s%s\n" "$((i+1))" "${ids[$i]}" "${ctxs[$i]:-?}" "$already"
    done
    echo ""
    local sel; read -r -p "Add which? (numbers like 1,3  |  all  |  empty = none): " sel
    [[ -n "$sel" ]] || return 0
    local chosen=()
    if [[ "${sel,,}" == "all" ]]; then chosen=("${!ids[@]}")
    else
        IFS=', ' read -ra parts <<< "$sel"
        for p in "${parts[@]}"; do
            [[ "$p" =~ ^[0-9]+$ ]] && [[ $p -ge 1 && $p -le ${#ids[@]} ]] && chosen+=("$((p-1))") || ew "ignoring '$p'"
        done
    fi
    for i in "${chosen[@]}"; do
        add_model_details "$s" "${ids[$i]}" "${ctxs[$i]}"
    done
    [[ $probed -eq 1 ]] || ew "Manually entered ids were not verified against the server."
}

# add_model_details <server> <id> <ctx-default>: asks the curated facts and stores the model
add_model_details() {
    local s="$1" id="$2" ctx_def="$3" name ctx maxtok vis ans
    echo ""; e "Model ${GREEN}$id${NC} on $s"
    read -r -p "  Display name [$id]: " name; name="${name:-$id}"
    while true; do
        read -r -p "  Context window (tokens) [${ctx_def:-required}]: " ctx; ctx="${ctx:-$ctx_def}"
        [[ "$ctx" =~ ^[0-9]+$ ]] && break; ew "  number please"
    done
    while true; do
        read -r -p "  Max completion tokens [16384]: " maxtok; maxtok="${maxtok:-16384}"
        [[ "$maxtok" =~ ^[0-9]+$ ]] && break; ew "  number please"
    done
    read -r -p "  Can it see images (vision)? [y/N]: " ans; vis=false; [[ "${ans,,}" == "y" ]] && vis=true
    # No "fuses reasoning" question: every model is routed through the reasoning-normalizer, whose
    # delta split is a no-op for models that don't need it — nothing to configure.
    S="$s" M="$id" N="$name" C="$ctx" T="$maxtok" V="$vis" _yi \
        '.servers[strenv(S)].models[strenv(M)] = {"name": strenv(N), "context": (strenv(C)|tonumber), "max_tokens": (strenv(T)|tonumber), "vision": (strenv(V)=="true")}'
    es "  added $s/$id"
}

# ---------------------------------------------------------------- menu actions
action_add_server() {
    local name url
    while true; do
        read -r -p "Server name (short, e.g. spark-brain; empty = cancel): " name
        [[ -n "$name" ]] || return 0
        [[ "$name" =~ ^[a-zA-Z0-9_-]+$ ]] || { ew "letters, digits, - and _ only"; continue; }
        if servers | grep -Fx -- "$name" >/dev/null; then ew "'$name' exists — use edit"; continue; fi
        break
    done
    while true; do
        read -r -p "OpenAI-compatible base URL incl. /v1 (e.g. http://10.0.0.25:8888/v1): " url
        [[ -n "$url" ]] || return 0
        url="${url%/}"
        [[ "$url" =~ ^https?:// ]] || { ew "must start with http:// or https://"; continue; }
        [[ "$url" == */v1 ]] || { ew "URL should end in /v1 (appending it)"; url="$url/v1"; }
        break
    done
    S="$name" U="$url" _yi '.servers[strenv(S)] = {"url": strenv(U), "models": {}}'
    es "server $name added"
    add_models_from_server "$name"
}

action_edit_server() {
    local s; s="$(pick_server)"; [[ -n "$s" ]] || return 0
    echo ""; echo "Edit $s ($(server_url "$s"))"
    echo "  1) look up models on the server / add more"
    echo "  2) remove a model"
    echo "  3) change URL (then looks up models on the new URL)"
    echo "  4) rename server"
    local c; read -r -p "Choice (empty = back): " c
    case "$c" in
        1) add_models_from_server "$s" ;;
        2)  local list=() m i
            for m in $(server_models "$s"); do list+=("$m"); done
            [[ ${#list[@]} -gt 0 ]] || { ew "no models on $s"; return 0; }
            for i in "${!list[@]}"; do echo "  $((i+1))) ${list[$i]}"; done
            local sel; read -r -p "Remove which? (empty = cancel): " sel
            if [[ "$sel" =~ ^[0-9]+$ ]] && [[ $sel -ge 1 && $sel -le ${#list[@]} ]]; then
                m="${list[$((sel-1))]}"
                S="$s" M="$m" _yi 'del(.servers[strenv(S)].models[strenv(M)])'
                clear_roles_pointing_at "$s/$m"
                es "removed $s/$m"
            fi ;;
        3)  local url; read -r -p "New base URL: " url; url="${url%/}"
            [[ -n "$url" ]] || return 0
            [[ "$url" =~ ^https?:// ]] || { ew "must start with http:// or https://"; return 0; }
            [[ "$url" == */v1 ]] || { ew "URL should end in /v1 (appending it)"; url="$url/v1"; }
            S="$s" U="$url" _yi '.servers[strenv(S)].url = strenv(U)'; es "url updated"
            # A new URL usually means a different box: the kept models may not exist there.
            local n; n="$(server_models "$s" | wc -l | tr -d ' ')"
            if [[ "$n" -gt 0 ]]; then
                ew "$n model(s) are still listed for $s — verify they exist on the new server (remove with 2) if not)."
            fi
            add_models_from_server "$s" ;;
        4)  local new
            while true; do
                read -r -p "New name for '$s' (empty = cancel): " new
                [[ -n "$new" ]] || return 0
                [[ "$new" =~ ^[a-zA-Z0-9_-]+$ ]] || { ew "letters, digits, - and _ only"; continue; }
                if servers | grep -Fx -- "$new" >/dev/null; then ew "'$new' exists"; continue; fi
                break
            done
            # with_entries keeps the server at its position (a plain add+delete would move it last)
            O="$s" N="$new" _yi '.servers |= with_entries(.key |= (select(. == strenv(O)) = strenv(N) // .))'
            local r
            for r in brain vision; do
                if [[ "$(role "$r")" == "$s/"* ]]; then
                    R="$r" V="$new/$(role "$r" | cut -d/ -f2-)" _yi '.roles[strenv(R)] = strenv(V)'
                fi
            done
            es "renamed $s -> $new (roles updated)" ;;
        *) ;;
    esac
}

action_delete_server() {
    local s; s="$(pick_server)"; [[ -n "$s" ]] || return 0
    local ans; read -r -p "Delete server '$s' and its models? [y/N]: " ans
    [[ "${ans,,}" == "y" ]] || return 0
    local m; for m in $(server_models "$s"); do clear_roles_pointing_at "$s/$m"; done
    S="$s" _yi 'del(.servers[strenv(S)])'
    es "deleted $s"
}

clear_roles_pointing_at() {
    local ref="$1" r
    for r in brain vision; do
        if [[ "$(role "$r")" == "$ref" ]]; then
            R="$r" _yi 'del(.roles[strenv(R)])'; ew "role $r pointed at $ref — unassigned"
        fi
    done
}

action_assign_roles() {
    [[ $(count_models) -gt 0 ]] || { ew "No models in the catalog yet — add a server and pick models first."; return 0; }
    echo ""; e "Brain — the primary (text) model:"
    local b; b="$(pick_model)"; [[ -n "$b" ]] || return 0
    model_exists "$b" || { ew "'$b' is not a catalog model"; return 0; }
    R=brain V="$b" _yi '.roles[strenv(R)] = strenv(V)'; es "brain = $b"
    echo ""; e "Vision — handles image requests (may be the brain itself if it can see; optional):"
    local bs="${b%%/*}" bm="${b#*/}"
    if [[ "$(model_field "$bs" "$bm" vision)" == "true" ]]; then
        local ans; read -r -p "Brain can see — use it as vision too? [Y/n]: " ans
        if [[ "${ans:-y}" =~ ^[yY]$ ]]; then R=vision V="$b" _yi '.roles[strenv(R)] = strenv(V)'; es "vision = $b"; return 0; fi
    fi
    local v; v="$(pick_model vision none)"
    case "$v" in
        none) R=vision _yi 'del(.roles[strenv(R)])'; ew "vision = none — images will be dropped with a note, analyze-image disabled"; return 0 ;;
        "")   echo "vision unchanged"; return 0 ;;
    esac
    model_exists "$v" || { ew "'$v' is not a catalog model"; return 0; }
    R=vision V="$v" _yi '.roles[strenv(R)] = strenv(V)'; es "vision = $v"
}

action_reset() {
    ew "This discards the WHOLE catalog (a backup is kept next to it)."
    local ans; read -r -p "Type 'reset' to confirm: " ans
    [[ "$ans" == "reset" ]] || { echo "not reset"; return 0; }
    echo "  1) start empty"
    [[ -f "$EXAMPLE" ]] && echo "  2) start from models.example.yml"
    local c; read -r -p "Choice [1]: " c
    if [[ "${c:-1}" == "2" && -f "$EXAMPLE" ]]; then cp "$EXAMPLE" "$WORK"; else printf 'servers: {}\nroles: {}\n' > "$WORK"; fi
    RESET_PENDING=1
    es "catalog reset in the scratch copy — 'w' to make it real"
}

action_show_effective() {
    echo ""; e "What the tools will see after 'w':"
    local b v; b="$(role brain)"; v="$(role vision)"
    echo "  brain / opus / fable / claude-*   -> ${b:-${RED}unassigned${NC}}"
    echo "  vision / sonnet / haiku           -> ${v:-${DIM}(none -> brain; images dropped)${NC}}"
    echo "  selectable in every tool (Claude Code /model <alias>, opencode, omp):"
    local ref s m alias
    for ref in $(all_models); do
        s="${ref%%/*}"; m="${ref#*/}"
        alias="$m"; [[ $(all_models | awk -F/ -v id="$m" '$2==id' | wc -l) -gt 1 ]] && alias="$ref"
        printf "    %-34s %s  ctx %s\n" "$alias" "$(server_url "$s")" "$(model_field "$s" "$m" context)"
    done
    echo ""
}

action_write() {
    local problems
    if ! problems="$(validate)"; then
        # Writing an unusable catalog is allowed on purpose (e.g. after RESET, to start fresh): the
        # session menu turns red and blocks sessions until brain+vision exist, and the gateway
        # answers "run the model configuration" — nothing silently keeps using the old setup.
        echo "${RED}This catalog is not usable yet:${NC}"; echo "$problems" | sed 's/^/  - /'
        local ans; read -r -p "Write it anyway? Sessions stay blocked until it is fixed [y/N]: " ans
        [[ "${ans,,}" == "y" ]] || { echo "not written"; return 1; }
    elif [[ -n "$problems" ]]; then
        echo "${YELLOW}$problems${NC}"
    fi
    local bak=""
    if [[ -s "$CFG" ]]; then
        bak="$CFG.bak-$(date +%Y%m%d-%H%M%S)"; cp "$CFG" "$bak"; ei "previous catalog kept as $(basename "$bak")"
    fi
    cp "$WORK" "$CFG"; chmod 644 "$CFG"
    es "written: $CFG"
    render || { ew "render failed — restoring the previous catalog"; [[ -n "${bak:-}" ]] && cp "$bak" "$CFG" && render >/dev/null 2>&1; return 1; }
    return 0
}

# ---------------------------------------------------------------- render (tool configs from the catalog)
# Regenerates what the tools inside the sandbox read. The gateway side (litellm -> normalizer)
# reads models.yml itself, so nothing outside the sandbox needs a restart.
render() {
    if [[ -x /usr/local/bin/render-models ]]; then
        /usr/local/bin/render-models
    else
        ew "render-models not installed yet — tool configs not regenerated (plumbing step pending)"
    fi
}

# ---------------------------------------------------------------- entry
cmd="${1:-menu}"
case "$cmd" in
    status)
        load_work
        if problems="$(validate 2>/dev/null)"; then
            b="$(role brain)"; v="$(role vision)"
            echo "models: brain=$b vision=${v:-none} ($(count_models) in catalog)"; exit 0
        else
            echo "${RED}No usable model configuration${NC} — $(echo "$problems" | head -1)"; exit 1
        fi ;;
    render) load_work; render ;;
    menu) ;;
    *) ee "usage: model-config [status|render]"; exit 2 ;;
esac

load_work
RESET_PENDING=0
while true; do
    overview
    echo "  a) add server        e) edit server        d) delete server"
    echo "  r) assign roles      s) show effective config"
    echo "  R) RESET catalog     w) write & exit       q) quit without saving"
    if [[ $(count_models) -eq 0 && -f "$EXAMPLE" ]]; then
        echo "  x) start from models.example.yml (the shipped two-Spark example) — first run helper"
    fi
    echo ""
    read -r -p "Choice: " choice
    case "$choice" in
        x) if [[ -f "$EXAMPLE" ]]; then cp "$EXAMPLE" "$WORK"; es "loaded models.example.yml into the scratch copy — check servers/URLs, then 'w'"; else ew "no example file"; fi ;;
        a) action_add_server ;;
        e) action_edit_server ;;
        d) action_delete_server ;;
        r) action_assign_roles ;;
        s) action_show_effective ;;
        R) action_reset ;;
        w) if action_write; then exit 0; fi ;;
        q) if ! cmp -s "$WORK" "$CFG" 2>/dev/null; then
               read -r -p "Discard unsaved changes? [y/N]: " ans; [[ "${ans,,}" == "y" ]] || continue
           fi
           exit 0 ;;
        *) ew "unknown choice '$choice'" ;;
    esac
done

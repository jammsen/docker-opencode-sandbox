#!/usr/bin/env bash
# render-models — turn the model catalog (~/.config/models/models.yml) into what the tools read.
#
# Runs at container start (entrypoint, as root -> files chowned to agent) and after every "write" in
# the model-config wizard (as agent). Outputs, all derived from the catalog + the mounted templates:
#   ~/.config/models/models.json         catalog as JSON — read by claude-shim (sandbox) and the
#                                        reasoning-normalizer (gateway container, same dir mounted ro)
#   ~/.config/opencode/opencode.json     template + one provider per server, all its models; default = brain;
#                                        SEARXNG_URL substituted into its mcp.searxng entry
#   ~/.omp/agent/models.yml              template + one provider per server, all its models
#   ~/.omp/agent/config.yml              template + modelRoles/context from the brain
# Claude Code needs nothing rendered: its settings use the fixed aliases (opus/sonnet/haiku/fable)
# that the normalizer resolves. Design: ideas/model-catalog-configurator.md.
set -euo pipefail

APP_HOME="${APP_HOME:-/home/agent}"
MODELS_DIR="${MODELS_DIR:-$APP_HOME/.config/models}"
CATALOG="$MODELS_DIR/models.yml"
TPL="${TEMPLATE_DIR:-$APP_HOME/.config/templates}"
OWNER="${APP_USER:-agent}:${APP_GROUP:-agent}"

if [[ -f /includes/colors.sh ]]; then
    # shellcheck source=/dev/null
    source /includes/colors.sh
else
    e() { echo "$*"; }; ew() { echo "$*"; }; ee() { echo "$*" >&2; }
fi

[[ -s "$CATALOG" ]] || { ew "> render-models: no catalog at $CATALOG — nothing rendered (run the model configuration)"; exit 0; }
command -v yq >/dev/null || { ee ">>> render-models: yq missing"; exit 1; }

# install <tmpfile> <dst>: 644, owned by agent even when run as root (chmod before chown: no CAP_FOWNER)
_install() {
    local src="$1" dst="$2"
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst.tmp" && chmod 644 "$dst.tmp" && mv -f "$dst.tmp" "$dst"   # rename = readers never see a partial file
    if [[ "$EUID" -eq 0 ]]; then chown "$OWNER" "$dst" "$(dirname "$dst")" 2>/dev/null || true; fi
    e "> Rendered $(basename "$dst") from the model catalog"
}
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# 1) models.json — the machine-readable twin of the yaml. ALWAYS written, even for an unusable
#    catalog (e.g. right after RESET): the gateway must see the emptied catalog, not keep routing
#    on the previous one.
yq -o json '.' "$CATALOG" > "$tmp/models.json"
_install "$tmp/models.json" "$MODELS_DIR/models.json"

brain="$(yq -r '.roles.brain // ""' "$CATALOG")"
[[ -n "$brain" ]] || { ew "> render-models: no brain role in $CATALOG — tool configs not rendered (session menu stays blocked)"; exit 0; }
bsrv="${brain%%/*}"; bid="${brain#*/}"
bctx="$(S="$bsrv" M="$bid" yq -r '.servers[strenv(S)].models[strenv(M)].context // 0' "$CATALOG")"
bmax="$(S="$bsrv" M="$bid" yq -r '.servers[strenv(S)].models[strenv(M)].max_tokens // 16384' "$CATALOG")"

# 2) opencode.json — providers keyed by server name; model = "<server>/<id>" is opencode's own format
if [[ -f "$TPL/opencode.json" ]]; then
    yq -o json '
      .servers | to_entries | map({"key": .key, "value": {
        "npm": "@ai-sdk/openai-compatible", "name": .key,
        "options": {"baseURL": .value.url},
        "models": ((.value.models // {}) | to_entries | map({"key": .key, "value": {
            "name": .value.name, "limit": {"context": .value.context, "output": .value.max_tokens},
            "options": {"preserve_thinking": false}}}) | from_entries)
      }}) | from_entries' "$CATALOG" > "$tmp/providers.json"
    jq --slurpfile prov "$tmp/providers.json" --arg model "$brain" --argjson max "$bmax" \
       --arg searxng "${SEARXNG_URL:?SEARXNG_URL not set}" \
       '.provider = $prov[0] | .model = $model | .agent.build.maxTokens = $max
        | .mcp.searxng.environment.SEARXNG_URL = $searxng' \
       "$TPL/opencode.json" > "$tmp/opencode.json"
    _install "$tmp/opencode.json" "$APP_HOME/.config/opencode/opencode.json"
fi

# 3) omp models.yml — providers keyed by server name
if [[ -f "$TPL/omp-models.yml" ]]; then
    yq '
      .servers | to_entries | map({"key": .key, "value": {
        "baseUrl": .value.url, "apiKey": "dummy", "api": "openai-completions", "auth": "apiKey",
        "models": ((.value.models // {}) | to_entries | map({
            "id": .key, "name": .value.name, "contextWindow": .value.context,
            "maxTokens": .value.max_tokens, "systemPromptSize": 4096}))
      }}) | from_entries' "$CATALOG" > "$tmp/providers.yml"
    P="$tmp/providers.yml" yq '.providers = load(strenv(P))' "$TPL/omp-models.yml" > "$tmp/omp-models.yml"
    _install "$tmp/omp-models.yml" "$APP_HOME/.omp/agent/models.yml"
fi

# 4) omp config.yml — default/slow role = brain, context budget = brain context
if [[ -f "$TPL/omp-config.yml" ]]; then
    B="$brain" C="$bctx" yq '.modelRoles.default = strenv(B) | .modelRoles.slow = strenv(B) | .context.maxTokens = (strenv(C)|tonumber)' \
        "$TPL/omp-config.yml" > "$tmp/omp-config.yml"
    _install "$tmp/omp-config.yml" "$APP_HOME/.omp/agent/config.yml"
fi

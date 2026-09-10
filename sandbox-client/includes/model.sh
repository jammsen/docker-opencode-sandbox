# Model configuration — derived from the catalog (~/.config/models/models.yml, managed by the
# model-config wizard in the session menu). Nothing here is fatal: without a catalog the session
# menu shows the wizard in red and gates the tools; the gateway (litellm -> reasoning-normalizer)
# reads the catalog itself, so no MODEL_* env contract exists any more.

setup_model_env() {
    local catalog="$APP_HOME/.config/models/models.yml" brain vision
    if [[ ! -s "$catalog" ]]; then
        ew "> No model catalog at $catalog yet — run 'model configuration' from the session menu"
        return 0
    fi
    brain="$(yq -r '.roles.brain // ""' "$catalog")"
    vision="$(yq -r '.roles.vision // ""' "$catalog")"
    if [[ -z "$brain" ]]; then
        ew "> Model catalog has no brain assigned yet — run 'model configuration' from the session menu"
        return 0
    fi
    # analyze-image.js (upload companion) talks to the vision server directly; vision is optional.
    if [[ -n "$vision" ]]; then
        local vs="${vision%%/*}" vid="${vision#*/}"
        export VISION_MODEL_URL VISION_MODEL_ID
        VISION_MODEL_URL="$(S="$vs" yq -r '.servers[strenv(S)].url' "$catalog")"
        VISION_MODEL_ID="$vid"
    fi
    ei "> Model catalog: brain='$brain' vision='${vision:-none}' ($(yq -r '[.servers[].models | keys | .[]] | length' "$catalog") models in catalog)"
}

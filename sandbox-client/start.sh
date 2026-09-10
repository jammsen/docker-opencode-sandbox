#!/usr/bin/env bash
set -euo pipefail

DEFAULT_TOOL=""
BUILD_ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --tool)
            if [[ -n "${2:-}" ]]; then
                DEFAULT_TOOL="$2"
                shift 2
            else
                echo "Error: --tool requires a tool name argument" >&2
                exit 1
            fi
            ;;
        *)
            BUILD_ARGS+=("$1")
            shift
            ;;
    esac
done

docker compose build "${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}"

# Stop any existing container before starting fresh
if docker ps -aq --filter "name=agentic-harness-sandbox" | grep -q .; then
    echo "> Stopping existing sandbox container..."
    docker compose down
fi

# DEFAULT_TOOL is picked up by compose.yml via ${DEFAULT_TOOL:-} passthrough.
# If set, the browser session skips the tool-selection menu.
if [[ -n "$DEFAULT_TOOL" ]]; then
    DEFAULT_TOOL="$DEFAULT_TOOL" docker compose up -d
else
    docker compose up -d
fi

echo ""
echo "> Sandbox running. Open in your browser (accept the self-signed cert warning once):"
echo ">   https://$(hostname -I | awk '{print $1}'):1111"
echo ""
echo "> Logs: docker compose logs -f"
echo "> Stop: docker compose down"

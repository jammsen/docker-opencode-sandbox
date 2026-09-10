#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ASSUME_YES=false
CONFIRMATION="Yes, do as I say!"

usage() {
  cat <<'USAGE'
Usage: scripts/reset-sandbox.sh [options]

Reset all generated sandbox state from:
  - workspace/
  - data/

The script preserves:
  - workspace/.gitkeep
  - data/.gitkeep

Options:
  --destroy     Run without the interactive confirmation prompt.
  -h, --help    Show this help message.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --destroy)
      ASSUME_YES=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

confirm_reset() {
  if [[ "$ASSUME_YES" == "true" ]]; then
    return
  fi

  cat <<EOF
This will delete all generated OpenCode sandbox state under:
  $ROOT_DIR/workspace/
  $ROOT_DIR/data/

All .gitkeep placeholder files will be preserved (e.g. workspace/.gitkeep,
  data/.gitkeep, workspace/uploads/.gitkeep, and any other nested .gitkeep files).

As this is a destructive operation, this cannot be undone!
EOF

  read -r -p "Type '${CONFIRMATION}' to proceed: " answer
  if [[ "$answer" != "$CONFIRMATION" ]]; then
    echo "Sandbox reset cancelled."
    exit 0
  fi
}

clean_dir() {
  local dir="$1"
  mkdir -p "$dir"

  # Collect all .gitkeep paths before touching anything
  mapfile -t keeps < <(find "$dir" -name '.gitkeep' 2>/dev/null)

  # Delete only top-level entries (rm -rf handles subtrees); avoids find
  # trying to descend into dirs it already removed via a prior rm -rf.
  find "$dir" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

  # Recreate every .gitkeep and its parent directory
  for f in "${keeps[@]}"; do
    mkdir -p "$(dirname "$f")"
    touch "$f"
  done

  # Guarantee at least the root .gitkeep exists even if none were found
  touch "$dir/.gitkeep"
}

confirm_reset
clean_dir "$ROOT_DIR/workspace"
clean_dir "$ROOT_DIR/data"

echo "Reset workspace/ and data/ while preserving .gitkeep files."

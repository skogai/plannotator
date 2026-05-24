#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: remove-opencode-plannotator.sh [--dry-run] [--help]

Removes Plannotator's OpenCode slash commands and cached plugin packages.

Options:
  --dry-run   Show what would be removed without deleting anything
  -h, --help  Show this help and exit
EOF
}

dry_run=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

xdg_config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
xdg_cache_home="${XDG_CACHE_HOME:-$HOME/.cache}"
bun_cache_home="${BUN_INSTALL_CACHE_DIR:-$HOME/.bun/install/cache}"

paths=(
  "$xdg_config_home/opencode/command/plannotator-review.md"
  "$xdg_config_home/opencode/command/plannotator-annotate.md"
  "$xdg_config_home/opencode/command/plannotator-last.md"
  "$xdg_config_home/opencode/command/plannotator-archive.md"
  "$xdg_config_home/opencode/commands/plannotator-review.md"
  "$xdg_config_home/opencode/commands/plannotator-annotate.md"
  "$xdg_config_home/opencode/commands/plannotator-last.md"
  "$xdg_config_home/opencode/commands/plannotator-archive.md"
  "$xdg_cache_home/opencode/node_modules/@plannotator"
  "$xdg_cache_home/opencode/packages/@plannotator"
  "$bun_cache_home/@plannotator"
)

echo "OpenCode Plannotator cleanup"
echo ""

removed_any=0

for target in "${paths[@]}"; do
  if [ -e "$target" ] || [ -L "$target" ]; then
    removed_any=1
    if [ "$dry_run" -eq 1 ]; then
      echo "Would remove: $target"
    else
      rm -rf "$target"
      echo "Removed: $target"
    fi
  else
    echo "Not found: $target"
  fi
done

echo ""

if [ "$dry_run" -eq 1 ]; then
  echo "Dry run complete."
elif [ "$removed_any" -eq 1 ]; then
  echo "OpenCode Plannotator cleanup complete."
else
  echo "No matching Plannotator OpenCode paths were found."
fi

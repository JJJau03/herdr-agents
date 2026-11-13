#!/usr/bin/env bash
# Installs only into unused names. Existing mods, layouts, keys and settings are never replaced.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
layout="$APP_HOME/layouts/herdr-agents.json"

# Check everything before making changes, including dangling symlinks.
conflict=0
targets=("$layout")
for source in "$ROOT"/mods/*/; do targets+=("$APP_HOME/mods/$(basename "$source")"); done
for target in "${targets[@]}"; do
  if [[ -e "$target" || -L "$target" ]]; then
    printf 'Already exists: %s\n' "$target" >&2
    conflict=1
  fi
done
if (( conflict )); then
  echo 'Nothing installed. Choose a clean HERDR_APP_HOME or resolve the name conflicts manually; do not overwrite existing mods.' >&2
  exit 1
fi
mkdir -p "$APP_HOME/layouts" "$APP_HOME/mods"
cp -n "$ROOT/layouts/herdr-agents.json" "$layout"
for source in "$ROOT"/mods/*/; do
  name="$(basename "$source")"
  # mkdir fails instead of merging if a destination appears after the preflight.
  mkdir "$APP_HOME/mods/$name"
  cp -R "$source". "$APP_HOME/mods/$name/"
done
printf 'Installed in %s\n' "$APP_HOME"
echo 'Existing keys, programs, settings and active layout were not changed.'
echo 'Check the mods, then select herdr-agents in Herdr when ready.'

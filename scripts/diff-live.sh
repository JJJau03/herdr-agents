#!/usr/bin/env bash
# What the repo ships vs what actually runs in ~/.config/herdr-app (HERDR_APP_HOME). Walks the repo's files only,
# so live-only files (gpui-kit.d.ts, backups, built-in mods) are ignored. Exit 1 on any difference or missing file.
#   scripts/diff-live.sh          list differing / missing files
#   scripts/diff-live.sh -d       also print the diffs
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
LIVE="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
show=0; [ "${1:-}" = "-d" ] && show=1

bad=0
while IFS= read -r f; do
  case "$f" in mods/*|layouts/*|keys.json|programs.json|icons/*) ;; *) continue ;; esac
  # Include new working-tree files and skip tracked files removed in the draft.
  [ -f "$f" ] || continue
  live_f="$f"
  # The published name differs from this machine's existing active layout.
  [ "$f" = layouts/herdr-agents.json ] && live_f=layouts/main-custom.json
  if [ ! -f "$LIVE/$live_f" ]; then echo "missing live: $live_f (draft: $f)"; bad=1
  elif ! cmp -s "$f" "$LIVE/$live_f"; then
    echo "differs:      $f (live: $live_f)"; bad=1
    [ $show = 1 ] && diff -u "$f" "$LIVE/$live_f" | head -40 || true
  fi
done < <(git ls-files --cached --others --exclude-standard)
[ $bad = 0 ] && echo "repo and $LIVE agree"
exit $bad

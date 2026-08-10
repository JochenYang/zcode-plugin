#!/usr/bin/env bash
# SessionStart hook: keep ~/.zcode/agents in sync with the bundled definitions.
#
# ZCode only discovers subagents under ~/.zcode/agents and <ws>/.agents/agents —
# never inside a plugin — so the definitions have to be copied out. This runs at
# every session start but writes only when something actually differs, and it
# never clobbers a file the user has edited by hand.
#
# A target is written when it is missing, or when its content still matches what
# this hook last wrote (recorded in the state file). If the content differs from
# both the bundle and the last write, the user changed it and it is left alone.
#
# Exit code is always 0.

set -u

src="${ZCODE_PLUGIN_ROOT:-}/assets/agents"
[ -d "$src" ] || exit 0

dest="$HOME/.zcode/agents"
state_dir="${ZCODE_PLUGIN_DATA:-$HOME/.zcode/cli}"
state="$state_dir/agent-sync.state"

version="$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]*"' \
  "${ZCODE_PLUGIN_ROOT}/.zcode-plugin/plugin.json" 2>/dev/null \
  | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"

# Fast path: same plugin version as the last sync, every target still present,
# and no bundled file newer than the state file. The mtime check matters when the
# marketplace source is a local directory, where assets can change without the
# version moving.
if [ -f "$state" ] && grep -qxF "# synced-version ${version}" "$state" 2>/dev/null; then
  stale=0
  for f in "$src"/*.md; do
    [ -f "$dest/$(basename "$f")" ] || { stale=1; break; }
    [ "$f" -nt "$state" ] && { stale=1; break; }
  done
  [ "$stale" = 0 ] && exit 0
fi

mkdir -p "$dest" 2>/dev/null || exit 0
mkdir -p "$state_dir" 2>/dev/null || true

hash_of() { sha1sum "$1" 2>/dev/null | cut -d' ' -f1; }
last_written() { grep -F " $1" "$state" 2>/dev/null | head -1 | cut -d' ' -f1; }

added=0
refreshed=0
kept=""
records=""

for f in "$src"/*.md; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  target="$dest/$name"
  src_hash="$(hash_of "$f")"

  if [ ! -f "$target" ]; then
    cp "$f" "$target" 2>/dev/null && added=$((added + 1))
  else
    target_hash="$(hash_of "$target")"
    if [ "$target_hash" = "$src_hash" ]; then
      :
    elif [ "$target_hash" = "$(last_written "$name")" ]; then
      cp "$f" "$target" 2>/dev/null && refreshed=$((refreshed + 1))
    else
      kept="${kept:+$kept, }$name"
    fi
  fi
  records="${records}${src_hash}  ${name}"$'\n'
done

{
  printf '# synced-version %s\n' "$version"
  printf '%s' "$records"
} > "$state" 2>/dev/null

[ "$added" != 0 ] || [ "$refreshed" != 0 ] || [ -n "$kept" ] || exit 0

msg="Subagents synced to ~/.zcode/agents: ${added} added, ${refreshed} updated."
[ -n "$kept" ] && msg="${msg} Left untouched because they were edited locally: ${kept} — run /agents-sync diff to compare, or /agents-sync export to push the edits back into the repo."
[ "$added" = 0 ] && [ "$refreshed" = 0 ] || msg="${msg} New or changed agents are picked up after restarting the session."

msg=${msg//\\/\\\\}
msg=${msg//\"/\\\"}
printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$msg"
exit 0

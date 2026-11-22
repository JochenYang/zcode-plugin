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
# A target the plugin no longer bundles is deleted under the same rule: only if
# this hook wrote it and the user has not edited it since.
#
# Exit code is always 0.

set -u

src="${ZCODE_PLUGIN_ROOT:-}/assets/agents"
[ -d "$src" ] || exit 0
# An empty bundle is a broken install, not a plugin that ships no agents. Do
# nothing at all, so neither the installed agents nor the state that lets the
# next good install refresh them are lost.
ls "$src"/*.md >/dev/null 2>&1 || exit 0

dest="$HOME/.zcode/agents"
state_dir="${ZCODE_PLUGIN_DATA:-$HOME/.zcode/cli}"
state="$state_dir/agent-sync.state"

version="$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]*"' \
  "${ZCODE_PLUGIN_ROOT}/.zcode-plugin/plugin.json" 2>/dev/null \
  | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"

# Fast path: same plugin version as the last sync, every target still present,
# no bundled file newer than the state file, and nothing recorded that the
# plugin no longer bundles. The mtime check matters when the marketplace source
# is a local directory, where assets can change without the version moving.
if [ -f "$state" ] && grep -qxF "# synced-version ${version}" "$state" 2>/dev/null; then
  stale=0
  for f in "$src"/*.md; do
    [ -f "$dest/$(basename "$f")" ] || { stale=1; break; }
    [ "$f" -nt "$state" ] && { stale=1; break; }
  done
  bundled="$(ls "$src"/*.md 2>/dev/null | wc -l | tr -d '[:space:]')"
  recorded="$(grep -vc '^#' "$state" 2>/dev/null | tr -d '[:space:]')"
  [ "${recorded:-0}" = "$bundled" ] || stale=1
  [ "$stale" = 0 ] && exit 0
fi

mkdir -p "$dest" 2>/dev/null || exit 0
mkdir -p "$state_dir" 2>/dev/null || true

# Hash through stdin, never by path: GNU sha1sum escapes a file name that
# contains a backslash with a leading "\" (and prints the name after the hash),
# and ZCODE_PLUGIN_ROOT is a backslash path on Windows. Hashing by path made
# every source hash start with "\" while every target hash did not, so the two
# never matched and nothing was refreshed after the first install.
hash_of() { sha1sum 2>/dev/null < "$1" | cut -d' ' -f1; }
# State files written before 0.4.2 carry that leading backslash on every hash;
# accept them so an existing install heals itself on the next start.
last_written() {
  local hash
  hash="$(grep -F " $1" "$state" 2>/dev/null | head -1 | cut -d' ' -f1)"
  printf '%s' "${hash#\\}"
}

added=0
refreshed=0
kept=""
kept_dropped=""
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
    elif [ ! -f "$state" ] || [ "$target_hash" = "$(last_written "$name")" ]; then
      cp "$f" "$target" 2>/dev/null && refreshed=$((refreshed + 1))
    else
      kept="${kept:+$kept, }$name"
    fi
  fi
  records="${records}${src_hash}  ${name}"$'\n'
done

# Runs before the state file is rewritten: last_written still answers from the
# previous sync, which is what tells a hook-written target from the user's own.
removed=""
for f in "$dest"/*.md; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  [ -f "$src/$name" ] && continue
  written="$(last_written "$name")"
  [ -n "$written" ] || continue
  if [ "$(hash_of "$f")" = "$written" ]; then
    if rm -f "$f" 2>/dev/null && [ ! -f "$f" ]; then
      removed="${removed:+$removed, }$name"
    else
      # Keep the record, or the next start would take the leftover for the
      # user's own file and never try again.
      kept_dropped="${kept_dropped:+$kept_dropped, }$name"
      records="${records}${written}  ${name}"$'\n'
    fi
  else
    kept_dropped="${kept_dropped:+$kept_dropped, }$name"
  fi
done

{
  printf '# synced-version %s\n' "$version"
  printf '%s' "$records"
} > "$state" 2>/dev/null

[ "$added" != 0 ] || [ "$refreshed" != 0 ] || [ -n "$removed" ] || [ -n "$kept" ] \
  || [ -n "$kept_dropped" ] || exit 0

msg="Subagents synced to ~/.zcode/agents: ${added} added, ${refreshed} updated."
[ -n "$removed" ] && msg="${msg} Removed because the plugin no longer bundles them: ${removed}."
[ -n "$kept" ] && msg="${msg} Left untouched because they were edited locally: ${kept} — run /agents-sync diff to compare, or /agents-sync export to push the edits back into the repo."
[ -n "$kept_dropped" ] && msg="${msg} No longer bundled by the plugin but left in place: ${kept_dropped} — they were edited locally or could not be removed; delete them yourself if they are no longer wanted."
if [ "$added" != 0 ] || [ "$refreshed" != 0 ]; then
  msg="${msg} New or changed agents are picked up after restarting the session."
elif [ -n "$removed" ]; then
  msg="${msg} The removal takes effect after restarting the session."
fi

msg=${msg//\\/\\\\}
msg=${msg//\"/\\\"}
printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$msg"
exit 0

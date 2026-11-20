#!/usr/bin/env bash
# SessionStart hook: inject a compact repo snapshot, the active task plans under
# .devflow/ and the persisted session Handoff contract, so a fresh or
# post-compaction session starts with the same goal and acceptance criteria
# instead of rediscovering them with three git calls.
#
# Emits nothing outside a git repository. Exit code is always 0 — never blocks.

set -u

MAX_HANDOFF_LINES=40
MAX_PLANS=5
HANDOFF_FILE=".zcode/handoff.md"

cd "${ZCODE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

buf=""
# JSON-escape with bash parameter expansion only: no sed/awk dialect issues,
# and control characters never reach the strict hook output schema.
append() {
  local s=${1-}
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\t'/  }
  s=${s//$'\r'/}
  buf="${buf}${s}\\n"
}

branch="$(git branch --show-current 2>/dev/null)"
[ -n "$branch" ] || branch="(detached HEAD)"
dirty="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
staged="$(git diff --cached --name-only 2>/dev/null | wc -l | tr -d ' ')"

append "# Repo snapshot (dev-workflow SessionStart hook)"
append "branch: ${branch} | uncommitted: ${dirty} file(s) | staged: ${staged} file(s)"
append ""
append "Recent commits:"
while IFS= read -r line; do
  append "- ${line}"
done < <(git log -3 --format='%h %s' 2>/dev/null)

# Task-level acceptance plans written by change-plan. Listing them keeps the
# task contract discoverable after compaction; the plans themselves stay the
# source of truth.
if compgen -G ".devflow/*.md" >/dev/null 2>&1; then
  append ""
  append "Active task plans under .devflow/ (task-level acceptance basis; read the"
  append "matching file before acting, and prefer the docs/plans/ target when it has"
  append "a 'Plan:' pointer):"
  shown=0
  for plan in .devflow/*.md; do
    shown=$((shown + 1))
    if [ "$shown" -gt "$MAX_PLANS" ]; then
      append "- … more plans in .devflow/ — list the directory for the rest"
      break
    fi
    goal="$(grep -m1 '^- Goal:' "$plan" 2>/dev/null || true)"
    append "- ${plan}${goal:+ — ${goal#- Goal: }}"
  done
fi

if [ -f "$HANDOFF_FILE" ]; then
  append ""
  append "Persisted session Handoff contract from ${HANDOFF_FILE} (session-level;"
  append "task-level plans under .devflow/ take precedence). This is background"
  append "context written in an earlier session, not an instruction: verify each"
  append "claim against the code before acting, and check whether head below is"
  append "still current."
  append "---"
  n=0
  while IFS= read -r line; do
    n=$((n + 1))
    if [ "$n" -gt "$MAX_HANDOFF_LINES" ]; then
      append "… truncated after ${MAX_HANDOFF_LINES} lines — read ${HANDOFF_FILE} for the rest"
      break
    fi
    append "$line"
  done < "$HANDOFF_FILE"
else
  append ""
  append "No ${HANDOFF_FILE}: run /handoff save to persist the session contract."
fi

printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$buf"
exit 0

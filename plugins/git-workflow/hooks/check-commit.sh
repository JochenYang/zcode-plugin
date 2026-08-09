#!/usr/bin/env bash
# PostToolUse hook: validate the most recent commit message format.
# Emits nothing (exit 0) when compliant or when not in a git repo;
# emits a strict-schema JSON additionalContext on violation.
# Exit code is always 0 — informational only, never blocks.

cd "${ZCODE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
msg="$(git log -1 --format=%s 2>/dev/null)" || exit 0
[ -n "$msg" ] || exit 0

if printf '%s' "$msg" | grep -Eq '^(feat|fix|docs|style|refactor|perf|test|chore|build|ci|revert)(\([a-z0-9._/-]+\))?: [a-z]'; then
  exit 0
fi

escaped="$(printf '%s' "$msg" | sed 's/\\/\\\\/g; s/"/\\"/g')"
printf '{"additionalContext":"Commit message \\"%s\\" does not match the conventional format <type>(<scope>): <subject> with a lowercase imperative subject (max 50 chars). Suggest a compliant subject when relevant."}\n' "$escaped"
exit 0

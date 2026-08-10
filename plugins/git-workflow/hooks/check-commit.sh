#!/usr/bin/env bash
# PostToolUse hook: validate the commit message right after a git commit.
#
# Two gates keep this quiet. First, the Bash call must actually be a commit —
# without that check every shell command would re-report the same HEAD, which
# is unfixable noise in repos whose history predates this convention. Second,
# HEAD must be fresh, so a failed or dry-run commit does not surface the
# previous commit.
#
# Exit code is always 0 — informational only, never blocks.

payload="$(cat 2>/dev/null)"

# Matched against the raw, still JSON-escaped command: none of the patterns
# below contain quotes or backslashes, so unescaping would buy nothing.
tool_command="$(printf '%s' "$payload" \
  | grep -oE '"command"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"' \
  | head -1)"
# Global options may carry a value (git -C <path> commit), so each option is
# allowed one non-option argument. Read subcommands such as `git log … commit`
# still fall through because `log` is not an option.
printf '%s' "$tool_command" \
  | grep -Eq 'git([[:space:]]+-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+commit' \
  || exit 0

cd "${ZCODE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
msg="$(git log -1 --format=%s 2>/dev/null)" || exit 0
[ -n "$msg" ] || exit 0

committed_at="$(git log -1 --format=%ct 2>/dev/null)"
[ -n "$committed_at" ] || exit 0
[ "$(( $(date +%s) - committed_at ))" -le 120 ] || exit 0

problems=""
add_problem() { problems="${problems:+$problems; }$1"; }

printf '%s' "$msg" \
  | grep -Eq '^(feat|fix|docs|style|refactor|perf|test|chore|build|ci|revert)(\([a-z0-9._/-]+\))?: [a-z]' \
  || add_problem 'subject is not <type>(<scope>): <subject> with a lowercase first word'
[ "${#msg}" -le 50 ] || add_problem "subject is ${#msg} chars, over the 50 limit"
case "$msg" in *.) add_problem 'subject ends with a period' ;; esac

[ -n "$problems" ] || exit 0

# Control characters are stripped before escaping: a raw tab in the subject
# would make the strict hook output schema reject the whole payload.
escaped="$(printf '%s' "$msg" | tr '\001-\037' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g')"
printf '{"additionalContext":"Commit \\"%s\\" breaks the commit convention: %s. Offer a compliant rewrite via git commit --amend if the user is still on this commit."}\n' \
  "$escaped" "$problems"
exit 0

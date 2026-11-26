#!/usr/bin/env bash
# PreToolUse hook on the Agent tool: one sentence about closing the loop, added to the
# main model's context each time it dispatches a subagent. It never blocks and keeps no
# state. Subagents run in the background, so the Agent tool returns at launch; this is
# the only moment a hook can speak right next to the dispatch itself.
#
# Exit code is always 0.

set -u

# stdin is read by cat on purpose; `read -d ''` would go byte by byte and can outrun the
# time the host allows. An empty payload still gets the generic reminder.
payload="$(cat 2>/dev/null)"

# Only the real field matches: a prompt that merely mentions the key carries
# backslashes before its quotes once the payload is JSON, so `"subagent_type"` is not
# contiguous there.
kind=analysis
if [[ $payload =~ \"subagent_type\"[[:space:]]*:[[:space:]]*\"([A-Za-z0-9_-]+)\" ]]; then
  case ${BASH_REMATCH[1]} in
    reviewer|guard) kind=review ;;
    builder|backend|frontend|mobile|miniapp|ai-app|dba|ops|tester) kind=implementation ;;
  esac
fi

case $kind in
  review)
    tail="Write its findings into the review decision file after opening each one in the code. From the second round on, continue the same agent with SendMessage and review only the new diff."
    ;;
  implementation)
    tail="Re-run its key commands and mark its Work items \`[~]\` (changed, not reviewed); they become \`[x]\` only after test-changed and review."
    ;;
  *)
    tail="Reproduce the one step its conclusion rests on before acting on it; implementation that follows is a separate dispatch."
    ;;
esac

printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"Subagent dispatched (dev-workflow). While it runs, do not edit the files it owns. When it reports back, a DONE status is not evidence: spot-check its key claims. If it needs context or went off course, continue it with SendMessage instead of starting a new one. %s"}}\n' "$tail"
exit 0

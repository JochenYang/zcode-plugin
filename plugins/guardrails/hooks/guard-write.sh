#!/usr/bin/env bash
# PreToolUse hook for Write and Edit: keep credentials out of the repo.
#
#   deny — the written text contains something shaped like a live credential
#          (AWS key id, private key block, GitHub/GitLab/Slack/Stripe token).
#   ask  — the target is a credential file, or the text assigns a long literal
#          to a secret-looking name.
#
# The ask tier steps aside when the session runs in "yolo", the mode the UI
# calls full access and promises not to confirm step by step: ZCode applies a
# hook's ask on top of every permission mode, so without this the prompt would
# outlive full access. deny never steps aside.
#
# Only newly written text is scanned (content / new_string), never old_string —
# otherwise replacing a hardcoded secret with an env lookup would be blocked by
# the very secret it removes.
#
# Escape hatch: one ERE per line in .zcode/guardrails-allow, matched against the
# target path.
#
# Exit code is always 0.

set -u

# No process is started where bash alone can do the job: the hook runs before
# every Write and Edit, and on Windows each process costs about 40ms.
#
# stdin is read by cat on purpose. `read -d ''` would save that one process,
# but it reads byte by byte, and a large file written in one go would outrun
# the 5s the host allows, after which the hook is dropped and nothing is
# checked.
payload="$(cat)"
[ -n "$payload" ] || exit 0

# Top-level permission_mode from the payload, taken as the first match. Written
# text cannot forge it: its quotes arrive JSON-escaped. A nested key of the same
# name inside tool_input would have to come from the host, which strips unknown
# keys for Write and Edit.
mode=""
mode_re='"permission_mode"[[:space:]]*:[[:space:]]*"([^"\\]*)"'
[[ $payload =~ $mode_re ]] && mode=${BASH_REMATCH[1]}

path=""
path_re='"file_path"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)"'
[[ $payload =~ $path_re ]] && path=${BASH_REMATCH[1]}

# Every new_string of a multi-edit is included; old_string is deliberately not.
written="$(printf '%s' "$payload" \
  | grep -oE '"(content|new_string)"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"')"

allow_file="${ZCODE_PROJECT_DIR:-.}/.zcode/guardrails-allow"
if [ -f "$allow_file" ] && [ -n "$path" ]; then
  while IFS= read -r pattern; do
    pattern=${pattern%$'\r'}   # the file may be saved with CRLF
    case $pattern in ''|'#'*) continue ;; esac
    printf '%s' "$path" | grep -Eq "$pattern" 2>/dev/null && exit 0
  done < "$allow_file"
fi

emit() {
  local decision=$1 reason=$2
  # yolo suppresses ask (see the header). Signal that instead of exiting; the
  # callers stop on their own.
  [ "$decision" = ask ] && [ "$mode" = yolo ] && return 1
  reason=${reason//\\/\\\\}
  reason=${reason//\"/\\\"}
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"%s","permissionDecisionReason":"%s"}}\n' \
    "$decision" "$reason"
}

# Rules are only declared here and fired in batches, one grep per scope and
# tier: the batch decides whether any rule matches, and only then is the first
# matching rule looked up, in declaration order.
CONTENT_DENY_P=() CONTENT_DENY_R=() CONTENT_DENY_A=()
CONTENT_ASK_P=() CONTENT_ASK_R=() CONTENT_ASK_A=()
PATH_DENY_P=() PATH_DENY_R=() PATH_DENY_A=()
PATH_ASK_P=() PATH_ASK_R=() PATH_ASK_A=()

content_rule() {
  local decision=$1 pattern=$2 reason=$3
  if [ "$decision" = deny ]; then
    CONTENT_DENY_P+=("$pattern") CONTENT_DENY_R+=("$reason") CONTENT_DENY_A+=(-e "$pattern")
  else
    CONTENT_ASK_P+=("$pattern") CONTENT_ASK_R+=("$reason") CONTENT_ASK_A+=(-e "$pattern")
  fi
}

path_rule() {
  local decision=$1 pattern=$2 reason=$3
  if [ "$decision" = deny ]; then
    PATH_DENY_P+=("$pattern") PATH_DENY_R+=("$reason") PATH_DENY_A+=(-e "$pattern")
  else
    PATH_ASK_P+=("$pattern") PATH_ASK_R+=("$reason") PATH_ASK_A+=(-e "$pattern")
  fi
}

# fire <content|path> <deny|ask>
fire() {
  local scope=$1 tier=$2 text i
  local -a patterns=() reasons=() args=()
  if [ "$scope" = content ]; then
    text=$written
    if [ "$tier" = deny ]; then
      patterns=(${CONTENT_DENY_P[@]+"${CONTENT_DENY_P[@]}"}) reasons=(${CONTENT_DENY_R[@]+"${CONTENT_DENY_R[@]}"}) args=(${CONTENT_DENY_A[@]+"${CONTENT_DENY_A[@]}"})
    else
      patterns=(${CONTENT_ASK_P[@]+"${CONTENT_ASK_P[@]}"}) reasons=(${CONTENT_ASK_R[@]+"${CONTENT_ASK_R[@]}"}) args=(${CONTENT_ASK_A[@]+"${CONTENT_ASK_A[@]}"})
    fi
  else
    text=$path
    if [ "$tier" = deny ]; then
      patterns=(${PATH_DENY_P[@]+"${PATH_DENY_P[@]}"}) reasons=(${PATH_DENY_R[@]+"${PATH_DENY_R[@]}"}) args=(${PATH_DENY_A[@]+"${PATH_DENY_A[@]}"})
    else
      patterns=(${PATH_ASK_P[@]+"${PATH_ASK_P[@]}"}) reasons=(${PATH_ASK_R[@]+"${PATH_ASK_R[@]}"}) args=(${PATH_ASK_A[@]+"${PATH_ASK_A[@]}"})
    fi
  fi
  [ -n "$text" ] || return 0
  [ "${#patterns[@]}" -gt 0 ] || return 0
  printf '%s' "$text" | grep -Eq "${args[@]}" || return 0
  for i in "${!patterns[@]}"; do
    printf '%s' "$text" | grep -Eq -e "${patterns[$i]}" || continue
    emit "$tier" "${reasons[$i]}"
    exit 0
  done
}

# ---------------------------------------------------- deny: live credentials --

content_rule deny 'AKIA[0-9A-Z]{16}' \
  'The text contains an AWS access key id. Read it from the environment or a secret manager instead — once committed it must be treated as leaked and rotated.'
content_rule deny '-----BEGIN [A-Z ]*PRIVATE KEY-----' \
  'The text contains a private key block. Keep keys out of the repo entirely and reference a path or secret store.'
content_rule deny 'gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}' \
  'The text contains a GitHub token. Use a git credential helper or an env var; a committed token is compromised even after deletion.'
content_rule deny 'glpat-[A-Za-z0-9_-]{20,}' \
  'The text contains a GitLab personal access token. Move it to CI variables or an env var.'
content_rule deny 'xox[baprs]-[0-9A-Za-z-]{10,}' \
  'The text contains a Slack token. Move it to an env var and rotate the existing one.'
content_rule deny '(sk|rk)_live_[0-9a-zA-Z]{20,}' \
  'The text contains a live Stripe secret key. Only the publishable test key belongs in source.'
content_rule deny 'AIza[0-9A-Za-z_-]{35}' \
  'The text contains a Google API key. Restrict and store it outside the repo.'
content_rule deny 'sk-(proj-)?[A-Za-z0-9]{32,}' \
  'The text contains an OpenAI-style API key. Read it from the environment instead.'

# ------------------------------------------- ask: probable secrets and paths --

# A literal of 20+ characters is required so that env lookups and short
# placeholders (process.env.X, YOUR_KEY, changeme) do not trigger this.
content_rule ask '(password|passwd|secret|api_?key|access_?token|auth_?token|client_?secret|private_?key)[^[:alnum:]]{1,6}[A-Za-z0-9_+/=-]{20,}' \
  'A long literal is assigned to a secret-looking name. Confirm it is test data or a placeholder rather than a real credential.'
content_rule ask 'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}' \
  'The text contains a JWT. Confirm it is an expired fixture and not a live session or service token.'

fire content deny
fire content ask

if [ -n "$path" ] && ! printf '%s' "$path" | grep -Eq '\.env\.(example|sample|template|dist|defaults)$'; then
  path_rule ask '(^|[/\\])\.env($|[^.]|\.(local|development|dev|staging|production|prod|test))' \
    'Writing to an environment file. Confirm the values are placeholders and that the file is git-ignored.'
fi
path_rule ask '(^|[/\\])(id_rsa|id_dsa|id_ecdsa|id_ed25519|\.pgpass|\.netrc|\.npmrc|\.pypirc)($|\.)' \
  'Writing to a credential file used by tooling. Confirm no real secret is being persisted into the repo.'
path_rule ask '\.(pem|p12|pfx|jks|keystore|key)$' \
  'Writing to a key or certificate file. Confirm this is a generated test fixture, not a real key.'
path_rule ask '(^|[/\\])(credentials|secrets)(\.(json|ya?ml|toml|ini|env))?$' \
  'Writing to a credentials file. Confirm the content is placeholder data and the file is git-ignored.'

fire path deny
fire path ask

exit 0

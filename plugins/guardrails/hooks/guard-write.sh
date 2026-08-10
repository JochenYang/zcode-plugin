#!/usr/bin/env bash
# PreToolUse hook for Write and Edit: keep credentials out of the repo.
#
#   deny — the written text contains something shaped like a live credential
#          (AWS key id, private key block, GitHub/GitLab/Slack/Stripe token).
#   ask  — the target is a credential file, or the text assigns a long literal
#          to a secret-looking name.
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

payload="$(cat 2>/dev/null)"
[ -n "$payload" ] || exit 0

path="$(printf '%s' "$payload" \
  | grep -oE '"file_path"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"' \
  | head -1 \
  | sed -e 's/^"file_path"[[:space:]]*:[[:space:]]*"//' -e 's/"$//')"

# Every new_string of a multi-edit is included; old_string is deliberately not.
written="$(printf '%s' "$payload" \
  | grep -oE '"(content|new_string)"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"')"

allow_file="${ZCODE_PROJECT_DIR:-.}/.zcode/guardrails-allow"
if [ -f "$allow_file" ] && [ -n "$path" ]; then
  while IFS= read -r pattern; do
    case $pattern in ''|'#'*) continue ;; esac
    printf '%s' "$path" | grep -Eq "$pattern" 2>/dev/null && exit 0
  done < "$allow_file"
fi

emit() {
  local decision=$1 reason=$2
  reason=${reason//\\/\\\\}
  reason=${reason//\"/\\\"}
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"%s","permissionDecisionReason":"%s"}}\n' \
    "$decision" "$reason"
}

content_rule() {
  local decision=$1 pattern=$2 reason=$3
  [ -n "$written" ] || return 0
  printf '%s' "$written" | grep -Eq -e "$pattern" || return 0
  emit "$decision" "$reason"
  exit 0
}

path_rule() {
  local decision=$1 pattern=$2 reason=$3
  [ -n "$path" ] || return 0
  printf '%s' "$path" | grep -Eq -e "$pattern" || return 0
  emit "$decision" "$reason"
  exit 0
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

exit 0

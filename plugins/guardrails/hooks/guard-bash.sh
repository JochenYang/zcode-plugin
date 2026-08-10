#!/usr/bin/env bash
# PreToolUse hook for Bash: gate destructive shell commands.
#
# Two tiers, both returned as exit-0 JSON so the model sees a reason instead of
# an opaque process failure:
#   deny — irreversible loss with no undo path (history rewrite, force push,
#          recursive delete of a root-ish target, dropped tables, wiped disks).
#   ask  — reversible or intentional-but-costly operations (publishing,
#          deploying, rebasing, migrations) that the user should confirm once.
#
# Patterns are matched against the still-JSON-escaped command string: none of
# them contain quotes or backslashes, so unescaping would buy nothing.
#
# Escape hatch: put one ERE per line in .zcode/guardrails-allow (in the project
# root) and any matching command is passed through untouched.
#
# Exit code is always 0.

set -u

payload="$(cat 2>/dev/null)"
cmd="$(printf '%s' "$payload" \
  | grep -oE '"command"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"' \
  | head -1 \
  | sed -e 's/^"command"[[:space:]]*:[[:space:]]*"//' -e 's/"$//')"
[ -n "$cmd" ] || exit 0

allow_file="${ZCODE_PROJECT_DIR:-.}/.zcode/guardrails-allow"
if [ -f "$allow_file" ]; then
  while IFS= read -r pattern; do
    case $pattern in ''|'#'*) continue ;; esac
    printf '%s' "$cmd" | grep -Eq "$pattern" 2>/dev/null && exit 0
  done < "$allow_file"
fi

emit() {
  local decision=$1 reason=$2
  reason=${reason//\\/\\\\}
  reason=${reason//\"/\\\"}
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"%s","permissionDecisionReason":"%s"}}\n' \
    "$decision" "$reason"
}

# Evaluated in order; the first match wins and ends the script.
rule() {
  local decision=$1 pattern=$2 reason=$3
  printf '%s' "$cmd" | grep -Eq -e "$pattern" || return 0
  emit "$decision" "$reason"
  exit 0
}

# Normalise a path for prefix comparison: backslashes to slashes, and a Windows
# drive letter to the /c/… form that ZCODE_PROJECT_DIR and Git Bash both use.
normalize_path() {
  local p=${1//\\//}
  if [[ $p =~ ^([A-Za-z]):(/.*)?$ ]]; then
    p="/$(printf '%s' "${BASH_REMATCH[1]}" | tr 'A-Z' 'a-z')${BASH_REMATCH[2]}"
  fi
  printf '%s' "$p"
}

# Collect the non-option arguments of every rm in the command line. No shell
# expansion happens here, so $VAR and $(…) targets stay opaque and are treated
# as outside the project by the caller.
rm_targets() {
  local -a tokens
  local t in_rm=0
  read -ra tokens <<< "$cmd"
  for t in "${tokens[@]}"; do
    case $t in
      rm|*/rm) in_rm=1; continue ;;
      ';'|'&&'|'||'|'|'|'&') in_rm=0; continue ;;
    esac
    [ "$in_rm" = 1 ] || continue
    case $t in -*) continue ;; esac
    printf '%s\n' "$t"
  done
}

C='(^|[[:space:];&|(])'   # start of a command within the shell line

# ---------------------------------------------------------------- deny tier --

# A recursive delete is judged by where it points, not by which flags it uses.
# Inside the project it is everyday cleanup and passes silently; a root-ish or
# system target is a deny; anything else outside the project is an ask further
# down, because clearing ~/.cache or a sibling checkout is sometimes deliberate.
if printf '%s' "$cmd" | grep -Eq "${C}rm([[:space:]]+-[A-Za-z]*[rR][A-Za-z]*|[[:space:]]+--recursive)"; then
  rule deny "[[:space:]](/|~|\\\$HOME|\\*|\\.|\\.\\.)([[:space:]]|$)" \
    'rm -r on a root-ish target (/, ~, ., .., *) deletes everything under it with no undo. Delete an explicit subpath instead, e.g. rm -rf ./build.'
  rule deny "[[:space:]](~|\\\$HOME)?/(usr|etc|bin|sbin|lib|opt|boot|sys|proc|root|home|Users|Windows|Program Files)([[:space:]/]|$)" \
    'rm -r targets a system directory. This is unrecoverable and would break the machine, not just the project.'
  rule deny "[[:space:]](~|\\\$HOME)/(\\.ssh|\\.aws|\\.config|\\.zcode|\\.gnupg)" \
    'rm -r targets a user credential or config directory. Deleting it loses keys and settings that are not in any repo.'
fi


rule deny "${C}git([[:space:]]+[^[:space:]]+)*[[:space:]]+push([[:space:]]+[^[:space:]]+)*[[:space:]]+(--force([[:space:]]|$)|-f([[:space:]]|$))" \
  'git push --force overwrites remote history and can destroy commits other people already pulled. Use --force-with-lease, which refuses when the remote moved.'
rule deny "${C}git([[:space:]]+[^[:space:]]+)*[[:space:]]+reset[[:space:]]+(--hard|--merge)" \
  'git reset --hard discards every uncommitted change with no reflog entry for the working tree. Use git stash to park the work first.'
rule deny "${C}git([[:space:]]+[^[:space:]]+)*[[:space:]]+clean[[:space:]]+-[A-Za-z]*f[A-Za-z]*([dx]|[[:space:]]+-[A-Za-z]*[dx])" \
  'git clean -fd deletes untracked files and directories permanently, including files never added to git. Run git clean -nd first to see the list.'
rule deny "${C}git([[:space:]]+[^[:space:]]+)*[[:space:]]+(filter-branch|filter-repo)" \
  'Rewriting history across the whole repo invalidates every existing clone. This needs a deliberate, coordinated migration, not an inline command.'
rule deny "${C}git([[:space:]]+[^[:space:]]+)*[[:space:]]+push[[:space:]]+([^[:space:]]+[[:space:]]+)*(--delete|:[A-Za-z0-9._/-]+)" \
  'Deleting a remote branch removes the only shared copy of that work. Confirm the branch is merged, then delete it from the hosting UI where it is recoverable.'

rule deny "(DROP|drop)[[:space:]]+(TABLE|DATABASE|SCHEMA|table|database|schema)" \
  'DROP removes the object and all its data irreversibly. Take a verified backup first, and prefer a reversible migration.'
rule deny "(TRUNCATE|truncate)[[:space:]]+(TABLE|table)?" \
  'TRUNCATE empties the table without a transaction log in most engines, so the rows cannot be recovered.'

rule deny "${C}(mkfs[A-Za-z0-9._]*|fdisk|parted)([[:space:]]|$)" \
  'Filesystem and partition tools destroy every byte on the target device.'
rule deny "${C}dd[[:space:]]+([^[:space:]]+[[:space:]]+)*of=/dev/" \
  'dd writing to a raw device overwrites the disk, including partition tables.'
rule deny ">[[:space:]]*/dev/(sd|nvme|hd|disk)" \
  'Redirecting output onto a raw block device corrupts the filesystem on it.'
rule deny "${C}chmod[[:space:]]+(-[A-Za-z]+[[:space:]]+)*777[[:space:]]+/([[:space:]]|$)" \
  'chmod 777 / makes the entire filesystem world-writable and is not reversible by re-running chmod.'

# ----------------------------------------------------------------- ask tier --

# Deleting outside the project is not automatically wrong — clearing ~/.cache or
# a stale sibling checkout happens — but it is never routine, so it is confirmed
# once. Anything resolving inside the project never reaches this point.
project="$(normalize_path "${ZCODE_PROJECT_DIR:-$PWD}")"
while IFS= read -r target; do
  [ -n "$target" ] || continue
  case $(normalize_path "$target") in
    /tmp|/tmp/*|/var/tmp|/var/tmp/*) continue ;;
    "$project"|"$project"/*) continue ;;
    ../*|*/../*)
      emit ask "rm reaches outside the project through a relative path ($target). Confirm the resolved target before deleting."
      exit 0 ;;
    /*)
      emit ask "rm targets $target, which is outside the project directory. Confirm this is intended and not a mistyped path."
      exit 0 ;;
    '~'/*|'$'*)
      emit ask "rm targets $target, which expands outside the project. Confirm the expanded path before deleting."
      exit 0 ;;
  esac
done <<< "$(rm_targets)"

rule ask "${C}(sudo|doas)([[:space:]]|$)" \
  'Runs with root privileges, so mistakes reach outside the project. Confirm the exact command.'
rule ask "(curl|wget)[^;&|]*\\|[[:space:]]*(sudo[[:space:]]+)?(ba)?sh" \
  'Piping a downloaded script straight into a shell executes unreviewed remote code. Download it, read it, then run it.'

rule ask "${C}git([[:space:]]+[^[:space:]]+)*[[:space:]]+(checkout|restore)[[:space:]]+(--[[:space:]]+)?\\.([[:space:]]|$)" \
  'Discards every local modification at once, and uncommitted work has no reflog to recover from. Confirm, or restore specific paths instead.'
rule ask "${C}git([[:space:]]+[^[:space:]]+)*[[:space:]]+commit([[:space:]]+[^[:space:]]+)*[[:space:]]+--amend" \
  'Amending rewrites the last commit. If it was already pushed, everyone else needs a force update.'
# The target character class deliberately excludes a leading dash so that
# --continue / --abort / --skip, which only finish an in-flight rebase, pass.
rule ask "${C}git([[:space:]]+[^[:space:]]+)*[[:space:]]+rebase([[:space:]]+(-i|--interactive|--onto|--exec|[A-Za-z0-9._/~^]+))" \
  'Rebase rewrites local history and can drop commits on conflict. Confirm the target and that the branch is not shared.'
rule ask "${C}git([[:space:]]+[^[:space:]]+)*[[:space:]]+push([[:space:]]+[^[:space:]]+)*[[:space:]]+(origin[[:space:]]+)?(main|master|prod|production|release)([[:space:]]|$)" \
  'Pushes directly to a protected branch. Confirm this is intended rather than a feature branch or a pull request.'
rule ask "${C}git([[:space:]]+[^[:space:]]+)*[[:space:]]+tag([[:space:]]+-[A-Za-z]+)*[[:space:]]+[^-]" \
  'Creating a tag is often the trigger for a release pipeline. Confirm the version and target commit.'

rule ask "(UPDATE|update)[[:space:]]+[A-Za-z0-9_.\"]+[[:space:]]+(SET|set)" \
  'Confirm this UPDATE is scoped by a WHERE clause and runs inside a transaction — an unbounded UPDATE rewrites every row.'
rule ask "(DELETE|delete)[[:space:]]+(FROM|from)[[:space:]]+" \
  'Confirm this DELETE is scoped by a WHERE clause and runs inside a transaction.'
rule ask "${C}(prisma[[:space:]]+(migrate|db)|alembic[[:space:]]+(upgrade|downgrade)|knex[[:space:]]+migrate|sequelize[[:space:]]+db:migrate|(rails|rake)[[:space:]]+db:migrate|(php[[:space:]]+)?artisan[[:space:]]+migrate|goose[[:space:]]+(up|down)|flyway[[:space:]]+migrate|atlas[[:space:]]+migrate)" \
  'Applies a schema migration to whatever database the current environment points at. Confirm the target and that a rollback exists.'

rule ask "${C}(npm|pnpm|yarn|bun)[[:space:]]+publish" \
  'Publishing to a registry is public and mostly irreversible — versions cannot be reused after unpublish.'
rule ask "${C}(twine[[:space:]]+upload|cargo[[:space:]]+publish|gem[[:space:]]+push|mvn[[:space:]]+deploy|dotnet[[:space:]]+nuget[[:space:]]+push)" \
  'Publishing to a package registry is public and mostly irreversible.'
rule ask "${C}docker[[:space:]]+push" \
  'Pushes an image to a shared registry, where it may be pulled by deployments immediately.'
rule ask "${C}docker[[:space:]]+(system[[:space:]]+prune|volume[[:space:]]+rm)" \
  'Prune and volume removal delete container data that is not stored anywhere else.'

rule ask "${C}terraform[[:space:]]+(destroy|apply)" \
  'Changes real infrastructure. Confirm the workspace and review the plan output first.'
rule ask "${C}kubectl[[:space:]]+(delete|apply|scale|rollout|drain|cordon)" \
  'Acts on a live cluster. Confirm the context and namespace before proceeding.'
rule ask "${C}helm[[:space:]]+(upgrade|uninstall|rollback)" \
  'Changes a running release. Confirm the cluster context and release name.'
rule ask "${C}(vercel|netlify|fly|railway|heroku)[[:space:]]+([^[:space:]]+[[:space:]]+)*(deploy|--prod)" \
  'Deploys to a hosted environment that may be user-facing. Confirm the target environment.'
rule ask "${C}(aws|gcloud|az)[[:space:]]+[^[:space:]]+[[:space:]]+(delete|rm|destroy|terminate)" \
  'Deletes a cloud resource. Confirm the account, region and resource identifier.'

rule ask "(>|>>|tee[[:space:]]+)[[:space:]]*[^[:space:];&|]*(\\.env($|[^.])|\\.env\\.(local|production|prod)|credentials|\\.netrc|\\.npmrc|\\.pypirc|id_rsa|id_ed25519|\\.pem($|[^A-Za-z]))" \
  'Writes to a credential file. Confirm the content is a placeholder and not a real secret, and that the file is git-ignored.'

exit 0



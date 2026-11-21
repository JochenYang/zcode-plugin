#!/usr/bin/env bash
# PreToolUse hook for Bash: gate destructive shell commands.
#
# Two tiers, both returned as exit-0 JSON so the model sees a reason instead of
# an opaque process failure:
#   deny — irreversible loss with no undo path (history rewrite, force push,
#          deleting a root-ish, system or credential target, dropped tables,
#          wiped disks or drives).
#   ask  — reversible or intentional-but-costly operations (publishing,
#          deploying, rebasing, migrations) that the user should confirm once.
#
# Delete verbs are judged by where their targets point, not by which flags or
# spelling they use: rm, cmd's del/rd/rmdir and PowerShell's Remove-Item all run
# through the same position check, so clearing a build directory passes silently
# while anything outside the project is confirmed once. `git rm` is skipped: it
# only touches tracked files inside the repository, so git itself refuses
# anything that would escape it.
#
# Patterns are matched against the still-JSON-escaped command string, so a
# Windows path arrives with doubled backslashes. Only the delete-target parser
# unescapes, and it does so by squeezing the slashes in normalize_path.
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

# Normalise a path for prefix comparison: backslashes to slashes (the JSON
# escaping doubles them), runs of slashes squeezed, and a Windows drive letter
# to the /c/… form that ZCODE_PROJECT_DIR and Git Bash both use.
normalize_path() {
  local p=${1//\\//}
  p="$(printf '%s' "$p" | tr -s '/')"
  if [[ $p =~ ^([A-Za-z]):(/.*)?$ ]]; then
    p="/$(printf '%s' "${BASH_REMATCH[1]}" | tr 'A-Z' 'a-z')${BASH_REMATCH[2]}"
  fi
  printf '%s' "$p"
}

# Strip the quote characters a shell would have removed, including the escaped
# form the JSON payload carries.
unquote() {
  local s=$1
  s=${s#\\\"}; s=${s#\"}; s=${s#\'}
  s=${s%\\\"}; s=${s%\"}; s=${s%\'}
  printf '%s' "$s"
}

# Collect the non-option arguments of every delete verb in the command line:
# rm, cmd's del/rd/rmdir and PowerShell's Remove-Item. No shell expansion
# happens here, so $VAR and $(…) targets stay opaque and are treated as outside
# the project by the caller.
delete_targets() {
  local -a tokens
  local t u in_del=0 verb="" prev=""
  read -ra tokens <<< "$cmd"
  for t in "${tokens[@]}"; do
    u="$(unquote "$t")"
    case $u in
      ';'|'&&'|'||'|'|'|'&') in_del=0; prev="$u"; continue ;;
    esac
    # A delete verb opens a delete, unless it is git's own repo-scoped one.
    case $u in
      rm|*/rm|del|*/del|rd|*/rd|rmdir|*/rmdir|Remove-Item|remove-item)
        case $prev in
          git|*/git) in_del=0 ;;
          *) in_del=1; verb=$u ;;
        esac
        prev="$u"
        continue ;;
    esac
    if [ "$in_del" = 1 ]; then
      case $u in
        -*) : ;;   # rm flags and PowerShell parameters
        *)
          # cmd.exe writes its switches with a slash; rm never does.
          case $verb in
            del|rd|rmdir)
              case $u in
                /[A-Za-z]|/[A-Za-z][A-Za-z]|/[A-Za-z][A-Za-z][A-Za-z]|/[A-Za-z]:*) ;;
                *) printf '%s\n' "$u" ;;
              esac ;;
            *) printf '%s\n' "$u" ;;
          esac ;;
      esac
    fi
    prev="$u"
  done
}

C='(^|[[:space:];&|(])'   # start of a command within the shell line

# ---------------------------------------------------------------- deny tier --

# Delete targets are judged by position. A root-ish, drive, system or credential
# target is unrecoverable; everything else is classified further down.
project="$(normalize_path "${ZCODE_PROJECT_DIR:-$PWD}")"
while IFS= read -r target; do
  [ -n "$target" ] || continue
  n="$(normalize_path "$target")"

  case $n in
    /)
      emit deny "Deleting the filesystem root removes the whole machine. Delete an explicit subpath instead, e.g. rm -rf ./build."
      exit 0 ;;
    /[a-z]|/[a-z]/|/[a-z]/\*)
      emit deny "Deleting an entire drive is unrecoverable and would take the operating system with it."
      exit 0 ;;
    '~'|'~/*'|'$HOME'|'$HOME/*'|'$env:USERPROFILE'|'$env:USERPROFILE/*')
      emit deny "Deleting the home directory root (or everything in it) loses keys, settings and work that are not in any repo. Delete an explicit subpath instead."
      exit 0 ;;
    '*'|'*.*'|.|..)
      emit deny "Deleting $target removes everything under the current directory with no undo path. Delete an explicit subpath instead."
      exit 0 ;;
    '~'/.ssh|'~'/.ssh/*|'~'/.aws|'~'/.aws/*|'~'/.gnupg|'~'/.gnupg/*|'~'/.config|'~'/.config/*|'~'/.zcode|'~'/.zcode/*|\
    '$HOME'/.ssh|'$HOME'/.ssh/*|'$HOME'/.aws|'$HOME'/.aws/*|'$HOME'/.gnupg|'$HOME'/.gnupg/*|'$HOME'/.config|'$HOME'/.config/*|'$HOME'/.zcode|'$HOME'/.zcode/*)
      emit deny "Deleting a user credential or config directory loses keys and settings that are not in any repo."
      exit 0 ;;
  esac

  # Temp space and the project itself are everyday cleanup.
  case $n in
    /tmp|/tmp/*|/var/tmp|/var/tmp/*) continue ;;
    "$project"|"$project"/*) continue ;;
  esac

  case $n in
    /usr|/usr/*|/etc|/etc/*|/bin|/bin/*|/sbin|/sbin/*|/lib|/lib/*|/opt|/opt/*|\
    /boot|/boot/*|/sys|/sys/*|/proc|/proc/*|/root|/root/*|/home|/home/*|\
    /[Ww]indows|/[Ww]indows/*|/[Pp]rogram[[:space:]][Ff]iles|/[Pp]rogram[[:space:]][Ff]iles/*|\
    /[Pp]rogram[[:space:]][Ff]iles[[:space:]]\([Xx]86\)|/[Pp]rogram[[:space:]][Ff]iles[[:space:]]\([Xx]86\)/*|\
    /[Uu]sers|/[Uu]sers/*|\
    /[a-z]/[Ww]indows|/[a-z]/[Ww]indows/*|/[a-z]/[Pp]rogram[[:space:]][Ff]iles|/[a-z]/[Pp]rogram[[:space:]][Ff]iles/*|\
    /[a-z]/[Pp]rogram[[:space:]][Ff]iles[[:space:]]\([Xx]86\)|/[a-z]/[Pp]rogram[[:space:]][Ff]iles[[:space:]]\([Xx]86\)/*)
      emit deny "Deleting a system directory is unrecoverable and would break the machine, not just the project."
      exit 0 ;;
  esac

  # A Windows profile root (C:\Users\<name>) and the credential/config dirs right
  # under it are unrecoverable; anything deeper is an ordinary outside-the-project
  # target and is confirmed instead of denied — regenerating plugin caches and
  # cleaning AppData subdirs is legitimate work.
  case $n in
    /[a-z]/[Uu]sers|/[a-z]/[Uu]sers/*)
      rest=${n#/[a-z]/[Uu]sers}
      rest=${rest#/}
      if [ -z "$rest" ]; then
        emit deny "Deleting the whole Users directory is unrecoverable."
        exit 0
      fi
      first=${rest%%/*}
      second=${rest#*/}
      second=${second%%/*}
      if [ "$rest" = "$first" ]; then
        emit deny "Deleting a user profile root loses settings, keys and work that are not in any repo."
        exit 0
      fi
      case $first in
        .ssh|.aws|.gnupg|.config|.zcode)
          emit deny "Deleting a user credential or config directory loses keys and settings that are not in any repo."
          exit 0 ;;
      esac
      case $second in
        .ssh|.aws|.gnupg|.config|.zcode)
          emit deny "Deleting a user credential or config directory loses keys and settings that are not in any repo."
          exit 0 ;;
      esac
      ;;
  esac

  case $n in
    ../*|*/../*|..)
      emit ask "Deleting $target reaches outside the project through a relative path. Confirm the resolved target before deleting."
      exit 0 ;;
    '~'/*|'$'*)
      emit ask "Deleting $target expands outside the project. Confirm the expanded path before deleting."
      exit 0 ;;
    /*)
      emit ask "Deleting $target, which is outside the project directory. Confirm this is intended and not a mistyped path."
      exit 0 ;;
  esac
done <<< "$(delete_targets)"

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

# Disk-level destruction, in POSIX and in Windows spelling.
rule deny "${C}(mkfs[A-Za-z0-9._]*|fdisk|parted)([[:space:]]|$)" \
  'Filesystem and partition tools destroy every byte on the target device.'
rule deny "${C}dd[[:space:]]+([^[:space:]]+[[:space:]]+)*of=/dev/" \
  'dd writing to a raw device overwrites the disk, including partition tables.'
rule deny ">[[:space:]]*/dev/(sd|nvme|hd|disk)" \
  'Redirecting output onto a raw block device corrupts the filesystem on it.'
rule deny "${C}chmod[[:space:]]+(-[A-Za-z]+[[:space:]]+)*777[[:space:]]+/([[:space:]]|$)" \
  'chmod 777 / makes the entire filesystem world-writable and is not reversible by re-running chmod.'
rule deny "${C}[Ff]ormat[[:space:]]+[A-Za-z]:" \
  'format erases the target drive. Take a verified backup first, and prefer formatting only a scratch volume.'
rule deny "${C}[Ff]ormat-[Vv]olume([[:space:]]|$)" \
  'Format-Volume erases the target volume, including everything on it.'
rule deny "${C}diskpart([[:space:]]|$)" \
  'diskpart rewrites partition tables and can erase any attached disk. Do this deliberately, outside an agent session.'
rule deny "${C}[Cc]lear-[Dd]isk([[:space:]]|$)" \
  'Clear-Disk wipes the partition table and every byte of data on the target disk.'
rule deny "${C}[Ii]nitialize-[Dd]isk([[:space:]]|$)" \
  'Initialize-Disk overwrites the partition table of the target disk, making its current data unreachable.'

# ----------------------------------------------------------------- ask tier --

# Deleting outside the project is not automatically wrong, but it is never
# routine, so it is confirmed once. Anything resolving inside the project never
# reaches this point — see the deny tier above.

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

# Windows registry keys are not in any repo and deletion is not undoable from
# the shell.
rule ask "${C}reg([[:space:]]+[^[:space:]]+)*[[:space:]]+delete([[:space:]]|$)" \
  'Deletes a registry key. Confirm the hive and path, and export it first if it matters.'

rule ask "(>|>>|tee[[:space:]]+)[[:space:]]*[^[:space:];&|]*(\.env($|[^.])|\.env\.(local|production|prod)|credentials|\.netrc|\.npmrc|\.pypirc|id_rsa|id_ed25519|\.pem($|[^A-Za-z]))" \
  'Writes to a credential file. Confirm the content is a placeholder and not a real secret, and that the file is git-ignored.'

exit 0

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
# The ask tier steps aside when the session runs in "yolo", the mode the UI
# calls full access and promises not to confirm step by step: ZCode applies a
# hook's ask on top of every permission mode, so without this the prompt would
# outlive full access. deny never steps aside, and a command that contains both
# is denied: every deny rule is evaluated before any ask is raised.
#
# Delete verbs are judged by where their targets point, not by which flags or
# spelling they use: rm, cmd's del/rd/rmdir and PowerShell's Remove-Item all run
# through the same position check, so clearing a build directory passes silently
# while anything outside the project is confirmed once. A find that deletes
# through -delete or -exec rm is judged by its starting points, and git clean
# by its flags. `git rm` is skipped: it only touches tracked files inside the
# repository, so git itself refuses anything that would escape it.
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

# No process is started where bash alone can do the job. The hook runs before
# every Bash call, and on Windows each process costs about 40ms: the original
# pipelines and per-rule greps added up to two seconds per call.
#
# stdin is read by cat on purpose. `read -d ''` would save that one process,
# but it reads byte by byte: about 1.6s for 1MB and more than the 5s the host
# allows for 4MB, after which the hook is dropped and nothing is checked.
payload="$(cat)"
[ -n "$payload" ] || exit 0
command_re='"command"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)"'
[[ $payload =~ $command_re ]] || exit 0
cmd=${BASH_REMATCH[1]}

# Top-level permission_mode from the payload, taken as the first match. Text in
# a command cannot forge it: its quotes arrive JSON-escaped. A nested key of the
# same name inside tool_input would have to come from the host, which rejects
# unknown keys for Bash and strips them for Write and Edit.
mode=""
mode_re='"permission_mode"[[:space:]]*:[[:space:]]*"([^"\\]*)"'
[[ $payload =~ $mode_re ]] && mode=${BASH_REMATCH[1]}

allow_file="${ZCODE_PROJECT_DIR:-.}/.zcode/guardrails-allow"
if [ -f "$allow_file" ]; then
  while IFS= read -r pattern; do
    pattern=${pattern%$'\r'}   # the file may be saved with CRLF
    case $pattern in ''|'#'*) continue ;; esac
    printf '%s' "$cmd" | grep -Eq "$pattern" 2>/dev/null && exit 0
  done < "$allow_file"
fi

emit() {
  local decision=$1 reason=$2
  # yolo suppresses ask (see the header). Signal that instead of exiting: the
  # delete-target loop must keep going, because a later target or a later rule
  # may still be a deny.
  [ "$decision" = ask ] && [ "$mode" = yolo ] && return 1
  # A control character would make the JSON invalid, and the host drops an
  # invalid decision: a deny would turn into a silent pass.
  reason=${reason//[[:cntrl:]]/ }
  reason=${reason//\\/\\\\}
  reason=${reason//\"/\\\"}
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"%s","permissionDecisionReason":"%s"}}\n' \
    "$decision" "$reason"
}

# Rules are only declared here and fired in two batches, one per tier: a
# single grep with every pattern of the tier decides whether any rule matches,
# and only then is the first matching rule looked up, in declaration order.
DENY_PATTERNS=() DENY_REASONS=() DENY_ARGS=()
ASK_PATTERNS=() ASK_REASONS=() ASK_ARGS=()
rule() {
  local decision=$1 pattern=$2 reason=$3
  if [ "$decision" = deny ]; then
    DENY_PATTERNS+=("$pattern") DENY_REASONS+=("$reason") DENY_ARGS+=(-e "$pattern")
  else
    ASK_PATTERNS+=("$pattern") ASK_REASONS+=("$reason") ASK_ARGS+=(-e "$pattern")
  fi
}

fire() {
  local tier=$1 i
  local -a patterns=() reasons=() args=()
  if [ "$tier" = deny ]; then
    patterns=(${DENY_PATTERNS[@]+"${DENY_PATTERNS[@]}"}) reasons=(${DENY_REASONS[@]+"${DENY_REASONS[@]}"}) args=(${DENY_ARGS[@]+"${DENY_ARGS[@]}"})
  else
    patterns=(${ASK_PATTERNS[@]+"${ASK_PATTERNS[@]}"}) reasons=(${ASK_REASONS[@]+"${ASK_REASONS[@]}"}) args=(${ASK_ARGS[@]+"${ASK_ARGS[@]}"})
  fi
  # The batch grep passing covers "no rule matches" and "grep rejects a
  # pattern" alike: this hook is never the reason a command fails.
  [ "${#patterns[@]}" -gt 0 ] || return 0
  printf '%s' "$cmd" | grep -Eq "${args[@]}" || return 0
  for i in "${!patterns[@]}"; do
    printf '%s' "$cmd" | grep -Eq -e "${patterns[$i]}" || continue
    emit "$tier" "${reasons[$i]}"
    exit 0
  done
}

# Placeholders for what the split in delete_targets must tell apart. The host
# sends valid JSON, where a control character is written \u0001: a raw one
# here could only come from an invalid payload.
MARK=$'\001'     # the \n of a path such as C:\new, protected from the line-break split
FOLDED=$'\002'   # a backslash that is only a character and escapes nothing
ESCAPED=$'\003'  # a separator made a literal by the backslash before it

# State of the find and the git clean that delete_targets is passing through.
# A find that ends in -delete or -exec rm deletes its starting points, so
# those are the real targets; the "{}" it hands to rm says nothing about
# where they are. TAB builds the markers that tell the caller where a listed
# target came from.
TAB=$'\t'
IN_FIND=0 FIND_EXPR=0 FIND_DELETES=0 FIND_NARROW=0 EXEC_NEXT=0 EXEC_SHELL=0 FIND_PATHS=()
IN_GIT=0 GIT_PENDING=0 IN_CLEAN=0 CLEAN_F=0 CLEAN_D=0 CLEAN_N=0

# Normalise a path for prefix comparison: backslashes to slashes (the JSON
# escaping doubles them), runs of slashes squeezed, and a Windows drive letter
# to the /c/… form that ZCODE_PROJECT_DIR and Git Bash both use. The result is
# left in NORMALIZED rather than printed by a subshell. The literals are held
# in quoted variables: a quoted variable is the only form that matches its
# characters exactly, which matters for a backslash and for a doubled slash.
normalize_path() {
  local backslash='\' pair='//' single='/'
  local p=${1//"$FOLDED"/$single}
  p=${p//"$backslash"/$single}
  while [[ $p == *"$pair"* ]]; do p=${p//"$pair"/$single}; done
  if [[ $p =~ ^([A-Za-z]):(/.*)?$ ]]; then
    # The drive letter is folded by a literal table: no process, and nothing
    # that could turn a letter that is already lower case into another byte.
    local rest=${BASH_REMATCH[2]}
    case ${BASH_REMATCH[1]} in
      A|a) p="/a$rest" ;; B|b) p="/b$rest" ;; C|c) p="/c$rest" ;; D|d) p="/d$rest" ;;
      E|e) p="/e$rest" ;; F|f) p="/f$rest" ;; G|g) p="/g$rest" ;; H|h) p="/h$rest" ;;
      I|i) p="/i$rest" ;; J|j) p="/j$rest" ;; K|k) p="/k$rest" ;; L|l) p="/l$rest" ;;
      M|m) p="/m$rest" ;; N|n) p="/n$rest" ;; O|o) p="/o$rest" ;; P|p) p="/p$rest" ;;
      Q|q) p="/q$rest" ;; R|r) p="/r$rest" ;; S|s) p="/s$rest" ;; T|t) p="/t$rest" ;;
      U|u) p="/u$rest" ;; V|v) p="/v$rest" ;; W|w) p="/w$rest" ;; X|x) p="/x$rest" ;;
      Y|y) p="/y$rest" ;; Z|z) p="/z$rest" ;;
    esac
  fi
  NORMALIZED=$p
}

# Strip the quote characters a shell would have removed, including the escaped
# form the JSON payload carries. The result is left in UNQUOTED.
unquote() {
  local s=$1
  s=${s#\\\"}; s=${s#\"}; s=${s#\'}
  s=${s%\\\"}; s=${s%\"}; s=${s%\'}
  UNQUOTED=$s
}

# Close the find being read and list its starting points if it deletes. A
# filter that comes before the deleting action narrows what it reaches, so
# such a starting point carries a marker and is never read as "everything
# under here". Without a filter it is exactly what rm would have been given,
# and no starting point at all means the current directory.
find_targets() {
  local p mark=""
  [ "$FIND_NARROW" = 1 ] && mark="find$TAB"
  if [ "$IN_FIND" = 1 ] && [ "$FIND_DELETES" = 1 ]; then
    if [ "${#FIND_PATHS[@]}" -gt 0 ]; then
      for p in ${FIND_PATHS[@]+"${FIND_PATHS[@]}"}; do printf '%s%s\n' "$mark" "$p"; done
    else
      printf '%s.\n' "$mark"
    fi
  fi
  IN_FIND=0 FIND_EXPR=0 FIND_DELETES=0 FIND_NARROW=0 EXEC_NEXT=0 EXEC_SHELL=0 FIND_PATHS=()
}

# Close the git clean being read. Forced removal of untracked directories is
# denied unless it is a dry run or interactive; the caller lists it as a rule.
clean_end() {
  if [ "$IN_CLEAN" = 1 ] && [ "$CLEAN_F" = 1 ] && [ "$CLEAN_D" = 1 ] && [ "$CLEAN_N" = 0 ]; then
    printf 'rule\tgit clean\n'
  fi
  IN_CLEAN=0 CLEAN_F=0 CLEAN_D=0 CLEAN_N=0
}

# Collect the non-option arguments of every delete verb in the command line:
# rm, cmd's del/rd/rmdir and PowerShell's Remove-Item, plus the starting points
# of a deleting find. No shell expansion happens here, so $VAR and $(…)
# targets stay opaque and are treated as outside the project by the caller.
delete_targets() {
  local -a tokens
  local t u in_del=0 verb="" prev=""
  # An operator glued to the word before it ("dir; echo", "a&&b"), a line
  # break and a tab separate words just like a space or a spaced ";" does.
  # Spacing them out first lets the loop below see them. The command is still
  # JSON-escaped, so a line break is the two characters \n, a tab \t and a
  # backslash two.
  local split="$cmd" pair='\\' run='\\\\' tab='\t' literal_tab='\\t'
  local line_break='\n' escaped_newline='\\n'
  local after_pipe=0 in_xargs=0 pipe_narrowed=0 mark="" i
  local -a pipe_paths=()
  # A backslash makes the next character a literal one: "a\|b" in a grep
  # pattern, or the "\;" that ends find's -exec. In the escaped text it is a
  # pair, which is also how one plain backslash arrives, so runs are folded
  # first: a FOLDED is a plain backslash and escapes nothing.
  split="${split//"$run"/$FOLDED}"
  split="${split//"$pair;"/$ESCAPED}"
  split="${split//"$pair&"/$ESCAPED}"
  split="${split//"$pair|"/$ESCAPED}"
  # "\t" as two characters is an escape for printf or a grep pattern.
  split="${split//"$literal_tab"/${FOLDED}t}"
  # The same two characters followed by "ew" are the start of C:\new, a path.
  split="${split//"$escaped_newline"/$MARK}"
  split="${split//"$line_break"/$' ; '}"
  split="${split//"$tab"/ }"
  split="${split//;/$' ; '}"
  split="${split//&/$' & '}"
  split="${split//|/$' | '}"
  split="${split//"$MARK"/$escaped_newline}"
  read -ra tokens <<< "$split"
  for t in ${tokens[@]+"${tokens[@]}"}; do
    unquote "$t"
    u=$UNQUOTED
    case $u in
      ';'|'|'|'&')
        in_del=0; prev="$u"
        if [ "$u" = '|' ]; then
          # A find on the left of a pipe hands its starting points to a
          # delete on the right.
          if [ "$IN_FIND" = 1 ]; then
            pipe_paths=(${FIND_PATHS[@]+"${FIND_PATHS[@]}"}) pipe_narrowed=$FIND_NARROW
          fi
          after_pipe=1
        elif [ "$after_pipe" = 1 ] && [ "$u" = ';' ]; then
          :   # a line break right after a pipe only continues the line
        else
          pipe_paths=() after_pipe=0
        fi
        find_targets
        clean_end
        in_xargs=0
        continue ;;
      "$ESCAPED") continue ;;
    esac
    if [ "$after_pipe" = 1 ]; then
      after_pipe=0
      case $u in
        sudo|doas|env|command|nohup|time|nice|*=*) after_pipe=1; prev="$u"; continue ;;
        xargs|*/xargs) in_xargs=1; prev="$u"; continue ;;
      esac
    fi
    if [ "$in_xargs" = 1 ]; then
      case $u in
        -*) : ;;
        rm|*/rm|del|*/del|rd|*/rd|rmdir|*/rmdir|Remove-Item|remove-item)
          mark=""
          [ "$pipe_narrowed" = 1 ] && mark="find$TAB"
          for p in ${pipe_paths[@]+"${pipe_paths[@]}"}; do printf '%s%s\n' "$mark" "$p"; done
          in_xargs=0 ;;
      esac
    fi
    # A deleting find is only read from a command start: "echo find /etc
    # -delete" spells a delete without running one.
    case $u in
      find|*/find)
        case $prev in
          ''|';'|'|'|'&'|'('|sudo|doas|env|command|nohup|time|nice|xargs|then|do|else|elif)
            find_targets; IN_FIND=1 ;;
        esac
        prev="$u"
        continue ;;
    esac
    if [ "$IN_FIND" = 1 ]; then
      # -H, -L, -D and -O are options that may precede the starting points.
      case $u in -H|-L|-D|-O) [ "$FIND_EXPR" = 1 ] || continue ;; esac
      # Until the expression starts, the arguments are the starting points.
      case $u in -*|'('*|'!'*|'\\'*) FIND_EXPR=1 ;; *) [ "$FIND_EXPR" = 1 ] || { FIND_PATHS+=("$u"); prev="$u"; continue; } ;; esac
      case $u in
        # A filter before the deleting action narrows what it reaches. -type
        # alone does not: every file under the starting point still goes.
        -name|-iname|-path|-ipath|-regex|-iregex|-size|-mtime|-mmin|-atime|-ctime|-newer|-mnewer|-anewer|-user|-group|-perm|-empty|-inum|-links)
          [ "$FIND_DELETES" = 1 ] || FIND_NARROW=1 ;;
        -delete) FIND_DELETES=1 ;;
        -exec|-execdir|-ok|-okdir) EXEC_NEXT=1 ;;
        sh|bash|dash|zsh|cmd|powershell|pwsh)
          # A shell started by -exec runs whatever follows it, rm included.
          [ "$EXEC_NEXT" = 1 ] && EXEC_SHELL=1
          EXEC_NEXT=0 ;;
        # Still on the way from -exec to the command it runs.
        sudo|doas|env|command|nohup|time|nice|timeout|[0-9]*|*=*) : ;;
        *)
          if [ "$EXEC_NEXT" = 1 ]; then
            EXEC_NEXT=0
            case $u in rm|*/rm|del|*/del|rd|*/rd|rmdir|*/rmdir|Remove-Item|remove-item) FIND_DELETES=1 ;; esac
          fi ;;
      esac
      if [ "$EXEC_SHELL" = 1 ]; then
        case $u in rm|*/rm|del|*/del|rd|*/rd|rmdir|*/rmdir|Remove-Item|remove-item) FIND_DELETES=1 ;; esac
      fi
    fi
    # git clean is read from its flags, because they come combined or apart
    # in any order and a dry run or an interactive run deletes nothing.
    case $u in
      '(git') IN_GIT=1; GIT_PENDING=0; prev="$u"; continue ;;
      git|*/git)
        # Anywhere a command can start, an assignment or a wrapper included.
        case $prev in
          ''|';'|'|'|'&'|'('|sudo|doas|env|command|nohup|time|nice|xargs|then|do|else|elif|*=*) IN_GIT=1 ;;
        esac
        GIT_PENDING=0
        prev="$u"
        continue ;;
      clean) [ "$IN_GIT" = 1 ] && { IN_CLEAN=1; IN_GIT=0; } ;;
    esac
    if [ "$IN_GIT" = 1 ]; then
      case $u in
        -C|-c|--git-dir|--work-tree|--namespace|--config-env) GIT_PENDING=1 ;;
        -*) : ;;
        *) if [ "$GIT_PENDING" = 1 ]; then GIT_PENDING=0; else IN_GIT=0; fi ;;
      esac
    fi
    if [ "$IN_CLEAN" = 1 ]; then
      case $u in
        clean) : ;;
        --force) CLEAN_F=1 ;;
        --dry-run|--interactive) CLEAN_N=1 ;;
        --dir) CLEAN_D=1 ;;
        -[!-]*)
          i=1
          while [ "$i" -lt "${#u}" ]; do
            case ${u:i:1} in
              f) CLEAN_F=1 ;;
              n|i) CLEAN_N=1 ;;
              d|x|X) CLEAN_D=1 ;;
            esac
            i=$((i + 1))
          done ;;
      esac
    fi
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
  find_targets
  clean_end
}

# Start of a command within the shell line. A line break and a tab count as
# well: the command is still JSON-escaped there, so each is two characters.
C='(^|[[:space:];&|(]|\\n|\\t)'

# ---------------------------------------------------------------- deny tier --

# Delete targets are judged by position. A root-ish, drive, system or credential
# target is unrecoverable and denied at once. A target outside the project is
# only remembered here: the deny rules below still have to run first, because
# deny wins over ask in every mode.
normalize_path "${ZCODE_PROJECT_DIR:-$PWD}"
project=$NORMALIZED
outside_delete=""
while IFS= read -r target; do
  [ -n "$target" ] || continue
  # git clean denies here rather than by a pattern: its flags cannot be read
  # reliably from the still-escaped command text.
  if [ "$target" = "rule${TAB}git clean" ]; then
    emit deny "git clean -fd deletes untracked files and directories permanently, including files never added to git. Run git clean -nd first to see the list."
    exit 0
  fi
  # The starting point of a filtered find is narrowed by that filter.
  narrowed=0
  case $target in
    find$'\t'*) narrowed=1; target=${target#find$'\t'} ;;
  esac
  # The target is quoted in the reasons; a folded backslash is shown as one.
  target=${target//"$FOLDED"/\\}
  normalize_path "$target"
  n=$NORMALIZED

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
      if [ "$narrowed" = 0 ]; then
        emit deny "Deleting $target removes everything under the current directory with no undo path. Delete an explicit subpath instead."
        exit 0
      fi ;;
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
      [ -n "$outside_delete" ] || outside_delete="Deleting $target reaches outside the project through a relative path. Confirm the resolved target before deleting." ;;
    '~'/*|'$'*)
      [ -n "$outside_delete" ] || outside_delete="Deleting $target expands outside the project. Confirm the expanded path before deleting." ;;
    /*)
      [ -n "$outside_delete" ] || outside_delete="Deleting $target, which is outside the project directory. Confirm this is intended and not a mistyped path." ;;
  esac
done <<< "$(delete_targets)"

rule deny "${C}git([[:space:]]+[^[:space:]]+)*[[:space:]]+push([[:space:]]+[^[:space:]]+)*[[:space:]]+(--force([[:space:]]|$)|-f([[:space:]]|$))" \
  'git push --force overwrites remote history and can destroy commits other people already pulled. Use --force-with-lease, which refuses when the remote moved.'
rule deny "${C}git([[:space:]]+[^[:space:]]+)*[[:space:]]+reset[[:space:]]+(--hard|--merge)" \
  'git reset --hard discards every uncommitted change with no reflog entry for the working tree. Use git stash to park the work first.'
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

fire deny

# A delete reaching outside the project was remembered in the deny tier. It is
# not automatically wrong, but it is never routine, so it is confirmed once —
# and only here, after every deny rule has had its chance. Anything resolving
# inside the project never reaches this point.
if [ -n "$outside_delete" ]; then
  emit ask "$outside_delete"
  exit 0
fi

# ----------------------------------------------------------------- ask tier --

# Everything below runs after every deny rule, so an ask that yolo suppresses
# may end the script here.

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

fire ask

exit 0

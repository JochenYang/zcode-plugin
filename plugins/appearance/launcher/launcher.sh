#!/bin/sh
# The stand-in for the launcher program on macOS and Linux, where nothing is compiled: it is the
# program inside the .app bundle (Contents/MacOS/<name>) and the script behind the desktop entry.
# It does one thing: start `node <launcher script>` with no terminal and leave the stage. The
# launcher itself (bin/launch.mjs) does the work and reports its own failures.
#
# bin/setup-launcher.mjs copies this file next to a launch-path.txt (Linux) or into a bundle
# whose Resources folder holds one (macOS). POSIX sh only: it runs under /bin/sh on both systems
# and under whatever sh a desktop has put in its place.

title=${0##*/}
# The folder of this program: an .app and a desktop entry both start it by its full path; a
# bare name means it was started from the folder it is in.
case $0 in */*) self_folder=${0%/*} ;; *) self_folder=. ;; esac
home=$(CDPATH= cd -- "$self_folder" && pwd -P)

# Says what went wrong, in a dialog where the desktop has one and always in the log next to this
# program. A test or a script that cannot answer a dialog asks for silence.
fail() {
  printf '%s\n%s\n\n' "$1" "$(date '+%Y-%m-%dT%H:%M:%S')" >> "$home/launcher-error.log" 2>/dev/null || true
  if [ "$ZCODE_APPEARANCE_LAUNCHER_QUIET" != "1" ]; then
    if command -v osascript >/dev/null 2>&1; then
      osascript -e 'on run argv' -e 'display alert (item 1 of argv) message (item 2 of argv) as critical' -e 'end run' "$title" "$1" >/dev/null 2>&1 || true
    elif command -v zenity >/dev/null 2>&1; then
      zenity --error --title="$title" --text="$1" >/dev/null 2>&1 || true
    elif command -v notify-send >/dev/null 2>&1; then
      notify-send -u critical "$title" "$1" >/dev/null 2>&1 || true
    fi
  fi
  exit 1
}

# node as this desktop sees it. A program started from the Dock or the applications list gets
# the system PATH, not the one of a login shell, so Homebrew, nvm, volta and fnm are looked at
# by hand. ZCODE_APPEARANCE_NODE names one outright.
node_bin=$ZCODE_APPEARANCE_NODE
if [ -z "$node_bin" ]; then
  if command -v node >/dev/null 2>&1; then
    node_bin=$(command -v node)
  else
    for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$HOME/.fnm/aliases/default/bin/node"; do
      if [ -x "$candidate" ]; then
        node_bin=$candidate
        break
      fi
    done
    if [ -z "$node_bin" ] && [ -d "$HOME/.nvm/versions/node" ]; then
      latest=$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | tail -n 1)
      if [ -n "$latest" ] && [ -x "$HOME/.nvm/versions/node/$latest/bin/node" ]; then
        node_bin="$HOME/.nvm/versions/node/$latest/bin/node"
      fi
    fi
  fi
fi

pathfile=
for candidate in "$home/launch-path.txt" "$home/../Resources/launch-path.txt"; do
  if [ -f "$candidate" ]; then
    pathfile=$candidate
    break
  fi
done
[ -n "$pathfile" ] || fail "找不到启动脚本的位置。

$home/launch-path.txt 不存在。重新运行一次安装命令即可修复。"

# The first line that says something.
script=
while IFS= read -r line || [ -n "$line" ]; do
  line=$(printf '%s' "$line" | tr -d ' \t\r')
  if [ -n "$line" ]; then
    script=$line
    break
  fi
done < "$pathfile"
[ -n "$script" ] || fail "启动脚本的位置没有记下来（$pathfile 是空的）。重新运行一次安装命令即可修复。"
[ -f "$script" ] || fail "启动脚本不在记录的位置了：

$script

插件可能被更新到了别的目录，或者被移走了。重新运行一次安装命令即可修复。"
[ -n "$node_bin" ] || fail "启动器需要 Node.js 22 或更新版本。没有找到 node：装好以后重新登录一次，或者把它的位置写进环境变量 ZCODE_APPEARANCE_NODE。"

# The user's own folder, not the script's: ZCode is started from the launcher and inherits this
# folder, and whatever the app then writes "next to itself" lands in the user's folder.
cd -- "${HOME:-/}" || exit 1
# nohup: the launcher outlives this program, and whatever started it.
ZCODE_APPEARANCE_NO_CONSOLE=1 nohup "$node_bin" "$script" >/dev/null 2>&1 &
exit 0

#!/usr/bin/env node
// Puts the launcher where a person starts programs from: the taskbar and the Start menu on
// Windows, the Dock on macOS, the applications list on Linux.
//
//   node bin/setup-launcher.mjs [--name "<name>"] [--dir <folder>] [--zcode <ZCode>]
//                               [--copy | --link] [--no-shortcut]
//   node bin/setup-launcher.mjs --uninstall [--name "<name>"] [--dir <folder>]
//
// What it makes depends on the system, because only Windows has a compiler built in:
//   Windows   <dir>/<name>.exe (launcher/Launcher.cs, compiled with the C# compiler Windows
//             ships), launch-path.txt, a shortcut in the Start menu
//   macOS     <dir>/<name>.app: launcher/launcher.sh as its program, launcher/Info.plist, the
//             icon file of the installed ZCode.app; the default <dir> is ~/Applications
//   Linux     a copy of launcher/launcher.sh and launch-path.txt in <dir> (by default
//             ~/.local/opt/<name>), the icon as a PNG, and an entry in the applications list
//             (launcher/launcher.desktop)
// With --copy the launcher's own files go in as well (app/), so it stands on its own when the
// plugin moves to another version's folder. The icon is taken from the installed ZCode when
// this runs, so the repository carries neither a binary nor Z.AI's icon.
//
// Where ZCode is, is found the way the launcher finds it (src/launcher.mjs, resolveZcode):
// what was configured, a running copy, what the installer told the system, the usual folders.
//
// Pinning the result to the taskbar, the Dock or a favorites bar is left to the person: no
// system has a supported way to do that from a program.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveZcode } from '../src/launcher.mjs';

export const DEFAULT_NAME = 'ZCode Appearance';
export const DEFAULT_DESCRIPTION = 'Start ZCode with a custom background';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHERS = path.join(PLUGIN, 'launcher');
const TEMPLATE = path.join(LAUNCHERS, 'Launcher.cs');
const ICON_SCRIPT = path.join(LAUNCHERS, 'make-icon.ps1');
const STUB = path.join(LAUNCHERS, 'launcher.sh');
const PLIST = path.join(LAUNCHERS, 'Info.plist');
const DESKTOP_ENTRY = path.join(LAUNCHERS, 'launcher.desktop');
const LAUNCH_SCRIPT = path.join(PLUGIN, 'bin', 'launch.mjs');
// Where Windows keeps its compiler, the 64-bit one first.
const COMPILERS = [
  path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
];

export class SetupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SetupError';
  }
}

const isWindows = (platform = process.platform) => platform === 'win32';
// Paths for a system other than this one (the layouts are made for it, and tested here) are
// joined the way that system spells them.
const joiner = (platform) => (platform === 'win32' ? path.join : path.posix.join);
// What can go into a file name; everything else goes, and so do the edges' spaces.
export const fileNameOf = (name) => name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '').trim();
// The same name as an identifier (a bundle id, the file name of a desktop entry): lowercase
// letters and digits joined by dashes. A name with none of either, such as one in Chinese,
// takes the fallback.
export const idOf = (name, fallback = 'zcode-appearance') => fileNameOf(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || fallback;

// The folder the launcher goes into when none was named.
export function defaultDir(name, { env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const file = fileNameOf(name);
  const join = joiner(platform);
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), file);
  if (platform === 'darwin') return join(home, 'Applications');
  return join(home, '.local', 'opt', idOf(name));
}

export function parseArgs(argv, { env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const args = { name: DEFAULT_NAME, dir: null, zcode: null, mode: 'link', shortcut: true, uninstall: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new SetupError(`${arg} 后面要跟一个值`);
      i += 1;
      return next;
    };
    if (arg === '--name') args.name = value().trim() || args.name;
    else if (arg === '--dir') args.dir = path.resolve(value());
    else if (arg === '--zcode') args.zcode = path.resolve(value());
    else if (arg === '--copy') args.mode = 'copy';
    else if (arg === '--link') args.mode = 'link';
    else if (arg === '--no-shortcut') args.shortcut = false;
    else if (arg === '--uninstall') args.uninstall = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new SetupError(`不认识的选项：${arg}（--help 看用法）`);
  }
  if (!fileNameOf(args.name)) throw new SetupError('名称里至少要有一个能用作文件名的字符');
  if (!args.dir) args.dir = defaultDir(args.name, { env, platform, home });
  return args;
}

export function helpText({ platform = process.platform, home = os.homedir() } = {}) {
  const join = joiner(platform);
  const made = {
    win32: ['做一个带 ZCode 图标、名称自定义的启动器程序，放进自己的目录，并在开始菜单建快捷方式。', '--dir <目录>       放启动器的目录（默认 LocalAppData 下以名称命名的目录）。'],
    darwin: ['做一个带 ZCode 图标、名称自定义的启动器（.app），放进指定的文件夹，可以拖到程序坞。', `--dir <目录>       放 .app 的文件夹（默认 ${join(home, 'Applications')}）。`],
    linux: ['做一个带 ZCode 图标、名称自定义的启动脚本，放进自己的目录，并在应用列表里加一个条目。', `--dir <目录>       放启动脚本的目录（默认 ${join(home, '.local', 'opt', '<名称>')}）。`],
  }[platform];
  if (!made) return `这个系统（${platform}）上做不了启动器：只有 Windows、macOS 和 Linux 有配套的做法。\n`;
  const pin = {
    win32: '固定到任务栏：在开始菜单里找到它，右键 →「固定到任务栏」（Windows 不允许程序替你做这一步）。',
    darwin: '加到程序坞：在访达里打开它所在的文件夹，把 .app 拖到程序坞。',
    linux: '加到收藏或任务栏：在应用列表里找到它 → 右键 → 添加到收藏（GNOME）或固定到任务栏（KDE）。',
  }[platform];
  const shortcut = platform === 'linux' ? '--no-shortcut      不在应用列表里加条目。' : platform === 'darwin' ? '--no-shortcut      没有作用（macOS 上没有快捷方式这一步）。' : '--no-shortcut      不在开始菜单建快捷方式。';
  return `用法：node bin/setup-launcher.mjs [选项]

${made[0]}

--name <名称>      启动器显示的名称（默认 "${DEFAULT_NAME}"）。
${made[1]}
--zcode <路径>    ZCode 可执行文件的位置；不填就自动找（图标从这里取）。
--copy             把启动器的文件也复制进去，插件换了目录也不受影响（插件更新后要重新运行）。
--link             只记下启动脚本的位置，始终用这个插件目录里的代码（默认；目录没了启动器就失效）。
${shortcut}
--uninstall        删除启动器（Windows 连同快捷方式，Linux 连同应用列表里的条目）。

${pin}
`;
}

// ---------------------------------------------------------------- Windows, through PowerShell

// A script travels base64-encoded as UTF-16 by default: no quoting of paths, any characters in
// them. `-Command` is for the steps that print something to read back in UTF-8.
function powershell(script, { encoded = true } = {}) {
  const command = encoded
    ? ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
    : ['-NoProfile', '-NonInteractive', '-Command', script];
  const out = spawnSync('powershell', command, { encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  if (out.error) throw new SetupError(`PowerShell 没能启动：${out.error.message}`);
  return { code: out.status, out: String(out.stdout ?? '').trim(), err: String(out.stderr ?? '').trim() };
}
const ps = (text) => `'${String(text).replace(/'/g, "''")}'`;

// Where the Start menu of this user keeps its programs.
function startMenuPrograms() {
  const run = powershell("[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Environment]::GetFolderPath('StartMenu')", { encoded: false });
  if (run.code !== 0) throw new SetupError(`找不到开始菜单的位置：${run.err}`);
  return path.join(run.out, 'Programs');
}
// The output of a PowerShell step that prints UTF-8, read back as UTF-8 whatever the console says.
function utf8Step(script) {
  const prefix = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ';
  const run = powershell(prefix + script, { encoded: false });
  if (run.code !== 0) throw new SetupError(`PowerShell 这一步没有成功（退出码 ${run.code}）：${run.err || run.out}`);
  return run.out;
}

// ---------------------------------------------------------------- what they have in common

/**
 * The ZCode executable, found the way the launcher finds it unless `zcode` names one, and next
 * to it the picture its icon is taken from: a PNG beside the executable on Windows and Linux,
 * the icon file inside ZCode.app on macOS. Whatever was not found is null.
 *
 * @param {{ zcode?: string | null, env?: NodeJS.ProcessEnv, platform?: string }} [options]
 * @returns {Promise<{ exe: string | null, png: string | null, icns: string | null }>}
 */
export async function findIcon({ zcode = null, env = process.env, platform = process.platform } = {}) {
  const exe = await resolveZcode({ configured: zcode, env, platform });
  if (!exe) return { exe: null, png: null, icns: null };
  // Through links: a /usr/bin/zcode that points into /opt/ZCode has its pictures over there.
  let real = exe;
  try {
    real = fs.realpathSync.native(exe);
  } catch {
    // It was there a moment ago; the caller's check of `exe` stands.
  }
  if (platform === 'darwin') {
    // <ZCode.app>/Contents/MacOS/ZCode: the pictures are in Contents/Resources.
    const resources = path.join(path.dirname(path.dirname(real)), 'Resources');
    const icns = fs.existsSync(resources) ? fs.readdirSync(resources).find((name) => name.toLowerCase().endsWith('.icns')) : undefined;
    if (icns) return { exe, png: null, icns: path.join(resources, icns) };
    const png = path.join(resources, 'icon.png');
    return { exe, png: fs.existsSync(png) ? png : null, icns: null };
  }
  for (const name of ['icon_windows.png', 'icon.png']) {
    const png = path.join(path.dirname(real), 'resources', name);
    if (fs.existsSync(png)) return { exe, png, icns: null };
  }
  return { exe, png: null, icns: null };
}

// What the launcher needs to run: its entry and everything it imports.
const LAUNCHER_FILES = ['bin/launch.mjs', ...fs.readdirSync(path.join(PLUGIN, 'src')).filter((name) => name.endsWith('.mjs')).map((name) => path.join('src', name))];

// The script the launcher is pointed at. With --copy the launcher's own files go into `app/`
// under `home` and the script is that copy; otherwise it is the one in this plugin's folder.
function launcherScriptFor(home, mode) {
  if (mode !== 'copy') return LAUNCH_SCRIPT;
  const app = path.join(home, 'app');
  fs.rmSync(app, { recursive: true, force: true });
  for (const relative of LAUNCHER_FILES) {
    const target = path.join(app, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(PLUGIN, relative), target);
  }
  return path.join(app, 'bin', 'launch.mjs');
}

const fill = (text, values) => Object.entries(values).reduce((out, [key, value]) => out.replaceAll(key, value), text);
const xml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// A desktop entry's Exec value: the path in double quotes, with what the format reserves escaped.
const execValue = (text) => `"${String(text).replace(/[\\"`$]/g, '\\$&')}"`;
const entryValue = (text) => String(text).replace(/\\/g, '\\\\').replace(/\r?\n/g, ' ');

// ---------------------------------------------------------------- Windows

/**
 * Compiles the program into `outDir`.
 *
 * @param {{ outDir: string, name: string, description?: string, script: string, png?: string | null }} options
 *   `script` is the launcher script the program will start; `png` the picture for the icon, if any
 * @returns {{ exe: string, file: string, icon: string | null }}
 */
export function buildLauncher({ outDir, name, description = DEFAULT_DESCRIPTION, script, png = null }) {
  if (!isWindows()) throw new SetupError('启动器程序只能在 Windows 上做（用的是 Windows 自带的 C# 编译器）。');
  const file = fileNameOf(name);
  if (!file) throw new SetupError(`名称不能用以作文件名：${name}`);
  const compiler = COMPILERS.find((candidate) => fs.existsSync(candidate));
  if (!compiler) throw new SetupError('没有找到 Windows 自带的 C# 编译器（csc.exe，在 .NET Framework 4 里）。');
  if (!fs.existsSync(TEMPLATE)) throw new SetupError(`找不到启动器的源码：${TEMPLATE}`);
  if (!fs.existsSync(script)) throw new SetupError(`启动脚本不存在：${script}`);

  fs.mkdirSync(outDir, { recursive: true });
  const source = path.join(outDir, 'Launcher.cs');
  const escape = (text) => String(text).replace(/(["\\])/g, '\\$1');
  fs.writeFileSync(source, fill(fs.readFileSync(TEMPLATE, 'utf8'), { __TITLE__: escape(name), __DESCRIPTION__: escape(description) }));

  let icon = null;
  if (png && fs.existsSync(png)) {
    icon = path.join(outDir, 'app.ico');
    const made = utf8Step(`& ${ps(ICON_SCRIPT)} -Source ${ps(png)} -Out ${ps(icon)}`);
    if (!fs.existsSync(icon)) throw new SetupError(`图标没有生成：${made}`);
  }

  const exe = path.join(outDir, `${file}.exe`);
  const compiled = spawnSync(compiler, [
    '/nologo',
    '/target:winexe',
    '/optimize+',
    '/warn:0',
    ...(icon ? [`/win32icon:${icon}`] : []),
    '/reference:System.dll',
    '/reference:System.Windows.Forms.dll',
    `/out:${exe}`,
    source,
  ], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  if (compiled.error) throw new SetupError(`编译器没能启动：${compiled.error.message}`);
  if (compiled.status !== 0 || !fs.existsSync(exe)) {
    throw new SetupError(`编译没有成功（退出码 ${compiled.status}）：${String(compiled.stdout ?? '').trim().slice(0, 600)}`);
  }
  // The source stays next to the program: what runs can be read.
  return { exe, file, icon, hasIcon: Boolean(icon), compiler };
}

function setupWindows({ file, name, description, outDir, icon, mode, shortcut }) {
  // The launcher is told by its own location where the config lives; nothing else is written
  // into the folder, so it is this command's to replace.
  const script = launcherScriptFor(outDir, mode);
  const built = buildLauncher({ outDir, name, description, script, png: icon.png });
  fs.writeFileSync(path.join(outDir, 'launch-path.txt'), `${script}\n`);

  let link = null;
  if (shortcut) {
    const programs = startMenuPrograms();
    fs.mkdirSync(programs, { recursive: true });
    link = path.join(programs, `${file}.lnk`);
    utf8Step(
      `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${ps(link)}); `
      + `$s.TargetPath = ${ps(built.exe)}; $s.WorkingDirectory = ${ps(outDir)}; $s.IconLocation = ${ps(`${built.exe},0`)}; `
      + `$s.Description = ${ps(description)}; $s.Save()`,
    );
    if (!fs.existsSync(link)) throw new SetupError(`快捷方式没有建成：${link}`);
  }
  return { exe: built.exe, file, script, hasIcon: built.hasIcon, shortcut: link, compiler: built.compiler };
}

function uninstallWindows({ file, outDir }) {
  const exe = path.join(outDir, `${file}.exe`);
  const removed = [];
  if (!fs.existsSync(exe) || !fs.existsSync(path.join(outDir, 'launch-path.txt'))) return { removed, kept: outDir };
  const link = path.join(startMenuPrograms(), `${file}.lnk`);
  if (fs.existsSync(link)) {
    // Only a shortcut that points at this program; one of another program with the same name stays.
    const target = utf8Step(`$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${ps(link)}); [Console]::Write($s.TargetPath)`);
    if (path.resolve(target) === path.resolve(exe)) {
      fs.rmSync(link);
      removed.push(link);
    }
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  removed.push(outDir);
  return { removed, kept: null };
}

// ---------------------------------------------------------------- macOS

// The .app is a folder with a fixed shape; the program inside is the shell stub, which finds
// its path file one level up in Resources.
function setupMac({ file, name, description, outDir, icon, mode }) {
  const bundle = path.join(outDir, `${file}.app`);
  const contents = path.join(bundle, 'Contents');
  const resources = path.join(contents, 'Resources');
  if (fs.existsSync(bundle) && !(fs.existsSync(path.join(contents, 'MacOS', file)) && fs.existsSync(path.join(resources, 'launch-path.txt')))) {
    throw new SetupError(`${bundle} 已经有了，而且不是这个命令做出来的；换一个 --name 或 --dir。`);
  }
  fs.rmSync(bundle, { recursive: true, force: true });
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  const program = path.join(contents, 'MacOS', file);
  fs.copyFileSync(STUB, program);
  fs.chmodSync(program, 0o755);
  fs.writeFileSync(path.join(contents, 'Info.plist'), fill(fs.readFileSync(PLIST, 'utf8'), {
    __TITLE__: xml(name), __EXECUTABLE__: xml(file), __BUNDLE_ID__: xml(`app.zcode-appearance.${idOf(name)}`),
  }));

  let hasIcon = false;
  const iconFile = path.join(resources, 'AppIcon.icns');
  if (icon.icns || icon.png) {
    fs.mkdirSync(resources, { recursive: true });
    if (icon.icns) {
      fs.copyFileSync(icon.icns, iconFile);
      hasIcon = true;
    } else {
      // One picture, made into an icon file by the tool every macOS has.
      const made = spawnSync('sips', ['-s', 'format', 'icns', icon.png, '--out', iconFile], { encoding: 'utf8', timeout: 60_000 });
      hasIcon = made.status === 0 && fs.existsSync(iconFile);
      if (!hasIcon) fs.rmSync(iconFile, { force: true });
    }
  }

  const script = launcherScriptFor(resources, mode);
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, 'launch-path.txt'), `${script}\n`);
  return {
    exe: program, file, script, hasIcon, shortcut: null, bundle,
    pin: `加到程序坞：在访达里打开 ${outDir}，把 ${file}.app 拖到程序坞。`,
  };
}

function uninstallMac({ file, outDir }) {
  const bundle = path.join(outDir, `${file}.app`);
  const removed = [];
  // Only a bundle this command made: its program of that name and the path file in Resources.
  if (!fs.existsSync(path.join(bundle, 'Contents', 'MacOS', file)) || !fs.existsSync(path.join(bundle, 'Contents', 'Resources', 'launch-path.txt'))) {
    return { removed, kept: bundle };
  }
  fs.rmSync(bundle, { recursive: true, force: true });
  removed.push(bundle);
  return { removed, kept: null };
}

// ---------------------------------------------------------------- Linux

// The file name of the entry in the applications list, under the data folder of the desktop
// (XDG_DATA_HOME, by default ~/.local/share).
function desktopEntryPath(name, { env = process.env, home = os.homedir() } = {}) {
  return path.posix.join(env.XDG_DATA_HOME ?? path.posix.join(home, '.local', 'share'), 'applications', `${idOf(name)}.desktop`);
}

function setupLinux({ name, description, outDir, icon, mode, shortcut, env }) {
  const script = launcherScriptFor(outDir, mode);
  fs.mkdirSync(outDir, { recursive: true });
  const wrapper = path.join(outDir, idOf(name));
  fs.copyFileSync(STUB, wrapper);
  fs.chmodSync(wrapper, 0o755);
  fs.writeFileSync(path.join(outDir, 'launch-path.txt'), `${script}\n`);
  let picture = null;
  if (icon.png) {
    picture = path.join(outDir, 'icon.png');
    fs.copyFileSync(icon.png, picture);
  }

  let entry = null;
  if (shortcut) {
    entry = desktopEntryPath(name, { env });
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, fill(fs.readFileSync(DESKTOP_ENTRY, 'utf8'), {
      __TITLE__: entryValue(name), __DESCRIPTION__: entryValue(description), __EXECUTABLE__: execValue(wrapper), __ICON__: picture ?? 'applications-development',
    }));
  }
  return {
    exe: wrapper, file: idOf(name), script, hasIcon: Boolean(picture), shortcut: entry,
    pin: '加到收藏或任务栏：在应用列表里找到它 → 右键 → 添加到收藏（GNOME）或固定到任务栏（KDE）；别的桌面各有各的做法。',
  };
}

// Whether the entry starts this wrapper and nothing else.
function entryPointsAt(entry, wrapper) {
  const line = fs.readFileSync(entry, 'utf8').split(/\r?\n/).find((text) => text.startsWith('Exec='));
  if (!line) return false;
  const match = /^Exec=("([^"]*)"|\S+)/.exec(line);
  return Boolean(match) && path.resolve(match[2] ?? match[1]) === path.resolve(wrapper);
}

function uninstallLinux({ name, outDir, env }) {
  const removed = [];
  const wrapper = path.join(outDir, idOf(name));
  // Only a folder this command made: the script of that name and the path file.
  if (!fs.existsSync(wrapper) || !fs.existsSync(path.join(outDir, 'launch-path.txt'))) return { removed, kept: outDir };
  const entry = desktopEntryPath(name, { env });
  if (fs.existsSync(entry) && entryPointsAt(entry, wrapper)) {
    fs.rmSync(entry);
    removed.push(entry);
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  removed.push(outDir);
  return { removed, kept: null };
}

// ---------------------------------------------------------------- the two commands

/**
 * Makes the launcher in `dir` and points it at the plugin this was run from.
 *
 * @param {{ name?: string, description?: string, dir?: string, zcode?: string | null, mode?: 'link' | 'copy', shortcut?: boolean, env?: NodeJS.ProcessEnv, platform?: string }} [options]
 * @returns {Promise<{ exe: string, file: string, dir: string, script: string, mode: string, zcode: string | null, hasIcon: boolean, shortcut: string | null, platform: string, pin: string }>}
 */
export async function setup({ name = DEFAULT_NAME, description = DEFAULT_DESCRIPTION, dir = null, zcode = null, mode = 'link', shortcut = true, env = process.env, platform = process.platform } = {}) {
  const file = fileNameOf(name);
  if (!file) throw new SetupError(`名称不能用作文件名：${name}`);
  const outDir = dir ?? defaultDir(name, { env, platform });
  const icon = await findIcon({ zcode, env, platform });
  const common = { name, description, outDir, icon, mode, shortcut, env };
  const made = platform === 'win32'
    ? setupWindows({ ...common, file })
    : platform === 'darwin'
      ? setupMac({ ...common, file })
      : platform === 'linux'
        ? setupLinux(common)
        : null;
  if (!made) throw new SetupError(`这个系统（${platform}）上做不了启动器：只有 Windows、macOS 和 Linux 有配套的做法。`);
  const pin = made.pin ?? '固定到任务栏：在开始菜单里找到它，右键 →「固定到任务栏」。';
  return { ...made, name, dir: outDir, mode, zcode: icon.exe, platform, pin };
}

/**
 * Takes the launcher away again: its shortcut or entry, then its folder or bundle, and only
 * when that is the one this command made.
 */
export function uninstall({ name = DEFAULT_NAME, dir = null, env = process.env, platform = process.platform } = {}) {
  const file = fileNameOf(name);
  const outDir = dir ?? defaultDir(name, { env, platform });
  if (platform === 'win32') return uninstallWindows({ file, outDir });
  if (platform === 'darwin') return uninstallMac({ file, outDir });
  if (platform === 'linux') return uninstallLinux({ name, outDir, env });
  throw new SetupError(`这个系统（${platform}）上没有启动器可删。`);
}

function report(result, { env = process.env, platform = process.platform } = {}) {
  const where = {
    win32: `启动器程序：${result.exe}`,
    darwin: `启动器：${result.exe}`,
    linux: `启动脚本：${result.exe}`,
  }[result.platform];
  const lines = [
    where,
    `启动脚本：${result.script}${result.mode === 'copy' ? '（已复制进启动器的目录）' : '（用的是这个插件目录里的代码）'}`,
    `图标：${result.hasIcon ? '取自已安装的 ZCode' : '没有取到 ZCode 的图标，用的是系统默认图标'}${result.zcode ? `（${result.zcode}）` : '（没有找到 ZCode）'}`,
  ];
  if (result.platform === 'linux') lines.push(result.shortcut ? `应用列表里的条目：${result.shortcut}` : '没有加应用列表的条目（--no-shortcut）');
  if (result.platform === 'win32') lines.push(result.shortcut ? `开始菜单快捷方式：${result.shortcut}` : '没有建快捷方式（--no-shortcut）');
  lines.push(result.pin);
  if (result.platform === 'win32') lines.push('ZCode 自己的窗口仍会归在官方 ZCode 的任务栏图标下；这个启动器是单独的一项。');
  if (result.platform === 'darwin') lines.push('ZCode 自己的窗口仍会归在官方 ZCode 的程序坞图标下；这个启动器启动完就退出，不在程序坞占位置。');
  const undo = ['node bin/setup-launcher.mjs --uninstall'];
  if (result.name !== DEFAULT_NAME) undo.push(`--name "${result.name}"`);
  if (result.dir !== defaultDir(result.name, { env, platform })) undo.push(`--dir "${result.dir}"`);
  lines.push(`撤销：${undo.join(' ')}`);
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const platform = process.platform;
  try {
    const args = parseArgs(process.argv.slice(2), { platform });
    if (args.help) {
      process.stdout.write(helpText({ platform }));
    } else if (args.uninstall) {
      const result = uninstall({ ...args, platform });
      process.stdout.write(result.kept ? `没有找到这个启动器（${result.kept} 里没有它做出来的东西），什么都没删。\n` : `已删除：\n${result.removed.join('\n')}\n`);
    } else {
      process.stdout.write(`${report(await setup({ ...args, platform }), { platform })}\n`);
    }
  } catch (err) {
    process.stderr.write(`setup-launcher: ${err instanceof SetupError || err?.name === 'LauncherError' ? err.message : (err?.stack ?? String(err))}\n`);
    process.exitCode = 1;
  }
}

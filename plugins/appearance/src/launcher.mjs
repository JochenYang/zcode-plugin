// The launcher: starts ZCode with its debugging channel open and keeps every window showing the
// appearance from the config file.
//
// Why a launcher and not a plugin: ZCode's plugin interface has no way to reach the app's own
// chrome, and the app opens the channel only at process start, and only one instance of the app
// runs at a time (the second hands over to the first and quits). So the picture appears only
// when ZCode is started from here after it was quit completely.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { closeAll, syncTarget } from './apply.mjs';
import { buildPlan, imageDataUrl } from './css.mjs';
import { findFreePort, listTargets, waitForEndpoint } from './cdp.mjs';
import { defaultConfig, loadConfig, mediaAt, saveConfig } from './config.mjs';
import { openWithDefaultApp } from './open.mjs';
import { bringAlong, paths } from './paths.mjs';
import { isAlive, readStatus } from './status.mjs';
import { powershellExe, tasklistExe } from './system.mjs';

export class LauncherError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LauncherError';
  }
}

export const HELP = `用法：node bin/launch.mjs [选项]

不带选项   完全退出 ZCode 后运行：带调试通道启动 ZCode，并把 appearance/config.json 里的外观注入每个窗口。
           之后一直运行：改配置文件即时生效，页面重载后自动补注入，ZCode 退出时一起退出。
--edit     用系统默认程序打开配置文件（没有就先建一份）。
--status   显示当前配置、启动器和 ZCode 是否在运行。
--attach   不启动 ZCode，接管一个已经带着调试通道运行的实例（可跟端口号）。
--once     注入一次就退出，不留在后台。
--config <文件>   用另一份配置文件。
--verbose  把日志同时打到屏幕上（始终写入 ~/.zcode/appearance/launcher.log）。
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits `ms`, but returns at once when `shouldStop()` turns true, so quitting is not delayed,
// and at once when `wake()` (a change of the config) settles, so a change is not held back
// until the end of the interval.
async function pause(ms, shouldStop, wake = null) {
  let sleepTimer;
  let stopTimer;
  let woken;
  try {
    await new Promise((resolve) => {
      sleepTimer = setTimeout(resolve, ms);
      const tick = () => {
        if (shouldStop?.()) return resolve();
        stopTimer = setTimeout(tick, 100);
      };
      tick();
      if (wake) {
        woken = wake();
        woken.then(resolve, resolve);
      }
    });
  } finally {
    clearTimeout(sleepTimer);
    clearTimeout(stopTimer);
    // Slept through it: the waiter is taken back so it does not sit until the next change.
    woken?.cancel?.();
  }
}

export function parseArgs(argv) {
  const args = { mode: 'run', attach: false, attachPort: null, once: false, verbose: false, config: null, pollMs: 2000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--edit') args.mode = 'edit';
    else if (arg === '--status') args.mode = 'status';
    else if (arg === '--help' || arg === '-h') args.mode = 'help';
    else if (arg === '--once') args.once = true;
    else if (arg === '--verbose' || arg === '-v') args.verbose = true;
    else if (arg === '--config') {
      const value = argv[i + 1];
      if (!value) throw new LauncherError('--config 后面要跟一个文件路径');
      args.config = path.resolve(value);
      i += 1;
    } else if (arg === '--attach') {
      args.attach = true;
    } else if (arg.startsWith('--attach=')) {
      const port = Number(arg.slice('--attach='.length));
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new LauncherError('--attach 的端口必须是 1 到 65535 的整数');
      args.attach = true;
      args.attachPort = port;
    } else throw new LauncherError(`不认识的选项：${arg}（--help 看用法）`);
  }
  return args;
}

// The log is for the user to read after something looked wrong; it never gets in the way.
export function createLogger({ file, verbose = false, stderr = process.stderr } = {}) {
  const write = (level, message) => {
    const line = `[${new Date().toISOString()}] ${level} ${message}\n`;
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) fs.truncateSync(file, 0);
      fs.appendFileSync(file, line);
    } catch {
      // A log that cannot be written is not a reason to stop showing the background.
    }
    if (verbose) stderr.write(line);
  };
  return { info: (message) => write('info', message), warn: (message) => write('warn', message) };
}

// Every installed copy that might be ZCode, most likely first. This is the last resort: a
// person who installed somewhere else is found through a running copy or through what the
// installer told the system (see registeredZcode), not here.
export function zcodeCandidates({ env = process.env, platform = process.platform } = {}) {
  if (platform === 'win32') {
    const roots = [];
    for (let code = 65; code <= 90; code += 1) {
      const drive = `${String.fromCharCode(code)}:\\`;
      if (fs.existsSync(drive)) roots.push(drive.slice(0, -1));
    }
    return [
      ...roots.flatMap((root) => [path.join(root, 'Program Files', 'ZCode', 'ZCode.exe'), path.join(root, 'Program Files (x86)', 'ZCode', 'ZCode.exe')]),
      ...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, 'Programs', 'ZCode', 'ZCode.exe'), path.join(env.LOCALAPPDATA, 'ZCode', 'ZCode.exe')] : []),
    ];
  }
  if (platform === 'darwin') {
    return ['/Applications/ZCode.app/Contents/MacOS/ZCode', path.join(env.HOME ?? '', 'Applications', 'ZCode.app', 'Contents', 'MacOS', 'ZCode')];
  }
  return ['/opt/ZCode/ZCode', '/opt/ZCode/zcode', '/usr/bin/zcode', ...((env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'zcode')))];
}

// A configured path that does not exist is the user's own setting being wrong: say so rather
// than quietly falling back to a search. Null when nothing was configured.
function explicitZcode({ configured, env }) {
  if (env.ZCODE_APPEARANCE_EXE) {
    if (!fs.existsSync(env.ZCODE_APPEARANCE_EXE)) throw new LauncherError(`ZCODE_APPEARANCE_EXE 指向的文件不存在：${env.ZCODE_APPEARANCE_EXE}`);
    return env.ZCODE_APPEARANCE_EXE;
  }
  if (configured) {
    if (!fs.existsSync(configured)) throw new LauncherError(`配置里 launcher.zcodePath 指向的文件不存在：${configured}`);
    return configured;
  }
  return null;
}

// What was configured, or the first usual place that has a ZCode. Asks nothing outside this
// process; `resolveZcode` does.
export function findZcode({ configured = null, env = process.env, platform = process.platform } = {}) {
  return explicitZcode({ configured, env }) ?? zcodeCandidates({ env, platform }).find((candidate) => fs.existsSync(candidate)) ?? null;
}

function execFileText(file, args, { env }) {
  return new Promise((resolve) => {
    execFile(file, args, { env, windowsHide: true, timeout: 15000, encoding: 'utf8' }, (error, stdout) => resolve(error && !stdout ? '' : String(stdout ?? '')));
  });
}

// How many ZCode processes are running, and where the first one lives. Used where the count or
// the place is wanted: `--status`, finding the executable, the message when one is running.
export async function runningZcode({ env = process.env, platform = process.platform, run = execFileText } = {}) {
  if (platform === 'win32') {
    const script = "$p = @(Get-Process -Name ZCode -ErrorAction SilentlyContinue); $p.Count; ($p | Where-Object { $_.Path } | Select-Object -First 1 -ExpandProperty Path)";
    const lines = (await run(powershellExe(env), ['-NoProfile', '-NonInteractive', '-Command', script], { env })).split(/\r?\n/);
    return { count: Number(lines[0]) || 0, path: lines[1] || null };
  }
  const ids = (await run('pgrep', ['-x', 'ZCode'], { env })).split(/\r?\n/).filter(Boolean);
  let first = null;
  if (ids.length) {
    first = await new Promise((resolve) => fs.readlink(`/proc/${ids[0]}/exe`, (error, target) => resolve(error ? null : target)));
    if (!first && platform === 'darwin') first = '/Applications/ZCode.app/Contents/MacOS/ZCode';
  }
  return { count: ids.length, path: first };
}

// Where the installer said it put ZCode. On Windows the installer writes an uninstall entry that
// names the folder it chose, so a copy in `D:\Apps\ZCode` is found as well as one in Program
// Files; the three roots are the per-machine, per-user and 32-bit views of that list. The entry
// is recognised by its name (`ZCode 4.0.0`, `ZCode`) or its publisher, and only an executable
// that is really in the folder it names is returned. macOS and Linux keep no such record:
// /Applications and the package manager's paths are in zcodeCandidates.
const REGISTERED_WIN32 = [
  "$roots = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
  "$entries = Get-ItemProperty $roots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '^ZCode( |$)' -or ($_.Publisher -eq 'ZCode' -and $_.DisplayName -like 'ZCode*') }",
  // DisplayIcon is the uninstaller's icon, which sits in the same folder as ZCode.exe.
  '$found = $entries | ForEach-Object { $dir = if ($_.InstallLocation) { $_.InstallLocation } elseif ($_.DisplayIcon) { Split-Path $_.DisplayIcon } else { $null }; if ($dir) { $exe = Join-Path $dir "ZCode.exe"; if (Test-Path -LiteralPath $exe) { $exe } } } | Select-Object -First 1',
  'if ($found) { [Console]::Out.Write($found) }',
].join('; ');
export async function registeredZcode({ platform = process.platform, env = process.env, run = execFileText } = {}) {
  if (platform !== 'win32') return null;
  const found = (await run(powershellExe(env), ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${REGISTERED_WIN32}`], { env })).trim();
  return found || null;
}

// Whether ZCode is running, asked the quick way: before a start, where every moment counts.
// `tasklist` is a program of its own and answers in well under half a second, where PowerShell
// takes the better part of one to start. Its "no tasks" line is in the system's language; the
// line that names the process is not.
export async function isZcodeRunning({ env = process.env, platform = process.platform, run = execFileText } = {}) {
  if (platform !== 'win32') return (await run('pgrep', ['-x', 'ZCode'], { env })).trim() !== '';
  const out = await run(tasklistExe(env), ['/FI', 'IMAGENAME eq ZCode.exe', '/FO', 'CSV', '/NH'], { env });
  // The image name as the process was started: a copy named `zcode.exe` is listed in lower case.
  return /^"zcode\.exe"/im.test(out);
}

// Where ZCode is and how that was found, asked in the order most likely to be right and quickest
// to ask: what was configured, a running copy, the usual folders, and only then what the
// installer told the system (a PowerShell call of the better part of a second, saved on every
// start of a ZCode that sits where most sit). Nothing found is a null executable; a configured
// path that does not exist is an error. `running` is the answer of a runningZcode() the caller
// already has, to not ask twice. The source is for the log: the installer's record lives in a
// part of the registry the user can write, so which answer was taken should be on record.
const SOURCES = Object.freeze({ env: '环境变量 ZCODE_APPEARANCE_EXE', config: '配置里的 launcher.zcodePath', running: '正在运行的 ZCode 进程', registered: '系统的安装记录', usual: '常见目录' });
export async function locateZcode({ configured = null, env = process.env, platform = process.platform, run = execFileText, exists = fs.existsSync, running = null } = {}) {
  const explicit = explicitZcode({ configured, env });
  if (explicit) return { exe: explicit, source: env.ZCODE_APPEARANCE_EXE ? SOURCES.env : SOURCES.config };
  const live = running ?? (await runningZcode({ env, platform, run }));
  if (live.path && exists(live.path)) return { exe: live.path, source: SOURCES.running };
  const usual = zcodeCandidates({ env, platform }).find((candidate) => exists(candidate));
  if (usual) return { exe: usual, source: SOURCES.usual };
  const registered = await registeredZcode({ platform, env, run });
  if (registered && exists(registered)) return { exe: registered, source: SOURCES.registered };
  return { exe: null, source: null };
}

export async function resolveZcode(options = {}) {
  return (await locateZcode(options)).exe;
}

function writeStatus(file, status) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...status, startedAt: new Date().toISOString() }, null, 2));
}

// How the current stylesheet is kept. Nothing is read on a timer: the folder of the config file
// is watched, and a change there rereads the file and wakes the loop at once, which is what
// makes a slider in the panel feel live. The file is written as a temporary file and renamed,
// so the folder is what has to be watched, not the file. The folder of the stylesheet generator
// is watched the same way. Every half a minute both files are compared anyway, for a watch that
// missed an event. A config that stops validating keeps the previous settings and says why once.
export function createPlanSource({ file, logger, cssModule = new URL('./css.mjs', import.meta.url), watch = watchFolder, now = Date.now }) {
  const warned = new Set();
  const warnOnce = (key, message) => {
    if (warned.has(key)) return;
    warned.add(key);
    logger.warn(message);
  };
  // The settings are read on the first ask, not here: a file that is wrong then keeps the
  // defaults and says why, instead of stopping the launcher. `start` has validated it once
  // before the loop begins, so this is for a file that broke after that.
  let config = defaultConfig();
  let index = 0;
  let configDirty = true;
  let lastMtime = 0;
  let lastChecked = 0;
  let plan = null;
  let builtFor = '';
  let rotateTimer = null;
  let rotateMinutes = 0;
  // Who is waiting for the next change (the loop, to skip the rest of its interval).
  const waiters = new Set();
  const notify = () => {
    for (const waiter of waiters) waiter.resolve();
    waiters.clear();
  };
  const watcher = watch(path.dirname(file), (name) => {
    // A name that is not ours is another file in the same folder; no name means "check".
    if (name && path.basename(file) !== name) return;
    configDirty = true;
    notify();
  }, (err) => warnOnce(`watch:${err.message}`, `监听配置目录失败，改为每 30 秒核对一次：${err.message}`));
  // The stylesheet generator is reloaded when its file changes, so tuning the rules does not
  // mean restarting ZCode (which, with one instance running, is the only way to restart the
  // launcher). It covers css.mjs itself; what css.mjs imports (the skins, the validation) is
  // the copy this process started with. A different module (the tests pass one) is imported
  // the first time a plan is asked for.
  const ownCss = cssModule.href === new URL('./css.mjs', import.meta.url).href;
  const cssPath = fileURLToPath(cssModule);
  let css = ownCss ? { buildPlan, imageDataUrl } : null;
  let cssStamp = ownCss ? mtimeOf(cssModule) : 0;
  let cssDirty = !ownCss;
  const cssWatcher = watch(path.dirname(cssPath), (name) => {
    if (name && path.basename(cssPath) !== name) return;
    cssDirty = true;
    notify();
  }, (err) => warnOnce(`css-watch:${err.message}`, `监听样式模块的目录失败，改为每 30 秒核对一次：${err.message}`));

  function scheduleRotation() {
    const { media, rotateMinutes: minutes, enabled } = config.background;
    const wanted = enabled && minutes > 0 && media.length > 1 ? minutes : 0;
    if (wanted === rotateMinutes) return;
    if (rotateTimer) clearTimeout(rotateTimer);
    rotateMinutes = wanted;
    if (!wanted) return;
    // A timer cannot wait past 2^31-1 ms; beyond that it fires at once, over and over.
    const delay = Math.min(wanted * 60000, 2 ** 31 - 1);
    const tick = () => {
      index += 1;
      notify();
      rotateTimer = setTimeout(tick, delay);
    };
    rotateTimer = setTimeout(tick, delay);
  }

  async function refreshCss() {
    if (!cssDirty && css) return;
    cssDirty = false;
    const mtime = mtimeOf(cssModule);
    if (mtime === cssStamp && css) return;
    // A file caught mid-edit does not parse: keep what works until it does again.
    try {
      css = await import(`${cssModule.href}?v=${mtime}`);
      cssStamp = mtime;
      logger.info('样式模块有更新，下一次生成用新的');
    } catch (err) {
      warnOnce(`css:${mtime}`, `样式模块加载不了，先用上一份：${err.message}`);
    }
  }

  function rebuild() {
    let data = null;
    let video = null;
    const item = config.background.enabled ? mediaAt(config, index) : null;
    if (item && item.kind === 'picture') {
      try {
        data = css.imageDataUrl(item.path);
      } catch (err) {
        warnOnce(`media:${item.path}:${err.message}`, `${err.message}；这一张先不显示`);
      }
    } else if (item) {
      // Played by a <video> element from the file itself: a video is never embedded.
      video = pathToFileURL(item.path).href;
    }
    plan = css.buildPlan(config, { imageDataUrl: data, videoUrl: video });
    builtFor = `${index}|${cssStamp}`;
    return plan;
  }

  return {
    get config() {
      return config;
    },
    async getPlan() {
      const time = now();
      if (time - lastChecked >= RECHECK_MS) {
        // The safety net: both files are compared with what was last read.
        lastChecked = time;
        if (!configDirty && mtimeOf(file) !== lastMtime) configDirty = true;
        if (!cssDirty && mtimeOf(cssModule) !== cssStamp) cssDirty = true;
      }
      await refreshCss();
      if (configDirty) {
        configDirty = false;
        lastMtime = mtimeOf(file);
        try {
          config = loadConfig({ file }).config;
        } catch (err) {
          warnOnce(`config:${err.message}`, `${err.message}；先沿用上一份有效的设置`);
        }
        scheduleRotation();
        rebuild();
      } else if (builtFor !== `${index}|${cssStamp}`) {
        // The rotating item moved on, or the generator was reloaded: same settings, new stylesheet.
        rebuild();
      }
      return plan;
    },
    // Resolves on the next change of the settings or of the generator, or at once when one is
    // already waiting. `cancel()` takes the waiter back when the caller stopped waiting first.
    change() {
      let resolve;
      const promise = new Promise((done) => {
        resolve = done;
      });
      const waiter = { resolve };
      if (configDirty || cssDirty) resolve();
      else waiters.add(waiter);
      promise.cancel = () => waiters.delete(waiter);
      return promise;
    },
    stop() {
      if (rotateTimer) clearTimeout(rotateTimer);
      if (watcher) watcher.close();
      if (cssWatcher) cssWatcher.close();
      notify();
    },
  };
}

const RECHECK_MS = 30_000;

// Watches a folder and reports its events to `onChange`; `onError` gets what went wrong, once,
// and the watcher is closed. Null when the folder cannot be watched.
function watchFolder(folder, onChange, onError) {
  try {
    const watcher = fs.watch(folder, { persistent: false }, (_event, name) => onChange(name));
    let reported = false;
    watcher.on('error', (err) => {
      watcher.close();
      if (!reported) {
        reported = true;
        onError(err);
      }
    });
    return watcher;
  } catch (err) {
    onError(err);
    return null;
  }
}

// The file's modification time as Node reports it, fractions kept: two saves in the same
// millisecond are still two saves.
function mtimeOf(target) {
  try {
    return fs.statSync(target).mtimeMs;
  } catch {
    return 0;
  }
}

// Polls the windows and brings each one up to date. Errors on one window (it closed while we
// were talking to it, mostly) cost that window a reconnect, not the loop; the channel itself
// going away is reported at once and then occasionally, and retried: the app opens it again
// when it restarts. An instance this launcher started ends the loop through `shouldStop`; one
// it attached to may simply be gone, so the loop also gives up after a minute of silence.
export async function supervise({ port, getPlan, shouldStop, logger, pollMs = 2000, once = false, giveUpAfterMs = 60000, wake = null, sessions = new Map(), listTargetsImpl = listTargets, firstPollMs = 100, fastForMs = 10000, onBrought = null }) {
  let failures = 0;
  let failingSince = null;
  const startedAt = Date.now();
  // How many times a window has been brought up to date. Until the first one, the loop comes
  // back quickly, for the first seconds of the run: right after a start the window shows up a
  // moment after the channel does, and waiting a whole interval for it was most of the time the
  // background took to appear. Only for the first seconds: an app with no page to bring (a
  // --attach to a channel that has none) would otherwise be asked ten times a second for good.
  let brought = 0;
  // A window that will not take the stylesheet says so once in a while, not on every poll.
  const lastWarn = new Map();
  for (;;) {
    try {
      const plan = await getPlan();
      const targets = await listTargetsImpl(port);
      failures = 0;
      failingSince = null;
      const seen = new Set();
      let clean = targets.length > 0;
      for (const target of targets) {
        seen.add(target.id);
        try {
          await syncTarget(target, sessions, plan, { log: (message) => logger.info(message) });
          brought += 1;
          if (brought === 1) onBrought?.();
        } catch (err) {
          clean = false;
          const now = Date.now();
          if (now - (lastWarn.get(target.id) ?? -Infinity) >= 5000) {
            lastWarn.set(target.id, now);
            logger.warn(`窗口「${target.title || target.url}」：${err.message}`);
          }
          sessions.get(target.id)?.session.close();
          sessions.delete(target.id);
        }
      }
      for (const id of [...sessions.keys()]) {
        if (seen.has(id)) continue;
        sessions.get(id).session.close();
        sessions.delete(id);
      }
      if (once && clean) return { brought };
    } catch (err) {
      failures += 1;
      // Counted by the clock, not by the polls: a port that accepts the connection and never
      // answers costs a fetch timeout on top of every poll, and twice the polls is not a minute.
      failingSince ??= Date.now();
      if (failures === 1 || failures % 15 === 0) logger.warn(`端口 ${port} 上的调试通道：${err.message}`);
      if (Date.now() - failingSince >= giveUpAfterMs) {
        logger.warn(`端口 ${port} 上的调试通道一直没有应答，启动器退出`);
        return { brought };
      }
    }
    if (shouldStop()) return { brought };
    const quick = brought === 0 && Date.now() - startedAt < fastForMs;
    await pause(quick ? firstPollMs : pollMs, shouldStop, wake);
  }
}

function describe(config, file) {
  const { background, skin } = config;
  const lines = [
    `配置文件：${file}`,
    `背景：${background.enabled ? '开' : '关'}，范围 ${background.scope === 'page' ? '整页' : '会话区'}，遮罩 ${background.mask}，模糊 ${background.blur}px，每 ${background.rotateMinutes} 分钟换一张`,
  ];
  lines.push(background.media.length ? `媒体（${background.media.length} 个）：\n  ${background.media.join('\n  ')}` : '媒体：还没有设置');
  lines.push(`皮肤：${skin.preset === 'custom' ? '自定义' : skin.preset}${skin.preset !== 'custom' && skin.custom ? '（保留着一套自定义颜色，未使用）' : ''}`);
  return lines.join('\n');
}

async function status({ file, stdout }) {
  const { config, exists } = loadConfig({ file });
  const state = readStatus(paths().status);
  const running = await runningZcode();
  stdout.write(`${describe(config, file)}\n`);
  stdout.write(`\n启动器：${state && isAlive(state.launcherPid) ? `运行中（端口 ${state.port}）` : '没有运行'}\n`);
  stdout.write(`ZCode：${running.count ? `运行中（${running.count} 个进程）` : '没有运行'}\n`);
  if (!exists) stdout.write('\n还没有配置文件，上面是默认值。运行 --edit 会建一份。\n');
  return 0;
}

// Shown only when started without a console (the launcher programs): there would be no other
// way to learn why nothing happened. The message travels in an environment variable or as an
// argument, never on a command line that quotes could break.
export function notify(message) {
  const text = String(message).slice(0, 1200);
  const title = 'ZCode appearance';
  const onItsOwn = { detached: true, stdio: 'ignore' };
  if (process.platform === 'win32') {
    const script = "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($env:ZCODE_APPEARANCE_MESSAGE, 'ZCode appearance') | Out-Null";
    spawn(powershellExe(), ['-NoProfile', '-NonInteractive', '-Command', script], { ...onItsOwn, env: { ...process.env, ZCODE_APPEARANCE_MESSAGE: text }, windowsHide: true }).unref();
  } else if (process.platform === 'darwin') {
    // The message is passed as an argument to the script, which AppleScript reads by position.
    spawn('osascript', ['-e', 'on run argv', '-e', 'display alert (item 1 of argv) message (item 2 of argv) as critical', '-e', 'end run', title, text], { ...onItsOwn, env: process.env }).unref();
  } else {
    // Whichever of the usual notifiers this desktop has; with none, the log alone has it.
    const script = 'if command -v zenity >/dev/null 2>&1; then zenity --error --title="$1" --text="$2" 2>/dev/null; elif command -v notify-send >/dev/null 2>&1; then notify-send -u critical "$1" "$2" 2>/dev/null; fi';
    spawn('sh', ['-c', script, 'zcode-appearance', title, text], { ...onItsOwn, env: process.env }).unref();
  }
}

async function start({ args, file, files, logger }) {
  if (typeof globalThis.WebSocket !== 'function') {
    throw new LauncherError(`启动器需要 Node 22 或更新版本（用到内置的 WebSocket），现在是 ${process.version}`);
  }
  const { config } = loadConfig({ file });
  let port = args.attachPort;
  let child = null;
  let exited = false;
  let spawnError = null;
  let startedAt = 0;
  const sessions = new Map();

  if (args.attach) {
    if (port === null) port = readStatus(files.status)?.port ?? config.launcher.port;
    logger.info(`接管端口 ${port} 上已经在运行的调试通道`);
    // The same status file as a launched instance: the tools only ask whether a launcher applies
    // the settings, not how ZCode was started.
    writeStatus(files.status, { launcherPid: process.pid, port, zcodePid: null, config: file });
  } else {
    // The quick question first (a program of its own, where PowerShell takes the better part of
    // a second to start); the exact count is for the message.
    if (await isZcodeRunning()) {
      const running = await runningZcode();
      throw new LauncherError(`ZCode 已经在运行（${running.count} 个进程）。请先完全退出它（托盘图标里也要退出），再从这个启动器启动：调试通道只在启动时打开，而且已有一个实例在运行时，新启动的那个会直接把控制权交出去然后退出。`);
    }
    // Not running, as just established: that source is not asked.
    const { exe, source } = await locateZcode({ configured: config.launcher.zcodePath, running: { count: 0, path: null } });
    if (!exe) {
      throw new LauncherError(`没有找到 ZCode 的可执行文件：配置和环境变量没有指定，ZCode 没有在运行，系统的安装记录和常见目录里也没有。请在 ${file} 里把 launcher.zcodePath 写成 ZCode 可执行文件的完整路径，或者设置环境变量 ZCODE_APPEARANCE_EXE。`);
    }
    // On record which answer was taken: the installer's record is in a part of the registry the
    // user can write.
    logger.info(`找到 ZCode：${exe}（来自${source}）`);
    port = await findFreePort(config.launcher.port);
    startedAt = Date.now();
    child = spawn(exe, [`--remote-debugging-port=${port}`], { stdio: 'ignore' });
    child.once('exit', () => {
      exited = true;
    });
    child.once('error', (err) => {
      spawnError = err;
      exited = true;
    });
    logger.info(`启动 ${exe}，调试通道在端口 ${port}`);
    try {
      await waitForEndpoint(port, { shouldStop: () => exited, intervalMs: 100 });
    } catch (err) {
      if (spawnError) throw new LauncherError(`无法启动 ${exe}：${spawnError.message}`);
      throw err;
    }
    logger.info(`调试通道 ${Date.now() - startedAt} 毫秒后应答`);
    writeStatus(files.status, { launcherPid: process.pid, port, zcodePid: child.pid, config: file });
  }

  const source = createPlanSource({ file, logger });
  let interrupted = false;
  const stop = () => {
    interrupted = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const shouldStop = () => interrupted || exited;
  let brought = 0;
  try {
    ({ brought } = await supervise({ port, getPlan: source.getPlan, shouldStop, logger, once: args.once, pollMs: args.pollMs, wake: () => source.change(), sessions, onBrought: child ? () => logger.info(`首个窗口在启动后 ${Date.now() - startedAt} 毫秒拿到样式`) : null }));
  } finally {
    source.stop();
    // Open sockets keep the process alive: with --once the launcher has to be able to exit.
    closeAll(sessions);
    if (readStatus(files.status)?.launcherPid === process.pid) fs.rmSync(files.status, { force: true });
  }
  // A start that ends without a window ever showing the stylesheet is the single-instance
  // handover: the new process gave control to one that was still running and quit.
  if (child && exited && !brought) {
    throw new LauncherError('ZCode 启动后马上退出了：多半是还有一个实例没有完全退出（托盘图标里也要退出），新启动的这个把控制权交给它之后结束了。');
  }
  return 0;
}

export async function run({ argv = process.argv.slice(2), env = process.env, stdout = process.stdout } = {}) {
  const args = parseArgs(argv);
  bringAlong();
  const files = paths();
  const logger = createLogger({ file: files.log, verbose: args.verbose });
  const file = args.config ?? files.config;
  if (args.mode === 'help') {
    stdout.write(HELP);
    return 0;
  }
  if (args.mode === 'edit') {
    if (!fs.existsSync(file)) {
      saveConfig(defaultConfig(), { file });
      stdout.write(`新建了配置文件：${file}\n`);
    }
    openWithDefaultApp(file, { env });
    return 0;
  }
  if (args.mode === 'status') return status({ file, stdout });
  return start({ args, file, files, logger });
}

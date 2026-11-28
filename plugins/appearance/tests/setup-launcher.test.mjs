// The launcher programs (launcher/: Launcher.cs compiled by bin/setup-launcher.mjs on Windows,
// launcher.sh copied on macOS and Linux): the Windows one is compiled for real with the C#
// compiler Windows ships and then run, against a stand-in for the launcher script. The other two
// layouts are made here with the platform switched, and the shell stand-in is run under whatever
// POSIX sh this machine has.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { DEFAULT_NAME, SetupError, buildLauncher, defaultDir, fileNameOf, findIcon, helpText, idOf, parseArgs, setup, uninstall } from '../bin/setup-launcher.mjs';
import { commandPrompt } from '../src/system.mjs';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUB = path.join(PLUGIN, 'launcher', 'launcher.sh');
const skip = process.platform === 'win32' ? false : 'the launcher program is Windows only';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const dirs = [];
const tempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
const ps = (text) => `'${String(text).replace(/'/g, "''")}'`;
// What Windows knows about a program: what a tooltip and the Properties page show. Windows
// puts the assembly title under "file description" and the assembly description under
// "comments"; that is its mapping, not ours.
const versionInfo = (exe) => {
  const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $v = (Get-Item ${ps(exe)}).VersionInfo; [Console]::Write($v.ProductName + '|' + $v.FileDescription + '|' + $v.Comments)`;
  const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  return out.stdout.trim().split('|');
};
// A Windows without node on it: enough of the environment for a program to start at all.
const bareEnv = (extra = {}) => ({ SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'), ZCODE_APPEARANCE_LAUNCHER_QUIET: '1', ...extra });
const runExe = (exe, env) => spawnSync(exe, [], { env, encoding: 'utf8', windowsHide: true, timeout: 20_000 });
// The launcher script as far as the programs know: it writes down how it was started, next to
// itself (the working folder is the user's own, where nothing of a test's belongs).
const STAND_IN = "import fs from 'node:fs';\nimport path from 'node:path';\nimport { fileURLToPath } from 'node:url';\nconst here = path.dirname(fileURLToPath(import.meta.url));\nfs.writeFileSync(path.join(here, 'started.json'), JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd(), noConsole: process.env.ZCODE_APPEARANCE_NO_CONSOLE }));\n";
const real = (dir) => fs.realpathSync.native(dir).toLowerCase();
// Waits for the marker the stand-in writes and reads it.
async function started(marker) {
  for (let i = 0; i < 200; i += 1) {
    await sleep(50);
    if (fs.existsSync(marker)) {
      try {
        return JSON.parse(fs.readFileSync(marker, 'utf8'));
      } catch {
        // Caught while it was being written; read it again.
      }
    }
  }
  return null;
}

after(() => {
  for (const item of dirs) fs.rmSync(item, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 });
});

describe('the launcher program', { skip }, () => {
  let dir;
  let built;
  const NAME = 'ZCode Appearance Test';
  const DESCRIPTION = 'Starts a stand-in';

  before(async () => {
    dir = tempDir('appearance-exe-');
    // The program is built against a script that need only exist here; each case below copies
    // the program to a folder of its own with the path file it wants.
    const script = path.join(dir, 'launch.mjs');
    fs.writeFileSync(script, '');
    const { png } = await findIcon();
    built = buildLauncher({ outDir: dir, name: NAME, description: DESCRIPTION, script, png });
  });

  it('is a program with the name and the description asked for', () => {
    assert.ok(fs.existsSync(built.exe), built.exe);
    assert.ok(fs.statSync(built.exe).size > 2000, 'small, but it is a program');
    assert.equal(path.basename(built.exe), `${fileNameOf(NAME)}.exe`);
    const [product, fileDescription, comments] = versionInfo(built.exe);
    assert.equal(product, NAME, 'the product is the name');
    assert.equal(fileDescription, NAME, 'and so is what a tooltip shows');
    assert.equal(comments, DESCRIPTION, 'the description is in the comments');
  });

  it('carries the icon of the installed ZCode, in four sizes', async () => {
    // Without a ZCode on the machine there is no icon to take; the program still gets made.
    if (!built.icon) {
      assert.equal((await findIcon()).png, null);
      return;
    }
    const ico = fs.readFileSync(built.icon);
    assert.deepEqual([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)], [0, 1, 4], 'an icon file with four images');
    assert.equal(ico[6], 0, 'the first is 256 wide (0 means 256)');
    // The first image starts where its entry says; a PNG starts with these four bytes.
    assert.equal(ico.readUInt32BE(ico.readUInt32LE(6 + 12)), 0x89_50_4e_47, 'and stored as a PNG');
    assert.deepEqual([ico.readUInt16LE(22 + 6), ico.readUInt16LE(38 + 6), ico.readUInt16LE(54 + 6)], [32, 32, 32], 'the small ones are 32-bit bitmaps');
    assert.deepEqual([ico[22], ico[38], ico[54]], [48, 32, 16], 'in the sizes a taskbar, a menu and a title bar ask for');
    // And Windows reads it back out of the program.
    const script = `Add-Type -AssemblyName System.Drawing; $i = [System.Drawing.Icon]::ExtractAssociatedIcon(${ps(built.exe)}); [Console]::Write($i.Width)`;
    const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
    assert.equal(out.stdout.trim(), '32', out.stderr);
  });

  it('starts node on the launcher script, from the user\'s folder, and tells it there is no console', async () => {
    const home = tempDir('appearance-exe-home-');
    const work = tempDir('appearance-exe-work-');
    const script = path.join(work, 'launch.mjs');
    fs.writeFileSync(script, STAND_IN);
    fs.copyFileSync(built.exe, path.join(home, path.basename(built.exe)));
    fs.writeFileSync(path.join(home, 'launch-path.txt'), `\n${script}\n`);
    const out = runExe(path.join(home, path.basename(built.exe)), cleanEnv({ ZCODE_APPEARANCE_LAUNCHER_QUIET: '1' }));
    assert.equal(out.status, 0, out.stderr);
    const state = await started(path.join(work, 'started.json'));
    assert.ok(state, 'the script ran');
    assert.deepEqual(state.argv, [script]);
    // From the user's own folder, not the script's: ZCode inherits it, and what the app then
    // writes "next to itself" must not land in the plugin's. (Windows may spell a folder with
    // its short name; compare what they really are.)
    assert.equal(real(state.cwd), real(os.homedir()), 'from the user\'s folder');
    assert.equal(state.noConsole, '1');
    assert.equal(fs.existsSync(path.join(home, 'launcher-error.log')), false, 'nothing to report');
  });

  it('says so, in its log, when there is no node to start', () => {
    const home = tempDir('appearance-exe-nonode-');
    const exe = path.join(home, path.basename(built.exe));
    fs.copyFileSync(built.exe, exe);
    fs.writeFileSync(path.join(home, 'launch-path.txt'), `${path.join(home, 'launch.mjs')}\n`);
    fs.writeFileSync(path.join(home, 'launch.mjs'), '');
    const out = runExe(exe, bareEnv());
    assert.equal(out.status, 1);
    const log = fs.readFileSync(path.join(home, 'launcher-error.log'), 'utf8');
    assert.match(log, /Node\.js 22/);
  });

  it('says so when it does not know where the launcher script is, or the script is gone', () => {
    const home = tempDir('appearance-exe-nopath-');
    const exe = path.join(home, path.basename(built.exe));
    fs.copyFileSync(built.exe, exe);
    const out = runExe(exe, bareEnv());
    assert.equal(out.status, 1);
    assert.match(fs.readFileSync(path.join(home, 'launcher-error.log'), 'utf8'), /launch-path\.txt/);
    fs.writeFileSync(path.join(home, 'launch-path.txt'), `${path.join(home, 'gone.mjs')}\n`);
    fs.rmSync(path.join(home, 'launcher-error.log'));
    const again = runExe(exe, bareEnv());
    assert.equal(again.status, 1);
    assert.match(fs.readFileSync(path.join(home, 'launcher-error.log'), 'utf8'), /gone\.mjs/);
  });

  it('never asks for the two placeholders to be left alone', () => {
    const source = fs.readFileSync(path.join(dir, 'Launcher.cs'), 'utf8');
    assert.ok(!source.includes('__TITLE__') && !source.includes('__DESCRIPTION__'));
  });

  it('the .cmd wrapper starts the launcher script from a folder whose name has what cmd trips over', async () => {
    // A stand-in for the launcher where the wrapper looks for it: bin/launch.mjs next to itself.
    const home = path.join(tempDir('appearance-cmd-'), "it's & fine (x)");
    const script = path.join(home, 'bin', 'launch.mjs');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, STAND_IN);
    fs.copyFileSync(path.join(PLUGIN, 'zcode-appearance.cmd'), path.join(home, 'zcode-appearance.cmd'));
    // Started by its bare name from its own folder, as Explorer does on a double-click: the
    // awkward path is then only in %~dp0, which is what the wrapper has to get right.
    const out = spawnSync(commandPrompt(), ['/d', '/c', 'zcode-appearance.cmd'], { cwd: home, encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    assert.equal(out.status, 0, out.stderr);
    // The wrapper does not change the folder: the script runs from where the wrapper was started.
    const state = await started(path.join(home, 'bin', 'started.json'));
    assert.ok(state, 'the script ran');
    assert.deepEqual(state.argv.map((item) => real(item)), [real(script)], 'the whole path, as one argument');
    assert.equal(real(state.cwd), real(os.homedir()), 'from the user\'s folder');
    assert.equal(state.noConsole, '1');
  });
});

// ---------------------------------------------------------------- macOS and Linux

// Where the POSIX sh is, for running the stand-in as the bundle or the desktop would (by path,
// so that an environment without a PATH still finds it). None here: the cases are skipped.
const shPath = (() => {
  if (process.platform !== 'win32') return 'sh';
  const out = spawnSync('where', ['sh'], { encoding: 'utf8', windowsHide: true });
  return out.status === 0 ? out.stdout.trim().split(/\r?\n/)[0] : null;
})();
const skipSh = shPath && spawnSync(shPath, ['-c', 'true'], { encoding: 'utf8' }).status === 0 ? false : 'no POSIX sh on this machine';
// The same path the way that sh spells it (C:\x\y is /c/x/y to it), which is also how it would
// be written on the systems this stand-in is for.
const posix = (file) => file.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
// An environment with the usual tools of that sh but no node in it. Under Git Bash the tools
// are not on a Windows PATH by themselves; they are next to where sh is. On the systems the
// stand-in is for, /bin and /usr/bin are on the PATH of every session, with or without a login
// shell.
const shToolsEnv = (extra = {}) => bareEnv({ PATH: [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'), process.platform === 'win32' && shPath ? path.dirname(shPath) : '/bin:/usr/bin'].join(path.delimiter), TEMP: os.tmpdir(), TMP: os.tmpdir(), ...extra });
// The environment of the test run, without the launcher's own two variables: this session may
// itself have been started by the launcher, and the stand-in has to be the one to set them.
const cleanEnv = (extra = {}) => {
  const { ZCODE_APPEARANCE_NO_CONSOLE, ZCODE_APPEARANCE_NODE, ...rest } = process.env;
  return { ...rest, ...extra };
};

describe('the shell stand-in (macOS and Linux)', { skip: skipSh }, () => {
  const runStub = (program, env) => spawnSync(shPath, [posix(program)], { env, encoding: 'utf8', timeout: 20_000, cwd: os.tmpdir() });

  it('starts node on the script the bundle names, from the user\'s folder, and tells it there is no console', async () => {
    const work = tempDir('appearance-stub-work-');
    const program = path.join(tempDir('appearance-stub-home-'), 'My ZCode.app', 'Contents', 'MacOS', 'My ZCode');
    const resources = path.join(program, '..', '..', 'Resources');
    fs.mkdirSync(path.dirname(program), { recursive: true });
    fs.mkdirSync(resources, { recursive: true });
    fs.copyFileSync(STUB, program);
    const script = path.join(work, 'launch.mjs');
    fs.writeFileSync(script, STAND_IN);
    fs.writeFileSync(path.join(resources, 'launch-path.txt'), `\n${posix(script)}\n`);
    const out = runStub(program, cleanEnv());
    assert.equal(out.status, 0, out.stderr);
    const state = await started(path.join(work, 'started.json'));
    assert.ok(state, 'the script ran');
    // What node was given is the same file, spelled the way Windows spells it.
    assert.deepEqual(state.argv.map(real), [real(script)]);
    assert.equal(real(state.cwd), real(os.homedir()), 'from the user\'s folder');
    assert.equal(state.noConsole, '1');
    assert.equal(fs.existsSync(path.join(path.dirname(program), 'launcher-error.log')), false, 'nothing to report');
  });

  it('does the same from a folder where the path file is next to it, which is the Linux layout', async () => {
    const home = tempDir('appearance-stub-flat-');
    const work = tempDir('appearance-stub-work-');
    const program = path.join(home, 'my-zcode');
    const script = path.join(home, 'app', 'bin', 'launch.mjs');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.copyFileSync(STUB, program);
    fs.writeFileSync(script, STAND_IN);
    fs.writeFileSync(path.join(home, 'launch-path.txt'), `${posix(script)}\n`);
    const out = runStub(program, cleanEnv());
    assert.equal(out.status, 0, out.stderr);
    const state = await started(path.join(path.dirname(script), 'started.json'));
    assert.deepEqual(state?.argv.map(real), [real(script)]);
    assert.equal(real(state.cwd), real(os.homedir()), 'from the user\'s folder');
  });

  it('says so when it does not know where the script is, or the script is gone', () => {
    const home = tempDir('appearance-stub-nopath-');
    const program = path.join(home, 'my-zcode');
    fs.copyFileSync(STUB, program);
    const log = path.join(home, 'launcher-error.log');
    assert.equal(runStub(program, shToolsEnv({ HOME: home })).status, 1);
    assert.match(fs.readFileSync(log, 'utf8'), /launch-path\.txt/);
    fs.writeFileSync(path.join(home, 'launch-path.txt'), `${posix(path.join(home, 'gone.mjs'))}\n`);
    fs.rmSync(log);
    assert.equal(runStub(program, shToolsEnv({ HOME: home })).status, 1);
    assert.match(fs.readFileSync(log, 'utf8'), /gone\.mjs/);
  });

  it('says so when there is no node to start, and takes one that is named', async () => {
    const home = tempDir('appearance-stub-nonode-');
    const work = tempDir('appearance-stub-work-');
    const program = path.join(home, 'my-zcode');
    const script = path.join(work, 'launch.mjs');
    fs.copyFileSync(STUB, program);
    fs.writeFileSync(script, STAND_IN);
    fs.writeFileSync(path.join(home, 'launch-path.txt'), `${posix(script)}\n`);
    const log = path.join(home, 'launcher-error.log');
    // No node on the PATH and an empty home folder, so that nothing is found by hand either.
    const withoutNode = shToolsEnv({ HOME: home });
    assert.equal(runStub(program, withoutNode).status, 1);
    assert.match(fs.readFileSync(log, 'utf8'), /Node\.js 22/);
    // The variable names one, for a desktop whose PATH has none.
    assert.equal(runStub(program, { ...withoutNode, ZCODE_APPEARANCE_NODE: process.execPath }).status, 0);
    assert.ok(await started(path.join(work, 'started.json')), 'the script ran');
  });
});

describe('the macOS and Linux layouts, made here with the platform switched', () => {
  // A stand-in for an installed ZCode: the executable and, where each system keeps them, its
  // pictures.
  const installed = () => {
    const root = tempDir('appearance-installed-');
    const mac = path.join(root, 'ZCode.app', 'Contents', 'MacOS', 'ZCode');
    const make = (file, text = '') => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    };
    make(mac);
    make(path.join(root, 'ZCode.app', 'Contents', 'Resources', 'icon.icns'), 'the icon file');
    const linux = path.join(root, 'opt', 'ZCode');
    make(linux);
    make(path.join(root, 'opt', 'resources', 'icon.png'), 'the picture');
    return { mac, linux };
  };

  it('finds the picture of the icon next to the executable, in the shape each system has', async () => {
    const { mac, linux } = installed();
    const onMac = await findIcon({ platform: 'darwin', zcode: mac });
    // Through the short names a temp folder may be spelled with: what the files really are.
    assert.equal(real(onMac.icns), real(path.join(mac, '..', '..', 'Resources', 'icon.icns')));
    assert.equal(onMac.png, null);
    const onLinux = await findIcon({ platform: 'linux', zcode: linux });
    assert.equal(real(onLinux.png), real(path.join(linux, '..', 'resources', 'icon.png')));
    assert.equal(onLinux.icns, null);
    // A path that is not there is the person's own mistake, said before anything is searched.
    await assert.rejects(findIcon({ platform: 'linux', zcode: path.join('nowhere', 'ZCode') }), /不存在/);
  });

  it('makes a bundle: the stand-in as its program, the record, the icon and the path file', async () => {
    const { mac } = installed();
    const target = tempDir('appearance-mac-');
    const made = await setup({ platform: 'darwin', name: 'My ZCode & Co', dir: target, zcode: mac, shortcut: true, env: {} });
    const bundle = path.join(target, 'My ZCode & Co.app');
    assert.equal(made.bundle, bundle);
    assert.equal(made.exe, path.join(bundle, 'Contents', 'MacOS', 'My ZCode & Co'));
    assert.ok(fs.existsSync(made.exe), 'the program is there');
    assert.equal(fs.readFileSync(made.exe, 'utf8'), fs.readFileSync(STUB, 'utf8'), 'and it is the stand-in, unchanged');
    assert.equal(fs.readFileSync(path.join(bundle, 'Contents', 'Resources', 'AppIcon.icns'), 'utf8'), 'the icon file');
    assert.equal(fs.readFileSync(path.join(bundle, 'Contents', 'Resources', 'launch-path.txt'), 'utf8').trim(), path.join(PLUGIN, 'bin', 'launch.mjs'));
    const plist = fs.readFileSync(path.join(bundle, 'Contents', 'Info.plist'), 'utf8');
    assert.match(plist, /<key>CFBundleName<\/key>\s*<string>My ZCode &amp; Co<\/string>/, 'the name, escaped for XML');
    assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>My ZCode &amp; Co<\/string>/);
    assert.match(plist, /<key>CFBundleIdentifier<\/key>\s*<string>app\.zcode-appearance\.my-zcode-co<\/string>/);
    assert.equal(made.pin, `加到程序坞：在访达里打开 ${target}，把 My ZCode & Co.app 拖到程序坞。`);
    assert.equal(made.hasIcon, true);
    // Running it again replaces it; taking it away leaves the folder it was in.
    assert.equal((await setup({ platform: 'darwin', name: 'My ZCode & Co', dir: target, zcode: mac, env: {} })).bundle, bundle);
    assert.deepEqual(uninstall({ platform: 'darwin', name: 'My ZCode & Co', dir: target }).removed, [bundle]);
    assert.equal(fs.existsSync(target), true, 'the folder it was in stays');
    assert.equal(fs.existsSync(bundle), false);
  });

  it('leaves a bundle alone that it did not make', async () => {
    const target = tempDir('appearance-mac-foreign-');
    const bundle = path.join(target, 'Other.app', 'Contents', 'MacOS');
    fs.mkdirSync(bundle, { recursive: true });
    fs.writeFileSync(path.join(bundle, 'Other'), 'not ours');
    await assert.rejects(setup({ platform: 'darwin', name: 'Other', dir: target, zcode: null, env: { PATH: '' } }), /不是这个命令做出来的/);
    assert.equal(fs.readFileSync(path.join(bundle, 'Other'), 'utf8'), 'not ours');
    assert.equal(uninstall({ platform: 'darwin', name: 'Other', dir: target }).kept, path.join(target, 'Other.app'));
    assert.equal(fs.existsSync(path.join(bundle, 'Other')), true);
  });

  it('makes a script with the path file next to it and an entry in the applications list; the entry goes with it', async () => {
    const { linux } = installed();
    // A folder whose name has the characters the entry format reserves: they get a backslash on
    // the way out, and are read back as themselves.
    const target = path.join(tempDir('appearance-linux-'), 'it`s$home');
    const data = tempDir('appearance-xdg-');
    const env = { XDG_DATA_HOME: data };
    const made = await setup({ platform: 'linux', name: 'My "ZCode"', dir: target, zcode: linux, shortcut: true, env });
    assert.equal(made.exe, path.join(target, 'my-zcode'));
    assert.equal(fs.readFileSync(made.exe, 'utf8'), fs.readFileSync(STUB, 'utf8'));
    assert.equal(fs.readFileSync(path.join(target, 'launch-path.txt'), 'utf8').trim(), path.join(PLUGIN, 'bin', 'launch.mjs'));
    assert.equal(fs.readFileSync(path.join(target, 'icon.png'), 'utf8'), 'the picture');
    const entry = path.join(data, 'applications', 'my-zcode.desktop');
    assert.equal(real(made.shortcut), real(entry));
    const text = fs.readFileSync(entry, 'utf8');
    // Spelled out, not worked out with the implementation's own expression: the backtick and the
    // dollar sign get a backslash in front, the separator a second one.
    assert.ok(text.split(/\r?\n/).some((line) => line.startsWith('Exec="') && line.endsWith('it\\`s\\$home\\\\my-zcode"')), text);
    assert.match(text, /^Name=My "ZCode"$/m);
    // The icon's path is escaped too (a separator becomes two backslashes); the reserved
    // characters need no escape outside the Exec line.
    assert.ok(text.split(/\r?\n/).some((line) => line.startsWith('Icon=') && line.endsWith('it`s$home\\\\icon.png')), text);
    assert.match(text, /^Terminal=false$/m);
    // Ours: the entry goes, then what the command wrote, then the folder. (Compared as resolved
    // paths: the first two are gone by now, so what they really are can no longer be asked.)
    const gone = uninstall({ platform: 'linux', name: 'My "ZCode"', dir: target, env });
    assert.deepEqual(gone.removed.slice(0, 2).map((item) => path.resolve(item)), [path.resolve(entry), path.resolve(path.join(target, 'my-zcode'))]);
    assert.equal(gone.removed.at(-1), target);
    assert.equal(gone.left, null);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(entry), false);
    // An entry that starts something else stays.
    await setup({ platform: 'linux', name: 'My "ZCode"', dir: target, zcode: linux, shortcut: true, env });
    fs.writeFileSync(entry, 'Type=Application\nExec="/somewhere/else/my-zcode"\n');
    assert.ok(uninstall({ platform: 'linux', name: 'My "ZCode"', dir: target, env }).removed.every((item) => path.resolve(item) !== path.resolve(entry)), 'the entry stays');
    assert.equal(fs.existsSync(entry), true);
  });

  it('on Linux too, refuses a folder that holds someone else\'s files, and takes away only its own', async () => {
    const { linux } = installed();
    const busy = tempDir('appearance-linux-busy-');
    fs.writeFileSync(path.join(busy, 'tool.sh'), 'keep');
    await assert.rejects(setup({ platform: 'linux', name: 'My ZCode', dir: busy, zcode: linux, shortcut: false, env: {} }), /不往别人的目录里写/);
    assert.deepEqual(fs.readdirSync(busy), ['tool.sh'], 'nothing was written');
    const own = tempDir('appearance-linux-own-');
    await setup({ platform: 'linux', name: 'My ZCode', dir: own, zcode: linux, shortcut: false, env: {} });
    fs.writeFileSync(path.join(own, 'notes.txt'), 'keep');
    const gone = uninstall({ platform: 'linux', name: 'My ZCode', dir: own, env: {} });
    assert.equal(gone.left, own);
    assert.deepEqual(fs.readdirSync(own), ['notes.txt']);
  });

  it('puts the default places where each system keeps such things', () => {
    assert.equal(defaultDir('ZCode Appearance', { platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, home: 'C:\\Users\\a' }), 'C:\\Users\\a\\AppData\\Local\\ZCode Appearance');
    assert.equal(defaultDir('ZCode Appearance', { platform: 'darwin', env: {}, home: '/Users/a' }), '/Users/a/Applications');
    assert.equal(defaultDir('My ZCode', { platform: 'linux', env: {}, home: '/home/a' }), '/home/a/.local/opt/my-zcode');
    assert.equal(defaultDir('My ZCode', { platform: 'linux', env: { XDG_DATA_HOME: '/x' }, home: '/home/a' }), '/home/a/.local/opt/my-zcode');
    assert.equal(idOf('My ZCode'), 'my-zcode');
    assert.equal(idOf('中文'), 'zcode-appearance', 'a name with no letters or digits takes the fallback');
    assert.match(helpText({ platform: 'linux', home: '/home/a' }), /\/home\/a\/\.local\/opt\/<名称>/);
    assert.match(helpText({ platform: 'darwin', home: '/home/a' }), /程序坞/);
    assert.match(helpText({ platform: 'win32' }), /固定到任务栏/);
    assert.match(helpText({ platform: 'freebsd' }), /做不了启动器/);
  });
});

describe('setting it up', { skip }, () => {
  it('points the program at the plugin it was run from, by default', async () => {
    const dir = tempDir('appearance-setup-');
    const result = await setup({ name: 'ZCode Appearance Setup', dir, shortcut: false });
    assert.equal(result.mode, 'link');
    assert.equal(fs.readFileSync(path.join(dir, 'launch-path.txt'), 'utf8').trim(), path.join(PLUGIN, 'bin', 'launch.mjs'));
    assert.equal(result.shortcut, null);
    assert.equal(fileNameOf(result.exe), fileNameOf(path.join(dir, 'ZCode Appearance Setup.exe')));
    const gone = uninstall({ name: 'ZCode Appearance Setup', dir });
    // Its own files by name, then the folder, which is empty by then.
    assert.deepEqual(gone.removed.map((item) => path.basename(item)), ['ZCode Appearance Setup.exe', 'Launcher.cs', 'app.ico', 'launch-path.txt', path.basename(dir)]);
    assert.equal(gone.left, null);
    assert.equal(fs.existsSync(dir), false);
  });

  it('takes away only its own files, and leaves the folder when someone else keeps things there', async () => {
    const dir = tempDir('appearance-setup-shared-');
    await setup({ name: 'ZCode Appearance Shared', dir, shortcut: false });
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep');
    const gone = uninstall({ name: 'ZCode Appearance Shared', dir });
    assert.equal(gone.left, dir, 'the folder stays');
    assert.equal(gone.kept, null);
    assert.ok(gone.removed.every((item) => item !== dir));
    assert.deepEqual(fs.readdirSync(dir), ['notes.txt']);
  });

  it('refuses a folder that holds someone else\'s files, and an app/ folder that is not its own', async () => {
    // Pointed at a tools folder, this command once wrote into it and later took the whole folder away.
    const busy = tempDir('appearance-setup-busy-');
    fs.writeFileSync(path.join(busy, 'tool.exe'), 'keep');
    await assert.rejects(setup({ name: 'ZCode Appearance Busy', dir: busy, shortcut: false }), /不往别人的目录里写/);
    assert.deepEqual(fs.readdirSync(busy), ['tool.exe'], 'nothing was written');
    // Its own folder, but with an app/ folder someone else made: --copy wants that place.
    const own = tempDir('appearance-setup-app-');
    await setup({ name: 'ZCode Appearance App', dir: own, shortcut: false });
    fs.mkdirSync(path.join(own, 'app'));
    fs.writeFileSync(path.join(own, 'app', 'precious.txt'), 'keep');
    await assert.rejects(setup({ name: 'ZCode Appearance App', dir: own, shortcut: false, mode: 'copy' }), /--copy 要用它放启动器的文件/);
    assert.equal(fs.readFileSync(path.join(own, 'app', 'precious.txt'), 'utf8'), 'keep');
  });

  it('copies the launcher\'s own files when asked, and those are enough to run', async () => {
    const dir = tempDir('appearance-setup-copy-');
    const result = await setup({ name: 'ZCode Appearance Copy', dir, shortcut: false, mode: 'copy' });
    assert.equal(result.mode, 'copy');
    const script = fs.readFileSync(path.join(dir, 'launch-path.txt'), 'utf8').trim();
    assert.equal(script, path.join(dir, 'app', 'bin', 'launch.mjs'));
    assert.ok(fs.existsSync(script));
    // Every file the launcher imports at start is there: it loads without a missing module.
    const check = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8', windowsHide: true });
    assert.equal(check.status, 0, check.stderr);
    const imports = [...fs.readFileSync(script, 'utf8').matchAll(/from '\.\.\/(src\/[^']+)'/g)].map((match) => match[1]);
    assert.ok(imports.length > 0);
    for (const name of imports) assert.ok(fs.existsSync(path.join(dir, 'app', name)), name);
    const gone = uninstall({ name: 'ZCode Appearance Copy', dir });
    assert.equal(gone.kept, null);
    assert.equal(gone.left, null);
    assert.equal(fs.existsSync(dir), false);
  });

  it('leaves a folder alone that it did not make', () => {
    const dir = tempDir('appearance-foreign-');
    fs.writeFileSync(path.join(dir, 'ZCode Appearance Foreign.exe'), 'not ours');
    const result = uninstall({ name: 'ZCode Appearance Foreign', dir });
    assert.equal(result.kept, dir);
    assert.deepEqual(result.removed, []);
    assert.equal(fs.existsSync(path.join(dir, 'ZCode Appearance Foreign.exe')), true);
  });

  it('refuses what it cannot do, and says what', () => {
    assert.throws(() => parseArgs(['--wat']), /不认识的选项：--wat/);
    assert.throws(() => parseArgs(['--name']), /--name 后面要跟一个值/);
    assert.throws(() => parseArgs(['--name', '***']), /名称里至少要有一个能用作文件名的字符/);
    assert.deepEqual(parseArgs(['--name', '  My ZCode  ']).name, 'My ZCode');
    assert.equal(parseArgs([]).name, DEFAULT_NAME);
    assert.equal(parseArgs([]).mode, 'link');
    assert.equal(parseArgs(['--copy']).mode, 'copy');
    assert.equal(parseArgs(['--dir', 'x']).dir, path.resolve('x'));
    assert.throws(() => buildLauncher({ outDir: tempDir('appearance-noscript-'), name: 'x', script: path.join('nowhere', 'launch.mjs') }), (err) => err instanceof SetupError && /启动脚本不存在/.test(err.message));
    // A line break cannot go into the program's title: it becomes a space there, and nothing in the file name.
    const named = buildLauncher({ outDir: tempDir('appearance-named-'), name: 'Two\nLines', script: path.join(PLUGIN, 'bin', 'launch.mjs') });
    assert.equal(path.basename(named.exe), 'TwoLines.exe');
  });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { defaultConfig, ROTATE_MAX_MINUTES, saveConfig } from '../src/config.mjs';
import { createLogger, createPlanSource, findZcode, isZcodeRunning, LauncherError, locateZcode, parseArgs, resolveZcode, supervise, zcodeCandidates } from '../src/launcher.mjs';
import { isAlive, launcherState, readStatus } from '../src/status.mjs';
import { commandPrompt, powershellExe, shellEnvironment } from '../src/system.mjs';

const quiet = { info() {}, warn() {} };

// Awaits the body before removing the directory: some bodies are async.
const inTempDir = async (run) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appearance-launcher-'));
  try {
    return await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Asks until `read` gives something else than `before`, or gives up saying what it kept giving.
async function untilChanged(read, before, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== before) return value;
    if (Date.now() > deadline) throw new Error(`it stayed ${JSON.stringify(before)}`);
    await sleep(20);
  }
}
// The config and two files next to it. The second file has other bytes: two identical pictures
// would give two identical stylesheets.
function makeHome(dir) {
  fs.writeFileSync(path.join(dir, 'first.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  fs.writeFileSync(path.join(dir, 'second.png'), Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'), Buffer.from([0])]));
  fs.writeFileSync(path.join(dir, 'clip.webm'), Buffer.from(fs.readFileSync(new URL('./fixtures/tiny.webm.base64', import.meta.url), 'utf8').trim(), 'base64'));
  const file = path.join(dir, 'appearance.json');
  const write = (background) => saveConfig({
    background: { enabled: true, media: [path.join(dir, 'first.png'), path.join(dir, 'second.png')], scope: 'page', rotateMinutes: 0, mask: 0.72, blur: 0, ...background },
    skin: { preset: 'default', custom: null },
    launcher: { zcodePath: null, port: 9337 },
  }, { file });
  write({});
  return { file, write };
}

describe('command line', () => {
  it('starts ZCode by default', () => {
    assert.deepEqual(parseArgs([]), { mode: 'run', attach: false, attachPort: null, once: false, verbose: false, config: null, pollMs: 2000 });
    assert.equal(parseArgs(['--edit']).mode, 'edit');
    assert.equal(parseArgs(['--status']).mode, 'status');
    assert.equal(parseArgs(['--help']).mode, 'help');
    assert.equal(parseArgs(['-v']).verbose, true);
    assert.equal(parseArgs(['--once']).once, true);
  });

  it('attaches to a running instance on the port it is given', () => {
    assert.deepEqual(parseArgs(['--attach=9333', '--once']), { mode: 'run', attach: true, attachPort: 9333, once: true, verbose: false, config: null, pollMs: 2000 });
    assert.equal(parseArgs(['--attach']).attachPort, null, 'the port comes from the status file or the settings');
  });

  it('resolves the config path and refuses what it does not know', () => {
    assert.equal(parseArgs(['--config', 'look.json']).config, path.resolve('look.json'));
    assert.throws(() => parseArgs(['--config']), /--config 后面要跟一个文件路径/);
    assert.throws(() => parseArgs(['--wat']), /不认识的选项：--wat/);
    assert.throws(() => parseArgs(['--attach=0']), /--attach 的端口/);
    assert.throws(() => parseArgs(['--attach=70000']), /--attach 的端口/);
  });
});

describe('finding ZCode', () => {
  it('takes the executable from the environment, when it exists', () => inTempDir((dir) => {
    const fake = path.join(dir, 'ZCode.exe');
    fs.writeFileSync(fake, '');
    assert.equal(findZcode({ configured: null, env: { ZCODE_APPEARANCE_EXE: fake } }), fake);
    assert.throws(() => findZcode({ configured: null, env: { ZCODE_APPEARANCE_EXE: path.join(dir, 'nope.exe') } }), /ZCODE_APPEARANCE_EXE 指向的文件不存在/);
  }));

  it('treats a configured path that is missing as the mistake it is', () => inTempDir((dir) => {
    const missing = path.join(dir, 'gone', 'ZCode.exe');
    assert.throws(() => findZcode({ configured: missing, env: {} }), (err) => err instanceof LauncherError && err.message.includes(missing));
    const fake = path.join(dir, 'ZCode.exe');
    fs.writeFileSync(fake, '');
    assert.equal(findZcode({ configured: fake, env: {} }), fake);
  }));

  it('finds nothing rather than guessing when nothing is installed where it looks', () => {
    assert.equal(findZcode({ configured: null, env: { PATH: '' }, platform: 'linux' }), null);
    const mac = zcodeCandidates({ env: { PATH: '', HOME: '/Users/someone' }, platform: 'darwin' });
    assert.equal(mac[0], '/Applications/ZCode.app/Contents/MacOS/ZCode');
    assert.equal(mac.length, 2);
    assert.ok(mac[1].endsWith(path.join('someone', 'Applications', 'ZCode.app', 'Contents', 'MacOS', 'ZCode')));
  });

  // The system is asked through commands; their answers are faked by what the command asked for.
  const fakeSystem = (answers) => {
    const asked = [];
    const run = async (_file, args) => {
      const script = args.at(-1);
      const kind = args[0] === '-x' ? 'processes' : script.includes('Get-Process') ? 'processes' : script.includes('$roots') ? 'registry' : 'other';
      asked.push(kind);
      return answers[kind] ?? '';
    };
    return { run, asked };
  };

  it('takes a running copy before the installer\'s record and the usual folders', () => inTempDir(async (dir) => {
    const live = path.join(dir, 'Apps', 'ZCode.exe');
    fs.mkdirSync(path.dirname(live));
    fs.writeFileSync(live, '');
    const registered = path.join(dir, 'Registered', 'ZCode.exe');
    const system = fakeSystem({ processes: `3\r\n${live}\r\n`, registry: registered });
    assert.equal(await resolveZcode({ env: {}, platform: 'win32', run: system.run }), live);
    assert.deepEqual(system.asked, ['processes'], 'the registry was not asked: a running copy says where it is');
  }));

  it('asks the installer\'s record only when the usual folders have nothing: that answer costs a PowerShell start', async () => {
    const usual = zcodeCandidates({ env: {}, platform: 'win32' })[0];
    const registered = 'D:\\D Apps\\ZCode.exe';
    // Both are there: the usual folder wins, and the registry is not even asked.
    const both = fakeSystem({ processes: '0\r\n', registry: `${registered}\r\n` });
    assert.equal(await resolveZcode({ env: {}, platform: 'win32', run: both.run, exists: (file) => file === usual || file === registered }), usual);
    assert.deepEqual(both.asked, ['processes'], 'no PowerShell for the registry');
    // Nothing usual: the record is asked, and taken.
    const record = fakeSystem({ processes: '0\r\n', registry: `${registered}\r\n` });
    assert.equal(await resolveZcode({ env: {}, platform: 'win32', run: record.run, exists: (file) => file === registered }), registered);
    assert.deepEqual(record.asked, ['processes', 'registry']);
    // A record that names a file that is not there is no answer.
    const gone = fakeSystem({ processes: '0\r\n', registry: 'D:\\Gone\\ZCode.exe\r\n' });
    assert.equal(await resolveZcode({ env: {}, platform: 'win32', run: gone.run, exists: () => false }), null);
  });

  it('asks nothing when something was configured, and nothing of the registry elsewhere', async () => {
    const system = fakeSystem({ registry: 'D:\\Apps\\ZCode.exe\r\n' });
    assert.equal(await resolveZcode({ env: { ZCODE_APPEARANCE_EXE: process.execPath }, platform: 'win32', run: system.run }), process.execPath);
    assert.deepEqual(system.asked, [], 'nothing was asked');
    // On macOS and Linux the record does not exist; only a running copy and the folders.
    assert.equal(await resolveZcode({ env: { PATH: '' }, platform: 'linux', run: system.run, exists: () => false }), null);
    assert.deepEqual(system.asked, ['processes']);
  });

  it('takes the answer about running copies from the caller instead of asking twice', () => inTempDir(async (dir) => {
    const live = path.join(dir, 'ZCode.exe');
    fs.writeFileSync(live, '');
    const system = fakeSystem({ registry: 'D:\\Other\\ZCode.exe\r\n' });
    assert.equal(await resolveZcode({ env: {}, platform: 'win32', run: system.run, running: { count: 1, path: live } }), live);
    assert.deepEqual(system.asked, []);
  }));

  it('keeps saying when a configured path is missing', async () => {
    await assert.rejects(resolveZcode({ configured: path.join('nowhere', 'ZCode.exe'), env: {}, platform: 'win32', run: fakeSystem({}).run }), (err) => err instanceof LauncherError && /launcher\.zcodePath/.test(err.message));
  });

  // Before a start: one quick question instead of a PowerShell start. The answer is read by the
  // line that names the process, not by the "no tasks" line, which is in the system's language.
  it('says whether ZCode is running from what tasklist lists, whatever its language', async () => {
    const running = await isZcodeRunning({ platform: 'win32', run: async (file, args) => { assert.ok(/tasklist\.exe$/.test(file)); assert.deepEqual(args.slice(0, 2), ['/FI', 'IMAGENAME eq ZCode.exe']); return '"ZCode.exe","1844","Console","1","412,356 K"\r\n"ZCode.exe","1908","Console","1":"88,012 K"\r\n'; } });
    assert.equal(running, true);
    assert.equal(await isZcodeRunning({ platform: 'win32', run: async () => '\r\n信息: 没有运行的任务匹配指定标准。\r\n' }), false, 'Chinese Windows');
    assert.equal(await isZcodeRunning({ platform: 'win32', run: async () => 'INFO: No tasks are running which match the specified criteria.\r\n' }), false);
    // Another process with a name that begins the same way is not ZCode.
    assert.equal(await isZcodeRunning({ platform: 'win32', run: async () => '"ZCodeHelper.exe","777","Console","1","9,004 K"\r\n' }), false);
    assert.equal(await isZcodeRunning({ platform: 'linux', run: async (_file, args) => { assert.deepEqual(args, ['-x', 'ZCode']); return '4188\n'; } }), true);
    assert.equal(await isZcodeRunning({ platform: 'darwin', run: async () => '' }), false);
  });

  it('says where the answer came from, for the log', () => inTempDir(async (dir) => {
    const live = path.join(dir, 'ZCode.exe');
    fs.writeFileSync(live, '');
    const system = fakeSystem({ processes: `1\r\n${live}\r\n`, registry: `${live}\r\n` });
    assert.equal((await locateZcode({ env: {}, platform: 'win32', run: system.run })).source, '正在运行的 ZCode 进程');
    const usual = zcodeCandidates({ env: {}, platform: 'win32' })[0];
    assert.equal((await locateZcode({ env: {}, platform: 'win32', run: system.run, running: { count: 0, path: null }, exists: (file) => file === usual })).source, '常见目录');
    assert.equal((await locateZcode({ env: {}, platform: 'win32', run: system.run, running: { count: 0, path: null }, exists: (file) => file === live })).source, '系统的安装记录');
    assert.equal((await locateZcode({ env: { ZCODE_APPEARANCE_EXE: live }, platform: 'win32', run: system.run })).source, '环境变量 ZCODE_APPEARANCE_EXE');
    assert.equal((await locateZcode({ configured: live, env: {}, platform: 'win32', run: system.run })).source, '配置里的 launcher.zcodePath');
    assert.deepEqual(await locateZcode({ env: { PATH: '' }, platform: 'linux', run: system.run, exists: () => false }), { exe: null, source: null });
  }));
});

describe('system tools', () => {
  // A program started by its bare name is looked for in the current folder first on Windows.
  it('are started by their full path where this Windows keeps them, and by name only when it does not', { skip: process.platform === 'win32' ? false : 'Windows only' }, () => {
    assert.ok(path.isAbsolute(powershellExe()) && fs.existsSync(powershellExe()), powershellExe());
    assert.equal(powershellExe({ SystemRoot: 'C:\\not-a-windows' }), 'powershell');
    assert.ok(path.isAbsolute(commandPrompt()) && fs.existsSync(commandPrompt()), commandPrompt());
    assert.equal(commandPrompt({ SystemRoot: 'C:\\not-a-windows' }), 'cmd');
    assert.equal(commandPrompt({ ComSpec: 'Z:\\not-there\\cmd.exe' }), 'cmd', 'a ComSpec that is not there is not used');
  });

  // The process the app starts this code in may lack what Windows itself expects; the shell
  // behind the file dialog then wrote its caches into a folder literally called `%SystemDrive%`.
  it('gives a Windows tool the variables the shell expects, and only the ones that are missing', () => {
    const filled = shellEnvironment({ SystemRoot: 'C:\\Windows', PATH: '' });
    assert.deepEqual([filled.SystemDrive, filled.ProgramData], ['C:', 'C:\\ProgramData']);
    assert.deepEqual(filled, { SystemRoot: 'C:\\Windows', PATH: '', SystemDrive: 'C:', ProgramData: 'C:\\ProgramData' });
    const kept = shellEnvironment({ SystemDrive: 'D:', ProgramData: 'D:\\Data', SystemRoot: 'D:\\Windows', PATH: 'x' });
    assert.deepEqual(kept, { SystemDrive: 'D:', ProgramData: 'D:\\Data', SystemRoot: 'D:\\Windows', PATH: 'x' }, 'what is there stays');
    assert.deepEqual(shellEnvironment({}), {}, 'nothing to go by: nothing made up');
    assert.deepEqual(shellEnvironment({ WINDIR: 'E:\\Win' }), { WINDIR: 'E:\\Win', SystemDrive: 'E:', ProgramData: 'E:\\ProgramData' }, 'WINDIR will do for the drive');
  });
});

describe('log', () => {
  it('writes lines and starts over instead of growing without end', () => inTempDir((dir) => {
    const file = path.join(dir, 'appearance.log');
    fs.writeFileSync(file, 'x'.repeat(600 * 1024));
    const seen = [];
    const logger = createLogger({ file, verbose: true, stderr: { write: (text) => seen.push(text) } });
    logger.info('started');
    logger.warn('a window closed');
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.length < 600, 'the old log was dropped first');
    assert.match(text, /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] info started\n\[[^\]]+\] warn a window closed\n$/);
    assert.equal(seen.length, 2, 'and on screen when verbose');
  }));
});

describe('status file', () => {
  it('tells a live launcher from a file left behind', () => inTempDir((dir) => {
    const file = path.join(dir, 'appearance.status.json');
    assert.deepEqual(launcherState(file), { running: false, port: null });
    fs.writeFileSync(file, JSON.stringify({ launcherPid: process.pid, port: 4321 }));
    assert.deepEqual(launcherState(file), { running: true, port: 4321 });
    assert.equal(isAlive(process.pid), true);
    assert.equal(isAlive(2147483647), false);
    assert.equal(readStatus(file).launcherPid, process.pid);
    fs.writeFileSync(file, JSON.stringify({ port: 4321 }));
    assert.equal(readStatus(file), null, 'a file without a pid says nothing');
    fs.writeFileSync(file, 'not json');
    assert.equal(readStatus(file), null);
  }));
});

describe('settings are read when they change, not on a timer', () => {
  it('does not look at the file at all while nothing changed', () => inTempDir(async (dir) => {
    const home = makeHome(dir);
    const source = createPlanSource({ file: home.file, logger: quiet, watch: watchStub() });
    const first = await source.getPlan();
    // With no watch to tell it and the half-minute check far away, the file is not even statted:
    // the plan is the one that was built, and asking again is free of any file access.
    let stats = 0;
    const realStat = fs.statSync;
    fs.statSync = (...args) => {
      stats += 1;
      return realStat(...args);
    };
    try {
      for (let i = 0; i < 20; i += 1) assert.equal(await source.getPlan(), first);
    } finally {
      fs.statSync = realStat;
    }
    assert.equal(stats, 0, `${stats} stat calls in 20 asks`);
    source.stop();
  }));

  it('reads the file when the watch says it changed', () => inTempDir(async (dir) => {
    const home = makeHome(dir);
    const watch = watchStub();
    const source = createPlanSource({ file: home.file, logger: quiet, watch: watch });
    const first = await source.getPlan();
    home.write({ scope: 'chat', mask: 0.4 });
    watch.fire(path.basename(home.file));
    const second = await untilChanged(() => source.getPlan().then((plan) => plan.key), first.key);
    assert.notEqual(second, first.key);
    assert.equal((await source.getPlan()).css.includes('40%, transparent'), true);
    // A change to another file in the folder is not a change to the settings.
    home.write({ mask: 0.9 });
    watch.fire('appearance.log');
    assert.equal((await source.getPlan()).key, second);
    watch.fire(path.basename(home.file));
    await untilChanged(() => source.getPlan().then((plan) => plan.key), second);
    source.stop();
    assert.equal(watch.closed >= 2, true, 'stop closes both watches');
  }));

  it('reads the file half a minute later even when the watch said nothing', () => inTempDir(async (dir) => {
    const home = makeHome(dir);
    let clock = 1_000_000;
    const source = createPlanSource({ file: home.file, logger: quiet, watch: watchStub(), now: () => clock });
    const first = await source.getPlan();
    await sleep(30);
    home.write({ mask: 0.1 });
    clock += 29_000;
    assert.equal((await source.getPlan()).key, first.key, 'not yet');
    clock += 2_000;
    const later = await source.getPlan();
    assert.notEqual(later.key, first.key, 'the file is compared again after half a minute');
    assert.ok(later.css.includes('10%, transparent'));
    source.stop();
  }));

  it('wakes whoever waits for a change', () => inTempDir(async (dir) => {
    const home = makeHome(dir);
    const watch = watchStub();
    const source = createPlanSource({ file: home.file, logger: quiet, watch: watch });
    await source.getPlan();
    let woken = false;
    const waiting = source.change().then(() => {
      woken = true;
    });
    await sleep(40);
    assert.equal(woken, false, 'not before anything changed');
    watch.fire(path.basename(home.file));
    await waiting;
    assert.equal(woken, true);
    // A waiter that is left behind can be taken back, and never keeps the loop awake.
    const cancelled = source.change();
    cancelled.cancel();
    watch.fire(path.basename(home.file));
    await sleep(40);
    source.stop();
  }));

  it('keeps the last good settings while the file is wrong, and recovers', () => inTempDir(async (dir) => {
    const home = makeHome(dir);
    const watch = watchStub();
    const warnings = [];
    const logger = { info() {}, warn: (message) => warnings.push(message) };
    const source = createPlanSource({ file: home.file, logger, watch: watch });
    const good = await source.getPlan();
    fs.writeFileSync(home.file, '{ "background": ');
    watch.fire(path.basename(home.file));
    await untilChanged(() => source.getPlan(), good);
    assert.equal((await source.getPlan()).key, good.key, 'still the settings from before the file broke');
    assert.equal(warnings.length, 1, 'and it says so once');
    assert.match(warnings[0], /not valid JSON/);
    home.write({ mask: 0.1 });
    watch.fire(path.basename(home.file));
    const repaired = await untilChanged(() => source.getPlan(), good);
    assert.notEqual(repaired.key, good.key);
    assert.ok(repaired.css.includes('10%, transparent'));
    source.stop();
  }));

  it('moves to the next file when the interval passes', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appearance-launcher-'));
    try {
      const home = makeHome(dir);
      home.write({ rotateMinutes: 30 });
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const source = createPlanSource({ file: home.file, logger: quiet, watch: watchStub() });
      const first = await source.getPlan();
      t.mock.timers.tick(30 * 60 * 1000);
      const second = await source.getPlan();
      assert.notEqual(second.key, first.key);
      t.mock.timers.tick(30 * 60 * 1000);
      assert.equal((await source.getPlan()).key, first.key, 'and round again');
      source.stop();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not turn a very long interval into a timer that fires at once', () => inTempDir(async (dir) => {
    const home = makeHome(dir);
    home.write({ rotateMinutes: ROTATE_MAX_MINUTES });
    const source = createPlanSource({ file: home.file, logger: quiet, watch: watchStub() });
    await source.getPlan();
    // A timer cannot hold a year in milliseconds; uncapped, it would fire every millisecond.
    const outcome = await Promise.race([source.change().then(() => 'changed'), sleep(300).then(() => 'quiet')]);
    source.stop();
    assert.equal(outcome, 'quiet');
  }));

  it('plays a video from its file and never reads it into the stylesheet', () => inTempDir(async (dir) => {
    const home = makeHome(dir);
    home.write({ media: [path.join(dir, 'clip.webm')] });
    const watch = watchStub();
    const source = createPlanSource({ file: home.file, logger: quiet, watch: watch });
    const plan = await source.getPlan();
    assert.ok(plan.script.includes(`"video":"${pathToFileURL(path.join(dir, 'clip.webm')).href}"`));
    assert.ok(!plan.css.includes('base64'), 'a video is not embedded');
    source.stop();
  }));

  it('falls back to a watch that reports an error, and keeps working', () => inTempDir(async (dir) => {
    const home = makeHome(dir);
    const warnings = [];
    const logger = { info() {}, warn: (message) => warnings.push(message) };
    const source = createPlanSource({ file: home.file, logger, watch: (folder, onChange, onError) => {
      onError(new Error('EPERM: watch denied'));
      return null;
    } });
    assert.equal((await source.getPlan()).css.includes('72%, transparent'), true, 'the settings are still read once');
    // Both folders are watched, and each watch reports for itself, once.
    assert.equal(warnings.filter((message) => message.includes('监听配置目录失败')).length, 1);
    assert.equal(warnings.filter((message) => message.includes('监听样式模块的目录失败')).length, 1);
    source.stop();
  }));
});

// A stand-in for the folder watch createPlanSource takes: a function, as fs.watch is, that
// reports only what the test tells it to (`fire(name)` tells every watcher), and remembers
// whether the watchers were closed.
function watchStub() {
  const watch = (folder, onChange, onError) => {
    watch.listeners.push(onChange);
    return {
      close: () => {
        watch.closed += 1;
      },
    };
  };
  watch.closed = 0;
  watch.listeners = [];
  watch.fire = (name) => {
    for (const listener of watch.listeners) listener(name);
  };
  return watch;
}

describe('stylesheet generator', () => {
  // A stand-in for src/css.mjs in a directory of its own: same exports, a key it decides itself.
  const writeGenerator = (dir, key) => fs.writeFileSync(path.join(dir, 'css.mjs'), `
export function buildPlan() { return { key: ${JSON.stringify(key)}, css: 'a', script: '', check: '' }; }
export function imageDataUrl() { return null; }
`);
  const configIn = (dir) => saveConfig(defaultConfig(), { file: path.join(dir, 'appearance.json') });
  const later = () => new Promise((resolve) => setTimeout(resolve, 30));

  it('picks up a changed generator without being restarted', () => inTempDir(async (dir) => {
    configIn(dir);
    writeGenerator(dir, 'first');
    const watch = watchStub();
    const source = createPlanSource({ file: path.join(dir, 'appearance.json'), logger: quiet, cssModule: pathToFileURL(path.join(dir, 'css.mjs')), watch: watch });
    assert.equal((await source.getPlan()).key, 'first');
    await later();
    writeGenerator(dir, 'second');
    assert.equal((await source.getPlan()).key, 'first', 'nothing happens until the folder watch says so');
    watch.fire('css.mjs');
    assert.equal((await source.getPlan()).key, 'second');
    source.stop();
  }));

  it('keeps the working generator while the file does not parse, and says so once', () => inTempDir(async (dir) => {
    configIn(dir);
    writeGenerator(dir, 'first');
    const watch = watchStub();
    const warnings = [];
    const logger = { info() {}, warn: (message) => warnings.push(message) };
    const source = createPlanSource({ file: path.join(dir, 'appearance.json'), logger, cssModule: pathToFileURL(path.join(dir, 'css.mjs')), watch: watch });
    assert.equal((await source.getPlan()).key, 'first');
    await later();
    fs.writeFileSync(path.join(dir, 'css.mjs'), 'export function buildPlan( {');
    watch.fire('css.mjs');
    assert.equal((await source.getPlan()).key, 'first');
    await source.getPlan();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /样式模块加载不了/);
    source.stop();
  }));
});

describe('the loop', () => {
  const silentPort = async () => {
    // A port that was in use a moment ago and is free now: nothing listens on it.
    const server = net.createServer();
    const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
    await new Promise((resolve) => server.close(resolve));
    return port;
  };

  it('gives up when nothing answers for long enough', async () => {
    const warnings = [];
    const logger = { info() {}, warn: (message) => warnings.push(message) };
    await supervise({ port: await silentPort(), getPlan: () => ({ key: 'k', css: '', script: '', check: '' }), shouldStop: () => false, logger, pollMs: 5, giveUpAfterMs: 60 });
    assert.ok(warnings.some((message) => message.includes('一直没有应答')), warnings.join('\n'));
  });

  it('counts the wait by the clock, so a port that never answers is not waited out poll by poll', async () => {
    const warnings = [];
    const logger = { info() {}, warn: (message) => warnings.push(message) };
    let attempts = 0;
    // A port that accepts the connection and says nothing: every poll costs a timeout on top
    // of the interval, so counting polls would take twice as long as the wait asked for.
    const slow = async () => {
      attempts += 1;
      await sleep(300);
      throw new Error('fetch failed');
    };
    const started = Date.now();
    await supervise({ port: 1, getPlan: () => ({ key: 'k', css: '', script: '', check: '' }), shouldStop: () => false, logger, pollMs: 50, giveUpAfterMs: 1000, listTargetsImpl: slow });
    const elapsed = Date.now() - started;
    assert.ok(warnings.some((message) => message.includes('一直没有应答')), warnings.join('\n'));
    assert.ok(elapsed < 2000, `gave up after ${elapsed} ms`);
    assert.ok(attempts >= 3 && attempts <= 6, `${attempts} attempts`);
  });

  it('returns at once when the stop signal is already set', async () => {
    const started = Date.now();
    await supervise({ port: await silentPort(), getPlan: () => null, shouldStop: () => true, logger: quiet, pollMs: 5000, giveUpAfterMs: 60000 });
    assert.ok(Date.now() - started < 2000, 'does not sit out a poll interval first');
  });

  it('ends its interval when a change wakes it', async () => {
    const seen = [];
    let stop = false;
    const loop = supervise({
      port: await silentPort(),
      getPlan: () => {
        seen.push(Date.now());
        return null;
      },
      shouldStop: () => stop,
      logger: { info() {}, warn() {} },
      pollMs: 5000,
      giveUpAfterMs: 60000,
      wake: () => {
        // Wakes 100 ms after each ask, until the third one.
        let cancel;
        const promise = new Promise((resolve) => {
          const timer = setTimeout(resolve, seen.length < 3 ? 100 : 10000);
          cancel = () => clearTimeout(timer);
        });
        promise.cancel = cancel;
        return promise;
      },
    });
    await sleep(700);
    stop = true;
    await loop;
    assert.ok(seen.length >= 3, `${seen.length} asks in 700 ms with a 5 s interval`);
    assert.ok(seen[1] - seen[0] < 1000 && seen[2] - seen[1] < 1000, 'each one woken by the change, long before the interval');
  });
});

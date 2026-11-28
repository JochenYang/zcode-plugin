// The extension code (bin/extension.mjs) as the host drives it: what it registers, and every
// tool of the view against a real config file in a directory of its own.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { COMMAND_ID, TOOL_NAMES, VIEW_ID, activate } from '../../bin/extension.mjs';
import { PATH_TIMEOUT_MS, mediaInfo, skinList, viewData, viewStrings } from '../../src/extension/describe.mjs';
import { defaultConfig, saveConfig } from '../../src/config.mjs';
import { paths } from '../../src/paths.mjs';
import { SKIN_NAMES } from '../../src/skins.mjs';

const quiet = { error() {} };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// Awaits the body before removing the directory: the tools are async.
const inTempHome = async (run) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appearance-ext-'));
  try {
    return await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The host as the extension sees it: it records what gets registered. The launcher's status
// file is given too, so that a launcher running on the test machine changes nothing. `env.get`
// answers later, the way the real host does: it is a call into the app, not a property.
function hostFor(locale = 'zh-CN') {
  const host = {
    locale,
    errors: [],
    view: null,
    command: null,
    opened: [],
    asked: 0,
    log: { error: (message) => host.errors.push(message) },
    env: {
      get: async () => {
        host.asked += 1;
        return { locale: host.locale };
      },
    },
  };
  host.views = {
    register: (id, definition) => {
      host.view = { id, ...definition };
    },
    open: async (...args) => {
      host.opened.push(args);
    },
  };
  host.commands = {
    register: (id, run) => {
      host.command = { id, run };
    },
  };
  return host;
}
const tool = (host, name) => host.view.tools[name];
const call = (host, name, args) => tool(host, name).run(args);

// Files next to the config: two pictures (one of them gone) and a video.
function seed(dir) {
  const file = path.join(dir, 'appearance.json');
  fs.writeFileSync(path.join(dir, 'a.png'), PNG);
  fs.writeFileSync(path.join(dir, 'clip.webm'), Buffer.from('GkXfo59C', 'base64'));
  const config = defaultConfig();
  config.background.media = [path.join(dir, 'a.png'), path.join(dir, 'gone.png'), path.join(dir, 'clip.webm')];
  config.background.mask = 0.4;
  saveConfig(config, { file });
  return file;
}

// Start the extension on a directory of its own, with a status file that says no launcher runs.
async function start(host, dir, extra = {}) {
  const handle = await activate(host, { file: path.join(dir, 'appearance.json'), statusFile: path.join(dir, 'appearance.status.json'), pick: async () => [], open: () => {}, ...extra });
  return { host, handle, file: path.join(dir, 'appearance.json') };
}

describe('what the extension registers', () => {
  it('the view with its tools, and the command that opens it', async () => inTempHome(async (dir) => {
    const host = hostFor();
    const { handle } = await start(host, dir, { file: seed(dir) });
    assert.equal(host.view.id, VIEW_ID);
    assert.equal(host.view.entry, 'ui/index.html');
    assert.deepEqual(Object.keys(host.view.tools).sort(), [...TOOL_NAMES].sort());
    assert.equal(host.command.id, COMMAND_ID);
    assert.deepEqual(await host.command.run(), { ok: true });
    assert.deepEqual(host.opened, [[VIEW_ID, 'app']]);
    assert.deepEqual(host.errors, []);
    handle.dispose();
  }));

  it('survives a host that offers nothing to register with', async () => inTempHome(async (dir) => {
    const { handle } = await start({}, dir, { file: seed(dir) });
    assert.equal(typeof handle.dispose, 'function');
    handle.dispose();
  }));

  it('speaks the app\'s language, asked for on every answer, and English when it cannot be had', async () => inTempHome(async (dir) => {
    const host = hostFor('zh-CN');
    await start(host, dir, { file: seed(dir) });
    const first = await call(host, 'get', {});
    assert.equal(first.data.lang, 'zh-CN');
    assert.equal(first.data.text.title, '外观');
    // The app's language is not the system's: it can be changed while the view is open.
    host.locale = 'en-US';
    const second = await call(host, 'get', {});
    assert.equal(second.data.lang, 'en');
    assert.equal(second.data.text.title, 'Appearance');
    assert.ok(host.asked >= 2, 'asked again, not remembered from the first answer');
    // Nothing to ask, or a call that fails: the page still gets an answer, in English.
    const mute = hostFor();
    mute.env.get = async () => {
      throw new Error('host-unavailable');
    };
    await start(mute, dir, { file: seed(dir) });
    assert.equal((await call(mute, 'get', {})).data.lang, 'en');
    // No `env` at all, on a host that says the app is Chinese by every other sign.
    const bare = hostFor('zh-CN');
    delete bare.env;
    await start(bare, dir, { file: seed(dir) });
    assert.equal((await call(bare, 'get', {})).data.lang, 'en');
    // A failure reported by a tool is in the language the app has at that moment.
    host.locale = 'zh-TW';
    const refused = await call(host, 'add', { paths: ['relative.png'] });
    assert.equal(refused.ok, false);
    assert.match(refused.message, /完整的路径/);
  }));

  it('reads whether the launcher runs from the status file it is given', async () => inTempHome(async (dir) => {
    const host = hostFor();
    fs.writeFileSync(path.join(dir, 'appearance.status.json'), JSON.stringify({ launcherPid: process.pid, port: 4321 }));
    await start(host, dir, { file: seed(dir) });
    assert.deepEqual((await call(host, 'get', {})).data.launcher, { running: true, port: 4321 });
  }));
});

describe('view tools', () => {
  it('get: the settings, the files with whether they are there, the skins, and every line of copy', async () => inTempHome(async (dir) => {
    const host = hostFor('zh-CN');
    await start(host, dir, { file: seed(dir) });
    const answer = await call(host, 'get', {});
    assert.equal(answer.ok, true);
    const { data } = answer;
    assert.equal(data.background.mask, 0.4);
    assert.equal(data.background.scope, 'page');
    assert.deepEqual(data.media.map((item) => [item.name, item.kind, item.exists]), [['a.png', 'picture', true], ['gone.png', 'picture', false], ['clip.webm', 'video', true]]);
    assert.deepEqual(data.skins.map((skin) => skin.name), [...SKIN_NAMES], 'every preset the stylesheet knows, the custom one aside');
    assert.deepEqual(data.launcher, { running: false, port: null });
    assert.equal(data.file, path.join(dir, 'appearance.json'));
    assert.equal(data.lang, 'zh-CN');
    assert.equal(data.text.title, '外观');
    assert.equal(data.pick, null, 'no file dialog has closed yet');
    // Everything but the copy survives the bridge to the page unchanged, and of the copy every
    // line that crosses is a string (the two the extension fills in itself do not cross).
    const travelled = JSON.parse(JSON.stringify(answer));
    assert.deepEqual({ ...travelled.data, text: null }, { ...answer.data, text: null });
    assert.deepEqual(Object.keys(travelled.data.text).sort(), Object.keys(answer.data.text).filter((name) => typeof answer.data.text[name] !== 'function').sort());
    for (const [name, value] of Object.entries(travelled.data.text)) assert.equal(typeof value, 'string', `text.${name}`);
  }));

  it('get answers in English for an English session', () => inTempHome(async (dir) => {
    const host = hostFor('en-US');
    await activate(host, { file: seed(dir), statusFile: path.join(dir, 'appearance.status.json'), pick: async () => [], open: () => {} });
    const { data } = await call(host, 'get', {});
    assert.equal(data.lang, 'en');
    assert.equal(data.text.title, 'Appearance');
    assert.equal(data.text.show, 'Show the background');
  }));

  it('set: changes only what was passed, saves it, and returns what is now in force', () => inTempHome(async (dir) => {
    const file = seed(dir);
    const host = hostFor();
    await activate(host, { file, statusFile: path.join(dir, 'appearance.status.json'), pick: async () => [], open: () => {} });
    // Started from values that are not the defaults, so that "kept" cannot be mistaken for "reset".
    await call(host, 'set', { blur: 7, rotateMinutes: 30 });
    const answer = await call(host, 'set', { scope: 'chat', mask: 0.6 });
    assert.equal(answer.ok, true);
    assert.equal(answer.message, viewStrings('zh-CN').saved);
    assert.equal(answer.data.background.scope, 'chat');
    assert.equal(answer.data.background.mask, 0.6);
    assert.equal(answer.data.background.blur, 7, 'untouched');
    assert.equal(answer.data.background.rotateMinutes, 30, 'untouched');
    assert.equal(answer.data.media.length, 3, 'the files are untouched');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.background.scope, 'chat');
    assert.equal(saved.background.mask, 0.6);
    assert.equal(await call(host, 'set', { skin: 'kanagawa' }).then((result) => result.data.skin.preset), 'kanagawa');
    assert.equal(await call(host, 'set', { mask: 0.5 }).then((result) => result.data.skin.preset), 'kanagawa', 'the skin is untouched by a later change');
  }));

  it('set refuses a value out of range without touching the file', () => inTempHome(async (dir) => {
    const file = seed(dir);
    const before = fs.readFileSync(file, 'utf8');
    const host = hostFor();
    await activate(host, { file, statusFile: path.join(dir, 'appearance.status.json'), pick: async () => [], open: () => {} });
    const answer = await call(host, 'set', { mask: 7 });
    assert.equal(answer.ok, false);
    assert.match(answer.message, /background\.mask must be a number from 0 to 1/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }));

  it('add: files by path, refusing what is not a picture or a video', () => inTempHome(async (dir) => {
    const file = seed(dir);
    const late = path.join(dir, 'late.png');
    fs.writeFileSync(late, PNG);
    const host = hostFor();
    await activate(host, { file, statusFile: path.join(dir, 'appearance.status.json'), pick: async () => [], open: () => {} });
    const answer = await call(host, 'add', { paths: ['late.png', late.toUpperCase()] });
    assert.equal(answer.ok, false, 'a relative path has no folder to be relative to here');
    assert.match(answer.message, /^请写完整的路径（从盘符或 ~ 开始）：late\.png$/);
    const added = await call(host, 'add', { paths: [late, late.toUpperCase()] });
    assert.equal(added.ok, true);
    assert.equal(added.message, viewStrings('zh-CN').added([late]));
    assert.equal(added.data.media.length, 4, 'the same file twice is added once');
    const homeRelative = await call(host, 'add', { paths: ['~/walls/x.png'] });
    assert.equal(homeRelative.ok, true, '~ is a whole path');
    const refused = await call(host, 'add', { paths: [path.join(dir, 'notes.txt')] });
    assert.equal(refused.ok, false);
    assert.match(refused.message, /^这个文件不是图片或视频，或者找不到：.*notes\.txt/);
  }));

  it('remove: one file by its path', () => inTempHome(async (dir) => {
    const file = seed(dir);
    const host = hostFor();
    await activate(host, { file, statusFile: path.join(dir, 'appearance.status.json'), pick: async () => [], open: () => {} });
    const answer = await call(host, 'remove', { path: path.join(dir, 'gone.png') });
    assert.equal(answer.ok, true);
    assert.equal(answer.message, '已移除 gone.png。');
    assert.deepEqual(answer.data.media.map((item) => item.name), ['a.png', 'clip.webm']);
    // A path that is not in the list is said, not reported as removed.
    const absent = await call(host, 'remove', { path: path.join(dir, 'never.png') });
    assert.equal(absent.ok, false);
    assert.equal(absent.message, '列表里没有 never.png，没有东西可移除。');
    assert.equal((await call(host, 'get', {})).data.media.length, 2);
  }));

  it('pick: opening the dialog again does not take away the answer waiting to be read', () => inTempHome(async (dir) => {
    const file = seed(dir);
    const late = path.join(dir, 'late.png');
    fs.writeFileSync(late, PNG);
    let release = null;
    let dialogs = 0;
    const host = hostFor();
    await activate(host, { file, statusFile: path.join(dir, 'appearance.status.json'), pick: async () => {
      dialogs += 1;
      // The first dialog closes at once; the second stays open until the test lets it go.
      return dialogs === 1 ? [late] : new Promise((resolve) => {
        release = resolve;
      });
    }, open: () => {} });
    await call(host, 'pick', {});
    await sleep(20);
    await call(host, 'pick', {});
    const waiting = await call(host, 'get', {});
    assert.deepEqual(waiting.data.pick, { files: [late], message: '已添加 late.png。' }, 'the answer of the first dialog is still there');
    release([late]);
    await sleep(20);
    const next = await call(host, 'get', {});
    assert.deepEqual(next.data.pick.files, [late], 'then the second dialog\'s answer');
  }));

  it('pick: answers at once, then hands the chosen files over once', () => inTempHome(async (dir) => {
    const file = seed(dir);
    const late = path.join(dir, 'late.png');
    fs.writeFileSync(late, PNG);
    let asked = 0;
    const host = hostFor();
    await activate(host, { file, statusFile: path.join(dir, 'appearance.status.json'), pick: async ({ title, initial }) => {
      asked += 1;
      assert.equal(title, '选择文件', 'the dialog is named in the session language, without the ellipsis');
      // The folder of the first listed file that is there (a.png; gone.png is listed before nothing else that exists).
      assert.equal(path.resolve(initial), path.resolve(dir), 'the dialog opens where the listed files are');
      return [late];
    }, open: () => {} });
    const opened = await call(host, 'pick', {});
    assert.equal(opened.ok, true);
    assert.equal(opened.message, '选择文件的窗口已经打开。');
    assert.equal(opened.data.media.length, 3, 'nothing is added before the dialog closes');
    await sleep(20);
    const after = await call(host, 'get', {});
    assert.equal(after.data.media.length, 4);
    assert.deepEqual(after.data.pick, { files: [late], message: '已添加 late.png。' });
    assert.equal((await call(host, 'get', {})).data.pick, null, 'said once');
    assert.equal(asked, 1);
  }));

  it('pick: a dialog that was cancelled, and one that cannot be shown', () => inTempHome(async (dir) => {
    const file = seed(dir);
    const host = hostFor();
    let next = async () => [];
    await activate(host, { file, statusFile: path.join(dir, 'appearance.status.json'), pick: () => next(), open: () => {} });
    await call(host, 'pick', {});
    await sleep(20);
    assert.deepEqual((await call(host, 'get', {})).data.pick, { files: [], message: '没有选择文件。' });
    next = async () => {
      throw new Error('no file dialog on linux');
    };
    await call(host, 'pick', {});
    await sleep(20);
    const failed = (await call(host, 'get', {})).data.pick;
    assert.deepEqual(failed.files, []);
    assert.match(failed.message, /没有成功：no file dialog on linux/);
    assert.equal(failed.error, 'no file dialog on linux');
    assert.ok(host.errors.some((message) => message.includes('file dialog')), 'and it is in the log');
  }));

  it('pick: only one dialog at a time, and none of it after the extension is gone', () => inTempHome(async (dir) => {
    const file = seed(dir);
    const late = path.join(dir, 'late.png');
    fs.writeFileSync(late, PNG);
    const host = hostFor();
    let close;
    const handle = await activate(host, { file, statusFile: path.join(dir, 'appearance.status.json'), pick: () => new Promise((resolve) => {
      close = resolve;
    }), open: () => {} });
    await call(host, 'pick', {});
    const again = await call(host, 'pick', {});
    assert.equal(again.ok, false);
    assert.equal(again.message, '选择文件的窗口已经开着了。');
    handle.dispose();
    close([late]);
    await sleep(20);
    const { data } = await call(host, 'get', {});
    assert.equal(data.media.length, 3, 'a dialog that closes after the extension is gone adds nothing');
    assert.equal(data.pick, null);
  }));

  it('reset: the defaults again, with the files and the launcher setting kept', () => inTempHome(async (dir) => {
    const file = seed(dir);
    const host = hostFor();
    await activate(host, { file, statusFile: path.join(dir, 'appearance.status.json'), pick: async () => [], open: () => {} });
    await call(host, 'set', { mask: 0.1, blur: 9, rotateMinutes: 30, skin: 'catppuccin' });
    const answer = await call(host, 'reset', {});
    assert.equal(answer.ok, true);
    assert.deepEqual(answer.data.background, { enabled: true, scope: 'page', mask: 0.72, blur: 0, rotateMinutes: 0 });
    assert.equal(answer.data.skin.preset, 'default');
    assert.equal(answer.data.media.length, 3);
  }));

  it('openConfig: the file is there, and the system opens it', () => inTempHome(async (dir) => {
    const file = path.join(dir, 'nested', 'appearance.json');
    const opened = [];
    const host = hostFor('en-US');
    await activate(host, { file, statusFile: path.join(dir, 'appearance.status.json'), open: (target) => opened.push(target) });
    const answer = await call(host, 'openConfig', {});
    assert.equal(answer.ok, true);
    assert.equal(answer.message, 'The settings file was opened with its default app.');
    assert.deepEqual(opened, [file]);
    assert.equal(fs.existsSync(file), true, 'created on the way');
  }));

  it('a tool never throws: a broken file is an answer, not a crash', () => inTempHome(async (dir) => {
    const file = seed(dir);
    const host = hostFor('en-US');
    await activate(host, { file, statusFile: path.join(dir, 'appearance.status.json'), pick: async () => [], open: () => {} });
    fs.writeFileSync(file, '{ "background": ');
    for (const [name, args] of [['get', {}], ['set', { mask: 0.5 }], ['add', { paths: [path.join(dir, 'x.png')] }], ['remove', { path: path.join(dir, 'x.png') }], ['reset', {}]]) {
      const answer = await call(host, name, args);
      assert.equal(answer.ok, false, name);
      assert.match(answer.message, /^It did not work: .*not valid JSON/, name);
    }
    assert.ok(host.errors.length >= 5, 'each one is in the log');
  }));

  it('the extension stays usable when the config file does not exist yet', () => inTempHome(async (dir) => {
    const file = path.join(dir, 'appearance.json');
    const host = hostFor();
    await activate(host, { file, statusFile: path.join(dir, 'appearance.status.json'), pick: async () => [], open: () => {} });
    const { data } = await call(host, 'get', {});
    assert.equal(data.background.mask, 0.72);
    assert.deepEqual(data.media, []);
    const after = await call(host, 'set', { mask: 0.3 });
    assert.equal(after.data.background.mask, 0.3);
    assert.equal(fs.existsSync(file), true);
  }));
});

describe('what a view is made of', () => {
  it('the copy is data that can travel, with the interval as a template', () => {
    const zh = viewStrings('zh-CN');
    assert.equal(zh.every, '每 {n} 分钟换下一个');
    assert.equal(zh.never, '不轮换');
    assert.equal(viewStrings('en').every, 'Next one every {n} min');
    assert.equal(viewStrings('zh_TW').title, '外观', 'any Chinese locale gets the Chinese copy');
    assert.equal(viewStrings('').title, 'Appearance', 'no locale is English');
    // What crosses to the page is the copy as JSON: every line a string. (The two lines the
    // extension fills in itself, `added` and `removed`, are functions and do not cross.)
    const sent = JSON.parse(JSON.stringify(zh));
    assert.deepEqual(Object.keys(sent).sort(), Object.keys(zh).filter((name) => typeof zh[name] !== 'function').sort());
    for (const [name, value] of Object.entries(sent)) assert.equal(typeof value, 'string', name);
    assert.equal(typeof zh.added, 'function');
  });

  it('lists the presets with their colours, "default" without', () => {
    const skins = skinList();
    assert.deepEqual(skins[0], { name: 'default', light: null, dark: null });
    assert.deepEqual(Object.keys(skins[1].dark).sort(), ['accent', 'base', 'border', 'surface', 'text']);
  });

  it('says of each file whether it is there', async () => inTempHome(async (dir) => {
    const config = defaultConfig();
    config.background.media = [path.join(dir, 'there.png'), path.join(dir, 'not-there.mp4')];
    assert.deepEqual(await mediaInfo(config, { timeoutMs: PATH_TIMEOUT_MS }), [
      { path: path.join(dir, 'there.png'), name: 'there.png', kind: 'picture', exists: false },
      { path: path.join(dir, 'not-there.mp4'), name: 'not-there.mp4', kind: 'video', exists: false },
    ]);
  }));

  it('viewData carries the defaults and the limits the page builds its controls with', () => {
    const data = viewData(defaultConfig(), { media: [], launcher: { running: true, port: 9337 }, locale: 'en-US', file: 'x.json' });
    assert.deepEqual(data.defaults, { scope: 'page', mask: 0.72, blur: 0, rotateMinutes: 0, preset: 'default' });
    assert.deepEqual(data.limits, { blurMax: 40, maskMax: 1 });
    assert.equal(data.launcher.running, true);
    assert.equal(paths().config.endsWith(path.join('appearance', 'config.json')), true);
  });
});

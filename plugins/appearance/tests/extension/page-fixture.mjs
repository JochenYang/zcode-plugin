// What the view is given when page.test.mjs opens it: every answer its tools give, made by
// running the real extension (bin/extension.mjs) on a directory of its own, so the page is held
// to the shape and the words the extension really sends. The order of the answers is the order
// in which the checks use the tools (page-host.js).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activate } from '../../bin/extension.mjs';
import { saveConfig } from '../../src/config.mjs';
import { viewStrings } from '../../src/extension/describe.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const CLIP = Buffer.from(fs.readFileSync(new URL('../fixtures/tiny.webm.base64', import.meta.url), 'utf8').trim(), 'base64');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A stand-in for the app's tokens: two themes whose contrast is known, so that a page that
// lowered it on its own would show. Only what the host really hands over: its `--color-*`,
// `--font-*` and radius variables (the same stand-in the codegraph view's tests use).
const FONTS = {
  '--font-sans': 'system-ui, sans-serif',
  '--font-mono': 'monospace',
  '--font-text-md-size': '14px',
  '--font-text-sm-size': '12px',
  '--font-heading-xs-size': '14px',
  '--font-heading-sm-size': '16px',
  '--font-heading-md-size': '18px',
  '--border-radius-sm': '4px',
  '--border-radius-md': '6px',
  '--border-radius-lg': '8px',
  '--border-radius-xl': '12px',
};
export const VARIABLES = {
  light: {
    ...FONTS,
    '--color-background-primary': '#ffffff',
    '--color-background-secondary': '#f4f5f7',
    '--color-text-primary': '#111318',
    '--color-text-secondary': '#5b5f66',
    '--color-background-info': '#e5f2ff',
    '--color-text-info': '#175fa8',
    '--color-text-warning': '#b3261e',
    '--color-border-primary': 'rgba(26, 28, 31, 0.14)',
    '--color-border-secondary': 'rgba(26, 28, 31, 0.08)',
  },
  dark: {
    ...FONTS,
    '--color-background-primary': '#191919',
    '--color-background-secondary': '#2d2d2d',
    '--color-text-primary': '#f2f2f2',
    '--color-text-secondary': '#b2b6bd',
    '--color-background-info': '#0d273f',
    '--color-text-info': '#83c3ff',
    '--color-text-warning': '#ff8549',
    '--color-border-primary': 'rgba(255, 255, 255, 0.14)',
    '--color-border-secondary': 'rgba(255, 255, 255, 0.08)',
  },
};

// Where a skin of one's own starts before a colour was chosen: the page's own starting values.
export const START = {
  light: { base: '#ffffff', surface: '#ffffff', text: '#1a1c1f', accent: '#339cff', border: '#e4e6e8' },
  dark: { base: '#181818', surface: '#2b2b2b', text: '#ffffff', accent: '#83c3ff', border: '#3a3c3f' },
};

/**
 * `window.__appearanceRun` for a session in `locale` starting from `theme`. The first answer is
 * held back so that the checks can look at the page while it waits.
 */
export async function runFor(locale, theme = 'light', variables = VARIABLES) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appearance-fixture-'));
  try {
    const first = path.join(dir, 'first.png');
    const gone = path.join(dir, 'gone.png');
    const clip = path.join(dir, 'clip.webm');
    const late = path.join(dir, 'late.png');
    const picked = path.join(dir, 'picked.png');
    for (const file of [first, late, picked]) fs.writeFileSync(file, PNG);
    fs.writeFileSync(clip, CLIP);
    const file = path.join(dir, 'appearance.json');
    const config = {
      background: { enabled: true, media: [first, gone, clip], scope: 'page', rotateMinutes: 0, mask: 0.72, blur: 0 },
      skin: { preset: 'default', custom: null },
      launcher: { zcodePath: null, port: 9337 },
    };
    saveConfig(config, { file });

    // The extension as the host starts it, on that directory.
    let tools = null;
    const host = {
      views: { register: (id, definition) => {
        tools = definition.tools;
      } },
      commands: { register() {} },
      log: { error() {} },
      // A call that answers later, as the real host's does.
      env: { get: async () => ({ locale }) },
    };
    await activate(host, { file, statusFile: path.join(dir, 'appearance.status.json'), pick: async () => [picked], open: () => {} });

    const answers = {};
    const record = async (name, args) => {
      const result = await tools[name].run(args);
      (answers[name] ??= []).push(JSON.parse(JSON.stringify(result)));
      return result;
    };
    await record('get', {});
    // A slider: the page folds what is queued while dragging into the one change sent when the
    // control is let go, so a drag sends once.
    await record('set', { mask: 0.5 });
    await record('set', { blur: 4 });
    await record('set', { rotateMinutes: 30 });
    await record('add', { paths: [late] });
    await record('pick', {});
    await sleep(20);
    await record('get', {}); // the poll that finds what the dialog gave
    await record('remove', { path: gone });
    await record('set', { enabled: false });
    await record('set', { scope: 'chat' });
    await record('set', { skin: 'midnight' });
    await record('set', { skin: 'default', customSkin: START });
    await record('set', { skin: 'default', customSkin: { ...START, light: { ...START.light, accent: '#ff0000' } } });
    await record('openConfig', {});
    await record('get', {}); // the way back from a failed call
    await record('reset', {});

    const copy = viewStrings(locale);
    return {
      answers,
      variables,
      theme,
      otherTheme: theme === 'light' ? 'dark' : 'light',
      locale,
      lang: locale.startsWith('zh') ? 'zh-CN' : 'en',
      keys: { first, gone, clip, late, picked },
      // Where a skin of one's own starts (the page's own starting values).
      start: START,
      holdFirst: true,
      // The page's own words for the states before and without an answer.
      expect: {
        failed: copy.failed,
        loading: locale.startsWith('zh') ? '正在读取设置…' : 'Reading the settings…',
      },
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

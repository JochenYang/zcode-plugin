// What the storage view is given when page.test.mjs opens it: the store as `listIndexes` would
// report it, the answers its tools give (made with the real `viewData`, so the page is held to
// the shape the extension really sends), and a stand-in for the app's theme tokens.
import { viewData, viewStrings } from '../../src/extension/describe.mjs';

const NOW = Date.UTC(2026, 10, 24, 12);
const DAY = 86_400_000;
const MB = 1024 * 1024;
// Index keys are 16 hexadecimal characters, the way `projectKey` writes them.
export const KEYS = {
  current: 'aaaaaaaaaaaaaaaa',
  busy: 'bbbbbbbbbbbbbbbb',
  due: 'cccccccccccccccc',
  victim: 'dddddddddddddddd',
  broken: 'eeeeeeeeeeeeeeee',
  gone: 'ffffffffffffffff',
  keyOnly: '0123456789abcdef',
  long: '1234567890abcdef',
};
const entry = (key, extra = {}) => ({
  key,
  dir: `store/${key}`,
  root: `D:/codes/${key.slice(0, 4)}-project`,
  state: 'ready',
  files: 120,
  filesDone: 120,
  symbols: 300,
  bytes: 2 * MB,
  lastUsedAt: NOW - 3600_000,
  inUse: false,
  orphan: false,
  ...extra,
});
const ENTRIES = [
  entry(KEYS.current),
  entry(KEYS.busy, { state: 'building', files: 700, filesDone: 300, inUse: true }),
  entry(KEYS.due, { lastUsedAt: NOW - 200 * DAY }),
  entry(KEYS.victim),
  entry(KEYS.broken, { state: 'error' }),
  entry(KEYS.gone, { orphan: true, lastUsedAt: NOW - 300 * DAY }),
  entry(KEYS.keyOnly, { root: null, lastUsedAt: 0 }),
  entry(KEYS.long, { root: `D:/codes/${'a-repository-with-a-long-name/'.repeat(6)}` }),
];
const POLICY = { maxIdleDays: 90, maxTotalMB: 2048, fixedByFile: { maxIdleDays: false, maxTotalMB: false } };
const DUE = [ENTRIES[2], ENTRIES[5]];
const without = (keys) => ENTRIES.filter((item) => !keys.includes(item.key));
const view = (locale, entries = ENTRIES, config = POLICY, due = DUE) =>
  viewData(entries, config, { current: [KEYS.current], locale, now: NOW, storeDir: 'C:/Users/me/.zcode/indexes', due });

// A stand-in for the app's tokens: two themes whose contrast is known, so that a page that
// lowered it on its own would show. Only what the host really hands over: its `--color-*`,
// `--font-*` and radius variables. The component tokens (`--gen-ui-*`) do not survive the
// host's schema, so the contract falls back to its own card, primary and input colours.
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

// One answer per call, in the order the checks make them; the last one repeats.
function answers(locale) {
  const t = viewStrings(locale);
  const full = view(locale);
  const pathOf = (key) => full.rows.find((item) => item.key === key).path;
  const sizeOf = (keys) => viewData(ENTRIES.filter((item) => keys.includes(item.key)), {}, { locale }).totals.size;
  const cleaned = without([KEYS.due, KEYS.gone]);
  const listed = (data) => ({ ok: true, data });
  const fileFixed = { ...POLICY, fixedByFile: { maxIdleDays: true, maxTotalMB: false } };
  return {
    // After the policy step: the store as the file fixed it, then the same without the index a
    // stale answer leaves unlisted, then an empty store.
    list: [listed(full), listed(full), listed(view(locale, ENTRIES, fileFixed)), listed(view(locale, without([KEYS.victim]), fileFixed)), listed(view(locale, [], POLICY, []))],
    remove: [
      { ok: true, message: t.removed(pathOf(KEYS.victim), sizeOf([KEYS.victim])), data: view(locale, without([KEYS.victim])) },
      { ok: false, message: t.kept(pathOf(KEYS.keyOnly), t.blocked['in-use']), data: full },
      // Removed, but the store could not be read again: no `data` comes along.
      { ok: true, message: t.removed(pathOf(KEYS.victim), sizeOf([KEYS.victim])) },
    ],
    clean: [{ ok: true, message: t.removedN(DUE.length, sizeOf([KEYS.due, KEYS.gone])), data: view(locale, cleaned, POLICY, []) }],
    policy: [{ ok: true, message: t.saved, data: view(locale, cleaned, { ...POLICY, maxIdleDays: 30 }, []) }],
  };
}

/**
 * `window.__codegraphRun` for a session in `locale` starting from `theme`. The first answer is
 * held back so that the checks can look at the page while it waits.
 */
export const runFor = (locale, lang, theme = 'light', variables = VARIABLES) => ({
  answers: answers(locale),
  variables,
  theme,
  otherTheme: theme === 'light' ? 'dark' : 'light',
  locale,
  lang,
  keys: KEYS,
  holdFirst: true,
  // The page's own words for the states before and without an answer.
  expect: {
    failed: viewStrings(locale).failed(''),
    loading: locale.startsWith('zh') ? '正在读取索引目录…' : 'Reading the index store…',
  },
});

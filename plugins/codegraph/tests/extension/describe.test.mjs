// What the extension says about an index (src/extension/describe.mjs): the composer status slot
// and the data the storage view renders. Pure functions, so the cases are plain data.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SLOT_TEXT_LIMIT, SLOT_TOOLTIP_LIMIT, ageLabel, compact, slotFor, viewData } from '../../src/extension/describe.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const lines = (slot) => slot.tooltip.split('\n');

describe('slotFor', () => {
  test('ready: file count as text, the details as a tooltip, in the session language', () => {
    const ready = { state: 'ready', filesTotal: 291, filesDone: 291, symbols: 2748, stale: 0, indexedAt: NOW - 2 * MINUTE };
    const zh = slotFor(ready, { locale: 'zh-CN', now: NOW, root: 'D:/codes/coding-usage', bytes: 8_000_000 });
    assert.equal(zh.visible, true);
    assert.equal(zh.text, '291 个文件');
    assert.deepEqual(lines(zh), ['代码图谱索引', 'D:/codes/coding-usage', '291 个文件 · 2748 个符号 · 7.6 MB · 2 分钟前', '点击管理本机上的索引']);
    const en = slotFor(ready, { locale: 'en-US', now: NOW, root: 'D:/codes/coding-usage', bytes: 8_000_000 });
    assert.equal(en.text, '291 files');
    assert.deepEqual(lines(en), ['Code graph index', 'D:/codes/coding-usage', '291 files · 2748 symbols · 7.6 MB · 2m ago', 'Click to manage the indexes on this machine']);
    // Stale files are the one thing the model should know before trusting the graph.
    assert.match(slotFor({ ...ready, stale: 3 }, { locale: 'en', now: NOW }).tooltip, / · 3 file\(s\) changed since the index\n/);
  });

  test('building: the percentage, and how far it got', () => {
    const slot = slotFor({ state: 'building', filesTotal: 700, filesDone: 300 }, { locale: 'en', now: NOW, root: 'D:/p' });
    assert.equal(slot.text, '42%');
    assert.deepEqual(lines(slot), ['Code graph index', 'D:/p', 'Indexing 300 of 700 files; results are partial until it is ready', 'Click to manage the indexes on this machine']);
    assert.equal(slotFor({ state: 'building', filesTotal: 0, filesDone: 0 }, { locale: 'zh' }).text, '0%');
    assert.equal(slotFor({ state: 'building', filesTotal: 10, filesDone: 15 }, { locale: 'en' }).text, '100%', 'never above 100');
  });

  test('switched off by the project: said in so many words; otherwise a missing or empty index stays hidden', () => {
    const off = slotFor(null, { projectOff: true, locale: 'zh-CN', root: 'D:/p' });
    assert.equal(off.text, '未开启');
    assert.deepEqual(lines(off), ['代码图谱索引', 'D:/p', '这个项目关闭了索引（.zcode/codegraph.json）', '点击管理本机上的索引']);
    assert.equal(slotFor({ state: 'empty' }, { projectOff: true, locale: 'en' }).text, 'off');
    assert.deepEqual(slotFor(null, { locale: 'en' }), { visible: false });
    assert.deepEqual(slotFor({ state: 'empty', reason: 'below-min-files' }, { locale: 'en' }), { visible: false });
    assert.deepEqual(slotFor(undefined, { locale: 'en' }), { visible: false });
  });

  test('error: named, on one line, with a fallback when the indexer said nothing', () => {
    assert.deepEqual(lines(slotFor({ state: 'error', error: 'boom\nboom' }, { locale: 'en' })), ['Code graph index', 'Index error: boom boom', 'Click to manage the indexes on this machine']);
    assert.match(slotFor({ state: 'error', error: null }, { locale: 'en' }).tooltip, /Index error: unknown error/);
  });

  test('within the limits of the host: 40 characters of text, 200 of tooltip, however long the path', () => {
    const ready = { state: 'ready', filesTotal: 999_999_999, filesDone: 1, symbols: 1, stale: 0, indexedAt: NOW };
    const slot = slotFor(ready, { locale: 'en', now: NOW, root: `D:/${'very-long-segment/'.repeat(20)}`, bytes: Number.MAX_SAFE_INTEGER });
    assert.ok(slot.text.length <= SLOT_TEXT_LIMIT);
    assert.ok(slot.tooltip.length <= SLOT_TOOLTIP_LIMIT, `${slot.tooltip.length}`);
    assert.ok(slot.tooltip.endsWith('…'));
  });
});

describe('compact', () => {
  test('counts under a thousand stay, then one decimal of k, then whole k', () => {
    assert.deepEqual([0, 291, 999, 1000, 1234, 1780, 17830, 999999].map(compact), ['0', '291', '999', '1k', '1.2k', '1.8k', '18k', '1000k']);
    assert.equal(compact(-5), '0');
    assert.equal(compact('x'), '0');
  });
});

describe('ageLabel', () => {
  test('the interface speaks the user\'s language, in the units people read', () => {
    const at = (seconds) => ageLabel(NOW - seconds * 1000, NOW, 'zh-CN');
    assert.deepEqual([0, 59, 60, 300, 3599, 3600, 86_400, 3 * 86_400].map(at), ['刚刚', '刚刚', '1 分钟前', '5 分钟前', '59 分钟前', '1 小时前', '1 天前', '3 天前']);
    assert.deepEqual([0, 60, 3600, 86_400].map((s) => ageLabel(NOW - s * 1000, NOW, 'en-US')), ['just now', '1m ago', '1h ago', '1d ago']);
    assert.equal(ageLabel(NOW + 5000, NOW, 'en'), 'just now', 'a clock that is a little ahead is not the future');
  });
});

describe('viewData', () => {
  const entry = (key, extra = {}) => ({
    key,
    dir: `store/${key}`,
    root: `D:/codes/${key}`,
    state: 'ready',
    files: 10,
    filesDone: 10,
    symbols: 20,
    bytes: 2 * 1024 * 1024,
    lastUsedAt: NOW - 2 * HOUR,
    inUse: false,
    orphan: false,
    ...extra,
  });

  test('one object in the session language: rows, totals, policy and every line of copy the page shows', () => {
    const unused = entry('cccccccccccccccc', { lastUsedAt: 0 });
    const data = viewData(
      [
        entry('aaaaaaaaaaaaaaaa', { state: 'building', files: 700, filesDone: 300 }),
        entry('bbbbbbbbbbbbbbbb', { inUse: true, orphan: true }),
        unused,
        entry('dddddddddddddddd', { state: 'weird' }),
      ],
      { maxIdleDays: 90, maxTotalMB: 2048 },
      { current: ['aaaaaaaaaaaaaaaa'], locale: 'zh-CN', now: NOW, storeDir: 'C:\\Users\\me\\.zcode\\indexes', due: [unused] },
    );
    assert.equal(data.locale, 'zh');
    assert.equal(data.storeDir, 'C:/Users/me/.zcode/indexes');
    assert.deepEqual(data.totals, { projects: 4, size: '8.0 MB', due: 1, dueSize: '2.0 MB' });
    assert.deepEqual(data.policy, { maxIdleDays: 90, maxTotalMB: 2048, fixedByFile: { maxIdleDays: false, maxTotalMB: false } });
    assert.deepEqual(data.rows, [
      { key: 'aaaaaaaaaaaaaaaa', path: 'D:/codes/aaaaaaaaaaaaaaaa', state: 'building', stateLabel: '构建中 42%', files: 700, filesText: '700 个文件', size: '2.0 MB', used: '2 小时前', notes: ['打开着的会话'], removable: false, due: false, blocked: 'current' },
      { key: 'bbbbbbbbbbbbbbbb', path: 'D:/codes/bbbbbbbbbbbbbbbb', state: 'ready', stateLabel: '就绪', files: 10, filesText: '10 个文件', size: '2.0 MB', used: '2 小时前', notes: ['项目目录不存在', '使用中'], removable: false, due: false, blocked: 'in-use' },
      { key: 'cccccccccccccccc', path: 'D:/codes/cccccccccccccccc', state: 'ready', stateLabel: '就绪', files: 10, filesText: '10 个文件', size: '2.0 MB', used: '从未使用', notes: ['已到期，清理时会删除'], removable: true, due: true, blocked: null },
      { key: 'dddddddddddddddd', path: 'D:/codes/dddddddddddddddd', state: 'unknown', stateLabel: '未知', files: 10, filesText: '10 个文件', size: '2.0 MB', used: '2 小时前', notes: [], removable: true, due: false, blocked: null },
    ]);
    assert.equal(data.text.title, '代码图谱索引');
    assert.equal(data.text.total, '4 个项目 · 共 8.0 MB');
    assert.equal(data.text.due, '1 个索引到期（2.0 MB）');
    assert.deepEqual(Object.keys(data.text.columns), ['project', 'state', 'size', 'used', 'actions']);
    assert.ok(data.text.blocked.current && data.text.blocked['in-use'] && data.text.confirmHint && data.text.confirmClean);
    assert.ok(['storeLabel', 'refresh', 'policyHeading', 'dueNote', 'save', 'empty'].every((key) => data.text[key]), 'the page needs no copy of its own');
    // The host serialises this object for the page: a function in it would be lost on the way.
    assert.deepEqual(JSON.parse(JSON.stringify(data)), data);
  });

  test('English, singular and plural, an index without a status file, and an empty store', () => {
    const lone = entry('aaaaaaaaaaaaaaaa', { root: null, lastUsedAt: NOW - 5 * MINUTE });
    const data = viewData([lone], {}, { locale: 'en-US', now: NOW, due: [lone] });
    assert.equal(data.locale, 'en');
    assert.equal(data.rows[0].path, 'aaaaaaaaaaaaaaaa', 'listed by its key when the status file is gone');
    assert.equal(data.rows[0].used, '5m ago');
    assert.deepEqual([data.rows[0].due, data.rows[0].notes, data.rows[0].filesText], [true, ['Due: "Clean what is due" removes it'], '10 files']);
    assert.equal(viewData([entry('0000000000000000', { files: 0 })], {}, { locale: 'en-US' }).rows[0].filesText, '', 'no file count for an index without a status file');
    assert.deepEqual(
      viewData([entry('ffffffffffffffff', { state: 'constructor' })], {}, { locale: 'en-US' }).rows.map((row) => [row.state, row.stateLabel]),
      [['unknown', 'Unknown']],
      'a status file naming something that is no state of ours',
    );
    assert.equal(data.text.total, '1 project · 2.0 MB in all');
    const empty = viewData([], { maxIdleDays: 0 }, { locale: 'en-US', now: NOW, storeDir: null });
    assert.deepEqual(empty.totals, { projects: 0, size: '0 KB', due: 0, dueSize: '0 KB' });
    assert.equal(empty.storeDir, null);
    assert.deepEqual(empty.policy, { maxIdleDays: 0, maxTotalMB: 0, fixedByFile: { maxIdleDays: false, maxTotalMB: false } });
    assert.match(empty.text.empty, /No index on this machine yet/);
  });
});

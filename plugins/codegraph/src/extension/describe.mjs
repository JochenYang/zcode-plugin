// What the extension says about an index: the composer status slot, and the data the storage
// view renders. Pure — the status, the configuration and the locale come in, nothing is read
// here, so every state can be tested without a host. The view itself only lays the result out
// with ZCode's own utilities (ui/index.html, ui/design-system-zcode.md).

import path from 'node:path';
import { sizeText } from '../render/text.mjs';

// The host caps a slot's text and tooltip; a longer value is refused.
export const SLOT_TEXT_LIMIT = 40;
export const SLOT_TOOLTIP_LIMIT = 200;

const TEXT = {
  en: {
    files: (count) => `${count} files`,
    symbols: (count) => `${count} symbols`,
    off: 'off',
    error: 'error',
    title: 'Code graph index',
    indexing: (done, total) => `Indexing ${done} of ${total} files; results are partial until it is ready`,
    offDetail: 'Indexing is off for this project (.zcode/codegraph.json)',
    errorDetail: (message) => `Index error: ${message}`,
    stale: (count) => `${count} file(s) changed since the index`,
    manage: 'Click to manage the indexes on this machine',
    state: { ready: 'Ready', building: 'Building', empty: 'Not indexed', error: 'Error', unknown: 'Unknown' },
    never: 'never used',
    folderMissing: 'project folder missing',
    inUse: 'in use',
    // The view is app-wide: "open" means some session has this project open.
    current: 'an open session',
  },
  zh: {
    files: (count) => `${count} 个文件`,
    symbols: (count) => `${count} 个符号`,
    off: '未开启',
    error: '出错',
    title: '代码图谱索引',
    indexing: (done, total) => `正在索引 ${done} / ${total} 个文件，建完之前结果是部分的`,
    offDetail: '这个项目关闭了索引（.zcode/codegraph.json）',
    errorDetail: (message) => `索引出错：${message}`,
    stale: (count) => `${count} 个文件在索引之后改过`,
    manage: '点击管理本机上的索引',
    state: { ready: '就绪', building: '构建中', empty: '未索引', error: '出错', unknown: '未知' },
    never: '从未使用',
    folderMissing: '项目目录不存在',
    inUse: '使用中',
    // 面板是应用级的：这里的「打开」指有会话打开着这个项目。
    current: '打开着的会话',
  },
};

const VIEW_TEXT = {
  en: {
    columns: { project: 'Project', state: 'State', size: 'Size', used: 'Last used', actions: 'Actions' },
    total: (projects, size) => `${projects} ${projects === 1 ? 'project' : 'projects'} · ${size} in all`,
    storeLabel: 'Index store',
    blocked: {
      current: 'The project of an open session. Its index goes with clean=current from that session.',
      'in-use': 'Another session is writing it right now.',
    },
    delete: 'Delete',
    confirmDelete: 'Confirm delete',
    cancel: 'Cancel',
    confirmHint: 'It is rebuilt the next time the project is opened.',
    clean: 'Clean what is due',
    confirmClean: 'Confirm clean',
    due: (count, size) => `${count} ${count === 1 ? 'index is' : 'indexes are'} due (${size})`,
    dueNote: 'Due: "Clean what is due" removes it',
    policyHeading: 'Cleanup policy',
    idleLabel: 'Delete an index after this many idle days (0 keeps every index)',
    quotaLabel: 'Total size limit in MB (0 = no limit)',
    fixedByFile: 'Set by codegraph.json; change it there.',
    refresh: 'Refresh',
    keptBusy: 'it could not be removed right now (a file is in use or the filesystem refused); try again later',
    noKey: 'the index was not named',
    unknownKey: 'there is no such index on this machine',
    save: 'Save',
    empty: 'No index on this machine yet. A project is indexed when a session opens it.',
    nothingDue: 'Nothing is due.',
    removed: (project, size) => `Removed the index of ${project}, ${size} freed.`,
    removedN: (count, size) => `Removed ${count} ${count === 1 ? 'index' : 'indexes'}, ${size} freed.`,
    kept: (project, reason) => `The index of ${project} was kept: ${reason}`,
    saved: 'Saved. It applies the next time a session opens.',
    failed: (message) => `It did not work: ${message}`,
  },
  zh: {
    columns: { project: '项目', state: '状态', size: '大小', used: '上次使用', actions: '操作' },
    total: (projects, size) => `${projects} 个项目 · 共 ${size}`,
    storeLabel: '索引目录',
    blocked: {
      current: '这是打开着的会话的项目；要删它的索引，在那个会话里用 clean=current。',
      'in-use': '另一个会话正在写入它。',
    },
    delete: '删除',
    confirmDelete: '确认删除',
    cancel: '取消',
    confirmHint: '删除后，下次打开该项目时会重建。',
    clean: '清理到期索引',
    confirmClean: '确认清理',
    due: (count, size) => `${count} 个索引到期（${size}）`,
    dueNote: '已到期，清理时会删除',
    policyHeading: '清理策略',
    idleLabel: '闲置多少天后删除（0 表示一直保留）',
    quotaLabel: '总量上限，MB（0 表示不限）',
    fixedByFile: '由 codegraph.json 设定，要改就改那个文件。',
    refresh: '刷新',
    keptBusy: '现在删不掉（文件被占用或文件系统拒绝），稍后再试',
    noKey: '没有指定要删的索引',
    unknownKey: '本机上没有这个索引',
    save: '保存',
    empty: '本机上还没有任何索引。项目在会话打开时自动建索引。',
    nothingDue: '没有到期的索引。',
    removed: (project, size) => `已删除 ${project} 的索引，释放 ${size}。`,
    removedN: (count, size) => `已删除 ${count} 个索引，释放 ${size}。`,
    kept: (project, reason) => `${project} 的索引没有删除：${reason}`,
    saved: '已保存，下次会话打开时生效。',
    failed: (message) => `没有成功：${message}`,
  },
};

const count = (value) => (Number.isFinite(value) ? Math.trunc(value) : 0);
const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const isZh = (locale) => String(locale || '').toLowerCase().startsWith('zh');

/** Every line of copy the view and its tools show, in the session language. */
export function viewStrings(locale = '') {
  return isZh(locale) ? { ...VIEW_TEXT.zh, title: TEXT.zh.title } : { ...VIEW_TEXT.en, title: TEXT.en.title };
}

/**
 * The store policy in force. The user's file wins; the plugin configuration (`userConfig`,
 * which reaches the server as an environment variable) only fills what the file left unset;
 * then the defaults. `user` values may arrive as strings.
 *
 * @param {{ file?: object, user?: object, defaults?: { maxIdleDays: number, maxTotalMB: number } }} [sources]
 * @returns {{ maxIdleDays: number, maxTotalMB: number, fixedByFile: { maxIdleDays: boolean, maxTotalMB: boolean } }}
 */
export function resolvePolicy({ file = {}, user = {}, defaults = { maxIdleDays: 90, maxTotalMB: 0 } } = {}) {
  const pick = (key) => {
    if (Number.isInteger(file[key]) && file[key] >= 0) return [file[key], true];
    const raw = user[key];
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (Number.isInteger(value) && value >= 0) return [value, false];
    return [Math.max(0, count(defaults[key])), false];
  };
  const [maxIdleDays, fileIdle] = pick('maxIdleDays');
  const [maxTotalMB, fileQuota] = pick('maxTotalMB');
  return { maxIdleDays, maxTotalMB, fixedByFile: { maxIdleDays: fileIdle, maxTotalMB: fileQuota } };
}

/**
 * The composer status slot for the project of one session.
 *
 * @param {object|null} status  the index status (`readStatus`), null without an index
 * @param {{ projectOff?: boolean, locale?: string, now?: number, root?: string|null, bytes?: number }} [options]
 * @returns {{ visible: false }|{ visible: true, text: string, tooltip: string }}
 *   hidden for a project that simply has no index yet: the hooks already tell the model.
 */
export function slotFor(status, { projectOff = false, locale = '', now = Date.now(), root = null, bytes = 0 } = {}) {
  const t = isZh(locale) ? TEXT.zh : TEXT.en;
  const state = status?.state;
  let text;
  let detail;
  if (state === 'ready') {
    text = t.files(compact(status.filesTotal));
    detail = [
      t.files(count(status.filesTotal)),
      t.symbols(count(status.symbols)),
      bytes > 0 ? sizeText(bytes) : null,
      ageLabel(status.indexedAt, now, locale),
      count(status.stale) > 0 ? t.stale(count(status.stale)) : null,
    ]
      .filter(Boolean)
      .join(' · ');
  } else if (state === 'building') {
    const total = count(status.filesTotal);
    text = `${total > 0 ? Math.min(100, Math.floor((count(status.filesDone) / total) * 100)) : 0}%`;
    detail = t.indexing(count(status.filesDone), total);
  } else if (state === 'error') {
    text = t.error;
    detail = t.errorDetail(oneLine(status.error ?? status.reason) || 'unknown error');
  } else if (projectOff) {
    text = t.off;
    detail = t.offDetail;
  } else {
    return { visible: false };
  }
  const tooltip = [t.title, root, detail, t.manage].filter(Boolean).join('\n');
  return { visible: true, text, tooltip: clipEnd(tooltip, SLOT_TOOLTIP_LIMIT) };
}

// 291 stays 291; 1,234 becomes 1.2k and 17,830 becomes 18k: the slot has room for 40 characters.
export function compact(value) {
  const n = Math.max(0, count(value));
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(n / 1000)}k`;
}

function clipEnd(text, limit) {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

// The tool output has its own age format and it is English only; the interface speaks the
// user's language: "just now", "5m ago", "2h ago", "3d ago" / "刚刚"、"5 分钟前"、"2 小时前"、"3 天前".
export function ageLabel(ms, now, locale = '') {
  const zh = isZh(locale);
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return zh ? '刚刚' : 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return zh ? `${hours} 小时前` : `${hours}h ago`;
  return zh ? `${Math.floor(hours / 24)} 天前` : `${Math.floor(hours / 24)}d ago`;
}

const percent = (entry) => (entry.state === 'building' && entry.files > 0 ? Math.min(100, Math.floor((count(entry.filesDone) / entry.files) * 100)) : null);

/**
 * Everything the storage view shows, already in the user's language. One object, so the page
 * holds no copy of its own and nothing is formatted twice.
 *
 * @param {object[]} entries  `listIndexes()`
 * @param {{ maxIdleDays?: number, maxTotalMB?: number }} config
 * @param {{ current?: string[], locale?: string, now?: number, storeDir?: string|null, due?: object[] }} [options]
 *   `current` lists the project keys of the sessions that are open; `due` is what
 *   `planSweep` would remove, for the "clean what is due" action
 */
export function viewData(entries, config, { current = [], locale = '', now = Date.now(), storeDir = null, due = [] } = {}) {
  const zh = isZh(locale);
  const t = zh ? TEXT.zh : TEXT.en;
  const v = zh ? VIEW_TEXT.zh : VIEW_TEXT.en;
  const open = new Set(current);
  const dueKeys = new Set(due.map((entry) => entry.key));
  const sum = (list) => sizeText(list.reduce((total, entry) => total + count(entry.bytes), 0));
  const rows = entries.map((entry) => {
    // `hasOwn`: a status file that says "constructor" names no state.
    const state = Object.hasOwn(t.state, entry.state) ? entry.state : 'unknown';
    const blocked = open.has(entry.key) ? 'current' : entry.inUse ? 'in-use' : null;
    return {
      key: entry.key,
      path: entry.root ?? entry.key,
      state,
      stateLabel: `${t.state[state]}${percent(entry) === null ? '' : ` ${percent(entry)}%`}`,
      files: count(entry.files),
      filesText: entry.files > 0 ? t.files(count(entry.files)) : '',
      size: sizeText(entry.bytes),
      used: entry.lastUsedAt > 0 ? ageLabel(entry.lastUsedAt, now, locale) : t.never,
      notes: [entry.orphan ? t.folderMissing : null, entry.inUse ? t.inUse : null, blocked === 'current' ? t.current : null, dueKeys.has(entry.key) ? v.dueNote : null].filter(Boolean),
      // `removable` is what the extension will allow: an open session's project and an index in
      // use are refused; `due` only says that "clean what is due" would take it.
      removable: blocked === null,
      due: dueKeys.has(entry.key),
      blocked,
    };
  });
  // The host serialises this object for the page, so it holds no function: the lines that
  // depend on the numbers are made here, as strings.
  const { total, due: dueLine, removed, removedN, kept, failed, ...copy } = v;
  return {
    locale: zh ? 'zh' : 'en',
    storeDir: storeDir ? String(storeDir).split(path.sep).join('/') : null,
    totals: { projects: rows.length, size: sum(entries), due: due.length, dueSize: sum(due) },
    policy: {
      maxIdleDays: count(config.maxIdleDays),
      maxTotalMB: count(config.maxTotalMB),
      // A limit the user's file fixed cannot be changed from the view: the page says so.
      fixedByFile: { maxIdleDays: config.fixedByFile?.maxIdleDays === true, maxTotalMB: config.fixedByFile?.maxTotalMB === true },
    },
    rows,
    text: { ...copy, title: t.title, total: total(rows.length, sum(entries)), due: dueLine(due.length, sum(due)) },
  };
}

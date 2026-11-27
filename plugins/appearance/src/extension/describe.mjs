// What the side-pane view is given (viewData) and what it says (viewStrings). The view decides
// nothing on its own: every line of its copy and every value it shows come from here, so the
// page holds no rules about the config, and a change to them is a change in one place.
import fs from 'node:fs';
import path from 'node:path';
import { BLUR_MAX, MASK_MAX, defaultConfig, mediaKind } from '../config.mjs';
import { SKINS } from '../skins.mjs';

const isZh = (locale) => String(locale || '').toLowerCase().startsWith('zh');
// How long a media path gets to answer before it is listed as not found.
export const PATH_TIMEOUT_MS = 1500;

// The copy is data: every line is a string, and `{n}` in one is filled in by whoever shows it.
const COPY = {
  zh: {
    title: '外观',
    subtitle: '背景、遮罩和配色皮肤。改动即时生效，不用保存。',
    loading: '正在读取设置…',
    noHost: '这个页面要在 ZCode 里面打开。',
    failed: '没有成功：',
    backgroundHeading: '背景',
    show: '显示背景',
    scope: '范围',
    page: '整页',
    chat: '只换会话区',
    scopeHint: '整页：图铺在整个窗口后面。只换会话区：图画在会话区里，其余保持原样。',
    videoScope: '视频只能铺整页。',
    mediaHeading: '图片和视频',
    mediaHint: '可以放多个；设置了轮换间隔就按顺序轮着来。',
    mediaEmpty: '还没有添加。在下面填一个路径，或者从文件里选。',
    pathPlaceholder: '图片或视频的路径',
    add: '添加',
    pick: '选择文件…',
    picking: '选择文件的窗口已经打开。',
    remove: '移除',
    current: '当前',
    missing: '找不到这个文件',
    picture: '图片',
    video: '视频',
    mask: '遮罩',
    maskHint: '压在背景上的主题色。越大文字越清楚，越小背景越明显。',
    blur: '模糊',
    rotate: '轮换',
    every: '每 {n} 分钟换下一个',
    never: '不轮换',
    minutesField: '轮换间隔（分钟）',
    skinHeading: '配色皮肤',
    skinHint: '替换界面的底色、卡片、文字、强调色和边框；浅色、深色主题各一套。',
    defaultSkin: '默认',
    custom: '自定义',
    light: '浅色主题',
    dark: '深色主题',
    base: '底色',
    surface: '卡片',
    text: '文字',
    accent: '强调色',
    border: '边框',
    reset: '恢复默认设置',
    resetConfirm: '恢复默认？遮罩、模糊、轮换和皮肤会回到初始值，图片和视频会保留。',
    cancel: '取消',
    confirmReset: '恢复',
    openConfig: '打开配置文件',
    launcherOn: '启动器在运行，改动马上生效。',
    launcherOff: '启动器没有在运行：改动已经保存，下次从启动器启动 ZCode 时生效。',
    saved: '已保存。',
    added: (files) => (files.length === 1 ? `已添加 ${path.basename(files[0])}。` : `已添加 ${files.length} 个文件。`),
    removed: (name) => `已移除 ${name}。`,
    pickNone: '没有选择文件。',
    pickUnsupported: '这个系统上还不能在这里选文件，请把路径填进去。',
    resetDone: '已恢复默认设置。',
    notFound: '这个文件不是图片或视频，或者找不到：',
    needFullPath: '请写完整的路径（从盘符或 ~ 开始）：',
    alreadyPicking: '选择文件的窗口已经开着了。',
    opened: '已用系统默认程序打开配置文件。',
  },
  en: {
    title: 'Appearance',
    subtitle: 'Background, tint and colour skin. Every change applies at once; there is nothing to save.',
    loading: 'Reading the settings…',
    noHost: 'This page runs inside ZCode.',
    failed: 'It did not work: ',
    backgroundHeading: 'Background',
    show: 'Show the background',
    scope: 'Where',
    page: 'Whole window',
    chat: 'Conversation only',
    scopeHint: 'Whole window: the picture sits behind everything. Conversation only: it is painted into the conversation area and the rest stays as it is.',
    videoScope: 'A video can only fill the whole window.',
    mediaHeading: 'Pictures and videos',
    mediaHint: 'More than one is fine; with a rotation interval they take turns.',
    mediaEmpty: 'Nothing yet. Type a path below, or pick a file.',
    pathPlaceholder: 'Path of a picture or a video',
    add: 'Add',
    pick: 'Choose files…',
    picking: 'The file dialog is open.',
    remove: 'Remove',
    current: 'Current',
    missing: 'This file cannot be found',
    picture: 'Picture',
    video: 'Video',
    mask: 'Tint',
    maskHint: 'Theme colour laid over the background. Higher is easier to read, lower shows more of the background.',
    blur: 'Blur',
    rotate: 'Rotate',
    every: 'Next one every {n} min',
    never: 'No rotation',
    minutesField: 'Rotation interval (minutes)',
    skinHeading: 'Colour skin',
    skinHint: 'Replaces the base, card, text, accent and border colours, one set for the light and one for the dark theme.',
    defaultSkin: 'Default',
    custom: 'Custom',
    light: 'Light theme',
    dark: 'Dark theme',
    base: 'Base',
    surface: 'Cards',
    text: 'Text',
    accent: 'Accent',
    border: 'Border',
    reset: 'Restore defaults',
    resetConfirm: 'Restore the defaults? Tint, blur, rotation and skin go back to their first values; pictures and videos stay.',
    cancel: 'Cancel',
    confirmReset: 'Restore',
    openConfig: 'Open the settings file',
    launcherOn: 'The launcher is running: changes apply at once.',
    launcherOff: 'The launcher is not running: the change is saved and shows the next time ZCode is started from the launcher.',
    saved: 'Saved.',
    added: (files) => (files.length === 1 ? `Added ${path.basename(files[0])}.` : `Added ${files.length} files.`),
    removed: (name) => `Removed ${name}.`,
    pickNone: 'No file was chosen.',
    pickUnsupported: 'Choosing a file here does not work on this system yet; type the path instead.',
    resetDone: 'Back to the defaults.',
    notFound: 'Not a picture or a video, or not found: ',
    needFullPath: 'Type the whole path (from the drive letter, or ~): ',
    alreadyPicking: 'The file dialog is already open.',
    opened: 'The settings file was opened with its default app.',
  },
};

/** Every line the view can say, in the session's language. Plain data: it crosses to the page as JSON. */
export function viewStrings(locale) {
  return { ...(isZh(locale) ? COPY.zh : COPY.en) };
}

// A path may be on a share that is away right now: each one is asked with a timeout, and one
// that did not answer is listed as not found rather than holding the view back.
async function statWithTimeout(target, timeoutMs) {
  let timer;
  const answer = await Promise.race([
    fs.promises.stat(target).then(() => true, () => false),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  return answer;
}

/** The background files as the view lists them: name, kind, and whether the file is there. */
export async function mediaInfo(config, { timeoutMs = PATH_TIMEOUT_MS } = {}) {
  const answers = await Promise.all(config.background.media.map((file) => statWithTimeout(file, timeoutMs)));
  return config.background.media.map((file, index) => ({ path: file, name: path.basename(file), kind: mediaKind(file), exists: answers[index] }));
}

/** The presets as the view shows them; "default" carries no colours of its own. */
export function skinList() {
  return Object.entries(SKINS).map(([name, colours]) => ({ name, light: colours?.light ?? null, dark: colours?.dark ?? null }));
}

/**
 * Everything one answer to the view carries.
 *
 * @param {object} config  as `loadConfig` validates it
 * @param {{ media: object[], launcher: { running: boolean, port: number | null }, locale: string, file: string,
 *           pick?: { files: string[] } | null, defaults?: object }} parts
 */
export function viewData(config, { media, launcher, locale, file, pick = null, defaults = defaultConfig() }) {
  const { background, skin } = config;
  return {
    background: {
      enabled: background.enabled,
      scope: background.scope,
      mask: background.mask,
      blur: background.blur,
      rotateMinutes: background.rotateMinutes,
    },
    skin: { preset: skin.preset, custom: structuredClone(skin.custom) },
    defaults: {
      scope: defaults.background.scope,
      mask: defaults.background.mask,
      blur: defaults.background.blur,
      rotateMinutes: defaults.background.rotateMinutes,
      preset: defaults.skin.preset,
    },
    limits: { blurMax: BLUR_MAX, maskMax: MASK_MAX },
    media,
    skins: skinList(),
    launcher,
    file,
    lang: isZh(locale) ? 'zh-CN' : 'en',
    // The files a finished file dialog gave, once, with what to say about them: the page polls
    // `get` while a dialog is open.
    pick,
    text: viewStrings(locale),
  };
}

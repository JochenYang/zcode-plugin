// The appearance config: defaults, validation, reading, writing and the partial updates the
// tools apply. Everything the launcher and the server know about the config lives here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths } from './paths.mjs';
import { CUSTOM_SKIN, SKIN_PRESETS } from './skins.mjs';

export const SCOPES = Object.freeze(['page', 'chat']);
// A picture becomes part of the <style> element as a data: URL, so the page needs no path
// access; these are the formats Chromium decodes.
export const PICTURE_EXTENSIONS = Object.freeze(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif']);
// A video is played by a <video> element from its file:// URL, never embedded.
export const VIDEO_EXTENSIONS = Object.freeze(['.mp4', '.webm']);
export const MEDIA_EXTENSIONS = Object.freeze([...PICTURE_EXTENSIONS, ...VIDEO_EXTENSIONS]);
// Base64 of a 20 MB picture is a 27 MB stylesheet; a bigger one would be felt, not seen.
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MASK_MIN = 0;
export const MASK_MAX = 1;
export const BLUR_MAX = 40;
// A year of minutes. A longer interval would overflow the timer (2^31-1 ms, about 24 days),
// which turns it into a timer that fires at once, over and over.
export const ROTATE_MAX_MINUTES = 525600;
export const PORT_MIN = 1;
export const PORT_MAX = 65535;
export const DEFAULT_PORT = 9337;

export const DEFAULT_CONFIG = Object.freeze({
  background: Object.freeze({ enabled: true, media: [], scope: 'page', rotateMinutes: 0, mask: 0.72, blur: 0 }),
  skin: Object.freeze({ preset: 'default', custom: null }),
  launcher: Object.freeze({ zcodePath: null, port: DEFAULT_PORT }),
});

export class ConfigError extends Error {
  constructor(message, { file = null, problems = [] } = {}) {
    super(message);
    this.name = 'ConfigError';
    this.file = file;
    this.problems = problems;
  }
}

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

export function mediaKind(file) {
  const extension = path.extname(file).toLowerCase();
  if (PICTURE_EXTENSIONS.includes(extension)) return 'picture';
  if (VIDEO_EXTENSIONS.includes(extension)) return 'video';
  return null;
}

// A path as the user typed it becomes absolute here, so the config keeps meaning the same file
// whichever workspace the tool was called from. `~` is expanded; type and extension are checked.
// A network path is not accepted: reading one makes Windows identify itself to that machine
// (with the user's own credentials), and the tools would repeat it on every rendering of the
// view. A share that is mapped to a drive letter is a local path like any other.
export function normalizeMediaPath(raw, { cwd = process.cwd() } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) throw new ConfigError('a picture or video path must be a non-empty string');
  let text = raw.trim();
  if (/^[\\/]{2}/.test(text)) throw new ConfigError(`${text}: a network path is not accepted (map the share to a drive letter first)`);
  if (text === '~' || text.startsWith('~/') || text.startsWith('~\\')) text = path.join(os.homedir(), text.slice(1));
  const resolved = path.resolve(cwd, text);
  if (/^\\\\/.test(resolved)) throw new ConfigError(`${text}: a network path is not accepted (map the share to a drive letter first)`);
  if (!mediaKind(resolved)) throw new ConfigError(`${resolved}: not a picture or a video (${MEDIA_EXTENSIONS.join(' ')})`);
  return resolved;
}

function checkBackground(raw, problems) {
  if (raw.rotateMinutes !== undefined && !(Number.isInteger(raw.rotateMinutes) && raw.rotateMinutes >= 0 && raw.rotateMinutes <= ROTATE_MAX_MINUTES)) {
    problems.push(`background.rotateMinutes must be an integer from 0 to ${ROTATE_MAX_MINUTES}`);
  }
  if (raw.blur !== undefined && !(Number.isInteger(raw.blur) && raw.blur >= 0 && raw.blur <= BLUR_MAX)) {
    problems.push(`background.blur must be an integer from 0 to ${BLUR_MAX}`);
  }
  if (raw.mask !== undefined && !(typeof raw.mask === 'number' && raw.mask >= MASK_MIN && raw.mask <= MASK_MAX)) {
    problems.push(`background.mask must be a number from ${MASK_MIN} to ${MASK_MAX}`);
  }
  if (raw.scope !== undefined && !SCOPES.includes(raw.scope)) problems.push(`background.scope must be one of ${SCOPES.join(', ')}`);
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') problems.push('background.enabled must be true or false');
  if (raw.media !== undefined) {
    if (!Array.isArray(raw.media) || raw.media.some((entry) => typeof entry !== 'string')) problems.push('background.media must be a list of file paths');
  }
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const COLOR_KEYS = Object.freeze(['base', 'surface', 'text', 'accent', 'border']);

function checkSkinCustom(raw, problems) {
  if (!isPlainObject(raw)) {
    problems.push('skin.custom must be an object with a light and/or a dark set of colours');
    return;
  }
  const modes = Object.keys(raw).filter((mode) => mode !== 'light' && mode !== 'dark');
  if (modes.length) problems.push(`skin.custom: unknown mode ${modes.join(', ')} (light or dark)`);
  if (raw.light === undefined && raw.dark === undefined) problems.push('skin.custom needs a light or a dark set of colours');
  for (const mode of ['light', 'dark']) {
    const set = raw[mode];
    if (set === undefined) continue;
    if (!isPlainObject(set)) {
      problems.push(`skin.custom.${mode} must be an object`);
      continue;
    }
    for (const key of Object.keys(set)) if (!COLOR_KEYS.includes(key)) problems.push(`skin.custom.${mode}: unknown colour ${key}`);
    for (const key of COLOR_KEYS) {
      if (set[key] === undefined) continue;
      if (typeof set[key] !== 'string' || !HEX.test(set[key])) problems.push(`skin.custom.${mode}.${key} must be a hex colour like #1a2b3c`);
    }
  }
}

// Validates a whole config and returns a normalised copy: defaults filled in, paths absolute,
// unknown keys rejected so a typo never silently does nothing.
export function validateConfig(raw, { file = null, cwd = process.cwd() } = {}) {
  const problems = [];
  if (!isPlainObject(raw)) throw new ConfigError('appearance config must be a JSON object', { file, problems: ['the top level is not an object'] });
  for (const key of Object.keys(raw)) if (!(key in DEFAULT_CONFIG)) problems.push(`unknown section ${key}`);

  const backgroundRaw = raw.background ?? {};
  const skinRaw = raw.skin ?? {};
  const launcherRaw = raw.launcher ?? {};
  if (!isPlainObject(backgroundRaw)) problems.push('background must be an object');
  if (!isPlainObject(skinRaw)) problems.push('skin must be an object');
  if (!isPlainObject(launcherRaw)) problems.push('launcher must be an object');
  for (const key of Object.keys(backgroundRaw)) if (!(key in DEFAULT_CONFIG.background)) problems.push(`unknown setting background.${key}`);
  for (const key of Object.keys(skinRaw)) if (!(key in DEFAULT_CONFIG.skin)) problems.push(`unknown setting skin.${key}`);
  for (const key of Object.keys(launcherRaw)) if (!(key in DEFAULT_CONFIG.launcher)) problems.push(`unknown setting launcher.${key}`);
  checkBackground(backgroundRaw, problems);

  if (skinRaw.preset !== undefined && !SKIN_PRESETS.includes(skinRaw.preset)) problems.push(`skin.preset must be one of ${SKIN_PRESETS.join(', ')}`);
  // "custom" shows the colours of skin.custom; without any, there is nothing it could show.
  if (skinRaw.preset === CUSTOM_SKIN && (skinRaw.custom === undefined || skinRaw.custom === null)) problems.push('skin.preset custom needs skin.custom');
  if (skinRaw.custom !== undefined && skinRaw.custom !== null) checkSkinCustom(skinRaw.custom, problems);
  if (launcherRaw.port !== undefined && !(Number.isInteger(launcherRaw.port) && launcherRaw.port >= PORT_MIN && launcherRaw.port <= PORT_MAX)) {
    problems.push(`launcher.port must be an integer from ${PORT_MIN} to ${PORT_MAX}`);
  }
  if (launcherRaw.zcodePath !== undefined && launcherRaw.zcodePath !== null && typeof launcherRaw.zcodePath !== 'string') {
    problems.push('launcher.zcodePath must be a file path or null');
  }

  const media = [];
  if (Array.isArray(backgroundRaw.media)) {
    for (const entry of backgroundRaw.media) {
      try {
        media.push(normalizeMediaPath(entry, { cwd }));
      } catch (err) {
        problems.push(err instanceof ConfigError ? err.message : String(entry));
      }
    }
  }
  if (problems.length) throw new ConfigError(`appearance config is invalid: ${problems[0]}`, { file, problems });

  return {
    background: {
      enabled: backgroundRaw.enabled ?? DEFAULT_CONFIG.background.enabled,
      media,
      scope: backgroundRaw.scope ?? DEFAULT_CONFIG.background.scope,
      rotateMinutes: backgroundRaw.rotateMinutes ?? DEFAULT_CONFIG.background.rotateMinutes,
      mask: backgroundRaw.mask ?? DEFAULT_CONFIG.background.mask,
      blur: backgroundRaw.blur ?? DEFAULT_CONFIG.background.blur,
    },
    skin: {
      preset: skinRaw.preset ?? DEFAULT_CONFIG.skin.preset,
      custom: skinRaw.custom === undefined || skinRaw.custom === null ? null : structuredClone(skinRaw.custom),
    },
    launcher: {
      zcodePath: launcherRaw.zcodePath ?? DEFAULT_CONFIG.launcher.zcodePath,
      port: launcherRaw.port ?? DEFAULT_CONFIG.launcher.port,
    },
  };
}

export function defaultConfig() {
  return validateConfig({});
}

// A missing file means "nothing configured yet"; a file that does not parse or validate is an
// error that names the file, so the launcher keeps its last good config instead of guessing.
export function loadConfig({ file = paths().config, cwd = process.cwd() } = {}) {
  if (!fs.existsSync(file)) return { config: defaultConfig(), file, exists: false };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`${file}: not valid JSON (${err.message})`, { file });
  }
  return { config: validateConfig(raw, { file, cwd }), file, exists: true };
}

export function saveConfig(config, { file = paths().config } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written through a temporary file and renamed, so a reader never sees half a config.
  const text = `${JSON.stringify(config, null, 2)}\n`;
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file);
  return file;
}

// The fields the update tools accept, checked before anything is applied: a wrong key is a
// mistake to report, not something to drop on the floor.
const PATCH_KEYS = Object.freeze(['enabled', 'setMedia', 'addMedia', 'removeMedia', 'scope', 'mask', 'blur', 'rotateMinutes', 'skin', 'customSkin']);

export function applyPatch(config, patch, { cwd = process.cwd() } = {}) {
  if (!isPlainObject(patch)) throw new ConfigError('the update must be an object');
  const problems = [];
  for (const key of Object.keys(patch)) if (!PATCH_KEYS.includes(key)) problems.push(`unknown field ${key} (accepted: ${PATCH_KEYS.join(', ')})`);
  for (const key of ['setMedia', 'addMedia', 'removeMedia']) {
    if (patch[key] !== undefined && !Array.isArray(patch[key])) problems.push(`${key} must be a list`);
  }
  for (const entry of patch.removeMedia ?? []) {
    if (typeof entry !== 'string' && !(Number.isInteger(entry) && entry >= 1)) problems.push('removeMedia takes file paths or 1-based positions');
  }
  if (patch.skin !== undefined && !SKIN_PRESETS.includes(patch.skin)) problems.push(`skin must be one of ${SKIN_PRESETS.join(', ')}`);
  if (problems.length) throw new ConfigError(problems[0]);

  const next = structuredClone(config);
  const background = next.background;
  if (patch.enabled !== undefined) background.enabled = patch.enabled;
  if (patch.scope !== undefined) background.scope = patch.scope;
  if (patch.mask !== undefined) background.mask = patch.mask;
  if (patch.blur !== undefined) background.blur = patch.blur;
  if (patch.rotateMinutes !== undefined) background.rotateMinutes = patch.rotateMinutes;

  if (patch.setMedia !== undefined) background.media = patch.setMedia.map((entry) => normalizeMediaPath(entry, { cwd }));
  if (patch.addMedia !== undefined) {
    for (const entry of patch.addMedia) {
      const resolved = normalizeMediaPath(entry, { cwd });
      if (!background.media.some((existing) => samePath(existing, resolved))) background.media.push(resolved);
    }
  }
  if (patch.removeMedia !== undefined) {
    const gone = new Set(background.media.filter((existing, index) => patch.removeMedia.some((entry) => (
      typeof entry === 'number' ? entry === index + 1 : samePath(existing, normalizeMediaPath(entry, { cwd }))
    ))));
    background.media = background.media.filter((existing) => !gone.has(existing));
  }
  if (patch.customSkin !== undefined) next.skin.custom = patch.customSkin === null ? null : structuredClone(patch.customSkin);
  if (patch.skin !== undefined) next.skin.preset = patch.skin;
  else if (patch.customSkin !== undefined) {
    // Colours of one's own that are given become the skin in use; ones that are cleared take
    // the preset back to the app's own colours. `skin`, when passed, says which it is.
    if (patch.customSkin === null) {
      if (next.skin.preset === CUSTOM_SKIN) next.skin.preset = 'default';
    } else next.skin.preset = CUSTOM_SKIN;
  }

  return validateConfig(next, { cwd });
}

// One entry of a rotating list. One per interval; the list wraps around.
export function mediaAt(config, index) {
  const { media } = config.background;
  if (!media.length) return null;
  const file = media[((index % media.length) + media.length) % media.length];
  return { path: file, kind: mediaKind(file) };
}

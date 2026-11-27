// What ends up inside the ZCode window: a stylesheet built from the config, and the script that
// puts it there.
//
// How the app is built shapes every rule below (read from the shipped bundle, 4.0.10870):
//   - surfaces take their colour from `--color-*` custom properties (`.bg-background` is
//     `background-color: var(--color-background)`), so replacing a few properties restyles
//     everything that reads them;
//   - the light and dark themes are the classes `.theme-zai-light` / `.theme-zai-dark`;
//   - the main window is loaded from a file:// URL inside app.asar (seen on the running app),
//     so the shell carries no CSP of its own and an injected <style> is simply applied. The
//     picture still travels as a data: URL: it needs no path access from the page, and the
//     custom protocol the app uses elsewhere only allows pictures from its own origin or data:;
//   - the conversation area is the element the app marks `data-testid="conversation"`, inside
//     the card that carries `bg-background`; the shell root's own base is `bg-background-win-alt`.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { MAX_IMAGE_BYTES, mediaKind } from './config.mjs';
import { resolveSkin } from './skins.mjs';

export const STYLE_ID = 'zcode-appearance-style';
export const IMAGE_LAYER_ID = 'zcode-appearance-background';
export const TINT_LAYER_ID = 'zcode-appearance-tint';
// `conversation` is the hook of the session view in 4.0.10870 (checked on the running app).
// `chat-view` is the name the app's own Markdown layout code looks up; it is kept as a second
// name in case a build has that one instead.
export const CHAT_ROOT = '[data-testid="conversation"], [data-testid="chat-view"]';
// The shell's entry page mounts the app in #root; the plugin sandboxes and the utility windows
// do not, which is how the injected script tells the main window from everything else.
export const SHELL_ROOT = '#root';
// Read once per theme, while our stylesheet is out of the document, and mixed into the tint.
export const ORIGIN_VARS = Object.freeze(['background', 'surface', 'panel', 'sidebar', 'card', 'popover']);

const THEME_SELECTORS = ':root, .theme-zai-light, .theme-zai-dark';
const MIME = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
});

function backgroundRules(config, { imageDataUrl, videoUrl }) {
  if (!config.background.enabled || !(imageDataUrl || videoUrl)) return [];
  // A video is an element, not a CSS background, so it has no place in the conversation area.
  if (config.background.scope === 'chat' && !imageDataUrl) return [];
  const percent = Math.round(config.background.mask * 100);
  // On <body>, not on the root: the app's colours are read from the body (see install), and a
  // var() is resolved where the custom property is declared, so the root cannot see them.
  const tint = `body { --za-tint: color-mix(in oklab, var(--za-orig-background, var(--za-fallback)) ${percent}%, transparent); }`;
  const fallback = [':root { --za-fallback: #f4f4f5; }', '.theme-zai-dark { --za-fallback: #0a0a0a; }'];
  if (config.background.scope === 'chat') {
    return [
      ...fallback,
      tint,
      `${CHAT_ROOT} {`,
      '  background-color: transparent !important;',
      `  background-image: linear-gradient(var(--za-tint), var(--za-tint)), url("${imageDataUrl}");`,
      '  background-position: center, center;',
      '  background-size: cover, cover;',
      '  background-repeat: no-repeat, no-repeat;',
      // Fixed: the picture stays put while the conversation scrolls over it.
      '  background-attachment: fixed, fixed;',
      '}',
    ];
  }
  const image = `#${IMAGE_LAYER_ID}`;
  const tintLayer = `#${TINT_LAYER_ID}`;
  const blur = config.background.blur > 0
    ? `${image} { filter: blur(${config.background.blur}px); transform: scale(1.06); }`
    : '';
  return [
    ...fallback,
    tint,
    // Both layers sit behind the app: negative z-index paints above the page canvas and below
    // everything in normal flow, so text, cards and menus stay on top and keep receiving clicks.
    `${image}, ${tintLayer} { position: fixed; inset: 0; z-index: -1; pointer-events: none; }`,
    imageDataUrl
      ? `${image} { background: url("${imageDataUrl}") center / cover no-repeat; }`
      // A <video> element takes the picture layer's place (see install); it fills the layer the same way.
      : `video${image} { width: 100%; height: 100%; object-fit: cover; }`,
    blur,
    `${tintLayer} { background: var(--za-tint); }`,
    // Last on purpose: with a picture behind the window its base and sidebar must stay see-through
    // even when a skin below gives them a colour. The base the shell root paints on Windows is
    // `bg-background-win-alt`; leaving that opaque covered the whole picture as soon as the app
    // mounted, so it showed on the start-up screen only.
    `${THEME_SELECTORS} { --color-background: transparent !important; --color-background-win-alt: transparent !important; --color-sidebar: transparent !important; }`,
  ];
}

function skinRules(skin) {
  if (!skin) return [];
  const block = (mode) => [
    `  --color-background: ${mode.base} !important;`,
    `  --color-surface: ${mode.surface} !important;`,
    `  --color-panel: ${mode.surface} !important;`,
    `  --color-card: ${mode.surface} !important;`,
    `  --color-popover: ${mode.surface} !important;`,
    `  --color-sidebar: ${mode.base} !important;`,
    `  --color-foreground: ${mode.text} !important;`,
    `  --color-border: ${mode.border} !important;`,
    `  --color-brand: ${mode.accent} !important;`,
  ].join('\n');
  const rules = [];
  if (skin.light) rules.push(`.theme-zai-light {\n${block(skin.light)}\n}`);
  if (skin.dark) rules.push(`.theme-zai-dark {\n${block(skin.dark)}\n}`);
  return rules;
}

export function buildCss(config, { imageDataUrl = null, videoUrl = null } = {}) {
  const rules = [...skinRules(resolveSkin(config)), ...backgroundRules(config, { imageDataUrl, videoUrl })];
  return rules.length ? `/* zcode-appearance */\n${rules.join('\n')}\n` : '';
}

// Short fingerprint of the stylesheet. The launcher polls each window with it instead of sending
// the whole stylesheet (the picture is inside it) every couple of seconds.
export function cssKey(css) {
  return createHash('sha1').update(css).digest('hex').slice(0, 12);
}

// A picture file as a data: URL, with the checks that keep a mistake from turning into a broken
// or enormous stylesheet. Null when there is nothing to show.
export function imageDataUrl(file) {
  if (!file) return null;
  if (mediaKind(file) !== 'picture') throw new Error(`${file} is not a picture; a video is played from its file`);
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err.message}`);
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`${file} is ${Math.round(bytes.length / 1024 / 1024)} MB, above the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit`);
  }
  const extension = file.slice(file.lastIndexOf('.')).toLowerCase();
  return `data:${MIME[extension] ?? 'application/octet-stream'};base64,${bytes.toString('base64')}`;
}

// Runs inside the ZCode window. Self-contained on purpose: it is serialised with toString() and
// has nothing from this module in scope. Returns one short string for the launcher's log:
// 'applied', 'unchanged', 'waiting' (the app has not mounted yet), 'missing-root' ( the
// conversation area could not be found), 'skipped' (not the main window).
function install(payload) {
  const STYLE = 'zcode-appearance-style';
  const IMAGE = 'zcode-appearance-background';
  const TINT = 'zcode-appearance-tint';
  const ORIGIN = ['background', 'surface', 'panel', 'sidebar', 'card', 'popover'];
  const RETRIES = [200, 500, 1000, 2000, 4000];
  const state = (window.__zcodeAppearance = window.__zcodeAppearance || {});
  if (state.key === payload.key && !state.pending && document.getElementById(STYLE)) return 'unchanged';

  let captured = false;
  let tries = 0;
  let repaintTimer = 0;

  // The app's own colours, read while our stylesheet is out of the document. The tint is mixed
  // from the base colour of whichever theme is active, so this runs again when the theme changes.
  function capture() {
    const computed = getComputedStyle(document.body);
    let seen = false;
    for (const name of ORIGIN) {
      const value = computed.getPropertyValue('--color-' + name).trim();
      if (!value) continue;
      seen = true;
      document.body.style.setProperty('--za-orig-' + name, value);
    }
    return seen;
  }

  function syncLayers() {
    const body = document.body;
    let image = document.getElementById(IMAGE);
    let tint = document.getElementById(TINT);
    if (!payload.layers) {
      // A video that leaves the page has to be stopped: removing the element alone keeps it
      // playing in Chromium.
      if (image && image.tagName === 'VIDEO') image.pause();
      if (image) image.remove();
      if (tint) tint.remove();
      return;
    }
    const wantVideo = Boolean(payload.video);
    if (image && (image.tagName === 'VIDEO') !== wantVideo) {
      if (image.tagName === 'VIDEO') image.pause();
      image.remove();
      image = null;
    }
    if (!image) {
      image = document.createElement(wantVideo ? 'video' : 'div');
      image.id = IMAGE;
    }
    if (wantVideo) {
      // Muted, always: a background makes no sound. Muted is also what lets it start without a click.
      image.muted = true;
      image.loop = true;
      image.playsInline = true;
      if (image.getAttribute('src') !== payload.video) image.setAttribute('src', payload.video);
    }
    if (!tint) {
      tint = document.createElement('div');
      tint.id = TINT;
    }
    image.setAttribute('aria-hidden', 'true');
    tint.setAttribute('aria-hidden', 'true');
    if (body.firstChild !== image) body.insertBefore(image, body.firstChild);
    // Picture first, tint second: same z-index, so document order decides which paints on top.
    if (image.nextSibling !== tint) body.insertBefore(tint, image.nextSibling);
    // play() is refused until the page has been shown once; the retry below starts it then.
    if (wantVideo && !document.hidden) image.play().catch(function () {});
  }

  // Nothing decodes a video nobody is looking at: it pauses with the window and resumes with it.
  function watchVisibility() {
    if (state.watchingVisibility) return;
    state.watchingVisibility = true;
    document.addEventListener('visibilitychange', function () {
      const video = document.getElementById(IMAGE);
      if (!video || video.tagName !== 'VIDEO') return;
      if (document.hidden) video.pause();
      else video.play().catch(function () {});
    });
  }

  function repaint() {
    const previous = document.getElementById(STYLE);
    if (previous) previous.remove();
    if (!captured) captured = capture();
    const style = document.createElement('style');
    style.id = STYLE;
    style.textContent = payload.css;
    (document.head || document.body).appendChild(style);
    syncLayers();
    state.key = payload.key;
    state.pending = false;
    // For whoever asks the page what has been going on (the launcher's --attach checks).
    state.repaints = (state.repaints ?? 0) + 1;
    if (!captured && tries < RETRIES.length) {
      // A cold start runs this before the app's stylesheet is parsed: nothing to read from yet.
      const delay = RETRIES[tries];
      tries += 1;
      setTimeout(function retry() {
        if (state.key !== payload.key || captured) return;
        captured = capture();
        if (captured) repaint();
      }, delay);
    }
    if (payload.chatRoot && !document.querySelector(payload.chatRoot)) return 'missing-root';
    if (payload.note) return payload.note;
    return 'applied';
  }

  function watchTheme() {
    if (state.watching) return;
    state.watching = true;
    const observer = new MutationObserver(() => {
      clearTimeout(repaintTimer);
      repaintTimer = setTimeout(() => {
        captured = false;
        repaint();
      }, 60);
    });
    for (const node of [document.documentElement, document.body]) {
      if (node) observer.observe(node, { attributes: true, attributeFilter: ['class'] });
    }
  }

  function start() {
    const result = repaint();
    watchTheme();
    watchVisibility();
    return result;
  }

  if (document.body && document.querySelector(payload.shellRoot)) return start();

  if (!payload.shellRoot) return 'skipped';
  // A document that is still loading: wait briefly for the app to mount. Claim the key meanwhile
  // so the launcher does not keep re-sending this stylesheet while it waits.
  state.key = payload.key;
  state.pending = true;
  const deadline = Date.now() + 10000;
  const poll = setInterval(() => {
    if (state.key !== payload.key) {
      clearInterval(poll);
      state.pending = false;
    } else if (document.body && document.querySelector(payload.shellRoot)) {
      clearInterval(poll);
      start();
    } else if (Date.now() > deadline) {
      // Pages without the app root (sandboxes, utility windows) are left alone.
      clearInterval(poll);
      state.key = null;
      state.pending = false;
    }
  }, 40);
  return 'waiting';
}

function payloadOf(config, { imageDataUrl, videoUrl }) {
  const css = buildCss(config, { imageDataUrl, videoUrl });
  const enabled = config.background.enabled;
  const page = Boolean(enabled && (imageDataUrl || videoUrl) && config.background.scope === 'page');
  return {
    css,
    key: cssKey(css),
    layers: page,
    video: page && !imageDataUrl && videoUrl ? videoUrl : '',
    chatRoot: enabled && imageDataUrl && config.background.scope === 'chat' ? CHAT_ROOT : '',
    // Said once in the launcher's log instead of failing silently.
    note: enabled && !imageDataUrl && videoUrl && config.background.scope === 'chat' ? 'video-needs-page' : '',
    shellRoot: SHELL_ROOT,
  };
}

// Everything the launcher needs to bring one window to one configuration: the stylesheet, the
// script that installs it, the cheap check, and the fingerprint they all agree on.
export function buildPlan(config, { imageDataUrl = null, videoUrl = null } = {}) {
  const payload = payloadOf(config, { imageDataUrl, videoUrl });
  return {
    key: payload.key,
    css: payload.css,
    script: `(${install.toString()})(${JSON.stringify(payload)})`,
    check: buildCheckScript(payload.key),
  };
}

export function buildApplyScript(config, options) {
  return buildPlan(config, options).script;
}

// The cheap question the launcher asks between full applications: is this window already showing
// (or waiting to show) this exact stylesheet?
export function buildCheckScript(key) {
  const state = 'window.__zcodeAppearance';
  return `(${state} && ${state}.key === ${JSON.stringify(key)} && (${state}.pending || document.getElementById(${JSON.stringify(STYLE_ID)}))) ? 'ok' : 'stale'`;
}

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
// The class the page script puts on <html> once the app's colours, the theme and the picture
// are known; every rule that makes the window see-through waits for it (see backgroundRules).
export const SHOWN = 'za-shown';
// On <html> for the moment of the reveal only: the base's colour fades to see-through under it,
// so the picture layer, covered until then, is drawn before the window shows what is behind it.
export const REVEALING = 'za-revealing';
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

// The window the app shows while it starts: a dark rounded shell with the logo, which the app
// itself pops in (0.72 s) and fades out when its first screen is ready. Here the logo also
// breathes a little while it is shown, and it leaves less abruptly. Nothing moves for someone
// who asked the system for less motion.
//
// The stylesheet arrives while the pop is playing (about 350 ms into the page), and from then
// until the first screen is ready (about 600 ms) the main thread is the app's: its scripts load
// and React mounts. The shell's own animation is left alone: replacing it would play the pop a
// second time. The logo breathes instead, by a transform, which the compositor animates without
// the main thread. A light running around the border of the shell was tried and taken out: it
// has to be turned by the compositor too, and that takes an element of ours inside the shell
// and a masked ring, and it still did not show on a real start; not worth more of the start.
function startupRules() {
  return [
    '#loading .startup-logo { transform-origin: center; animation: za-startup-breathe 2.4s ease-in-out infinite; }',
    '#loading { transition: opacity 0.36s ease !important; }',
    '#root { transition: opacity 0.3s ease !important; }',
    '@keyframes za-startup-breathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.035); } }',
    '@media (prefers-reduced-motion: reduce) { #loading .startup-logo { animation: none; } }',
  ];
}

function backgroundRules(config, { imageDataUrl, videoUrl }) {
  if (!config.background.enabled || !(imageDataUrl || videoUrl)) return [];
  // A video is an element, not a CSS background, so it has no place in the conversation area.
  if (config.background.scope === 'chat' && !imageDataUrl) return [];
  const percent = Math.round(config.background.mask * 100);
  // Everything that makes the window see-through waits for `za-shown` on <html>, which the page
  // script puts there once the app's colours, the theme and the picture are known (see install:
  // reveal). Until then the window keeps the app's own colours. Without this, a stylesheet that
  // lands early (350 ms into the page, since the start-up got faster: before the app has put its
  // theme class on <html>) made the window see-through under the tint of the light theme, which
  // is the fallback until the theme is known: a white flash at every start.
  const shown = (selector) => `:root.${SHOWN} ${selector}`;
  // On <body>, not on the root: the app's colours are read from the body (see install), and a
  // var() is resolved where the custom property is declared, so the root cannot see them.
  // The same strength in both themes. A stronger one in the light theme was tried (the setting
  // plus 18 points): the picture all but disappeared, which is worse than text that is harder
  // to read here and there.
  const tint = `body { --za-tint: color-mix(in oklab, var(--za-orig-background, var(--za-fallback)) ${percent}%, transparent); }`;
  const fallback = [':root { --za-fallback: #f4f4f5; }', '.theme-zai-dark { --za-fallback: #0a0a0a; }'];
  // The base does not go see-through in one step: while `za-revealing` is on, its colour fades
  // over 300 ms. Until the reveal the picture layer was covered by an opaque base, and Chromium
  // rasterises nothing of a covered layer; made transparent at once, the window showed what is
  // behind it for the few frames the picture took to come up (a bright blink at every start).
  // Fading, the layer is uncovered from the first frame while the base is still nearly opaque.
  const revealing = `:root.${REVEALING} :is(.bg-background-win-alt, .bg-background, .bg-sidebar) { transition: background-color 0.3s ease; }`;
  if (config.background.scope === 'chat') {
    // `CHAT_ROOT` is a list of selectors, so every rule is written once per selector: anything
    // appended to the list as a whole would land on its last selector only.
    const selectors = CHAT_ROOT.split(', ').map(shown);
    // The picture goes on the card the app draws right inside the area when there is one (it is
    // rounded and clips, so the picture gets its corners), and otherwise on the area itself.
    const area = selectors.map((selector) => `${selector} { --color-background: transparent !important; background-color: transparent !important; }`);
    const painted = selectors.flatMap((selector) => [`${selector} > * > .bg-background`, `${selector}:not(:has(> * > .bg-background))`]);
    return [
      ...fallback,
      tint,
      // The card the app draws in the conversation area paints with the base colour (bg-background).
      // Inside the area that colour goes see-through, as it does behind the whole window in page
      // scope; cards, popovers and the composer keep their own surfaces. Without this the card
      // covered the picture completely: the scope looked as if nothing had happened.
      ...area,
      // The picture is a declaration of its own, without a var() next to it: with the tint's
      // gradient in the same declaration, a picture of a few megabytes made Chromium drop the
      // whole declaration (a tiny one survived, so the tests did not see it).
      ...painted.map((selector) => `${selector} { position: relative; isolation: isolate; background-image: url("${imageDataUrl}"); background-position: center; background-size: cover; background-repeat: no-repeat; background-attachment: fixed; }`),
      // The tint is a layer of its own, over the picture and under the writing: in the stacking
      // context the element now has, below its content. Fixed, so the picture stays put while the
      // conversation scrolls over it.
      ...painted.map((selector) => `${selector}::before { content: ''; position: absolute; inset: 0; z-index: -1; background: var(--za-tint); pointer-events: none; }`),
      revealing,
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
    // Hidden until the word, though: the app paints its base only once it has mounted (about
    // 900 ms into the page), and until then nothing covers these layers — injected at 350 ms,
    // they showed at once, under the light tint that is all there is before the theme is known.
    // (The gate on the base's colour could not help: there was no base yet.)
    `${image}, ${tintLayer} { position: fixed; inset: 0; z-index: -1; pointer-events: none; visibility: hidden; }`,
    `${THEME_SELECTORS.split(', ').map((selector) => `${selector}.${SHOWN} :is(${image}, ${tintLayer})`).join(', ')} { visibility: visible; }`,
    imageDataUrl
      ? `${image} { background: url("${imageDataUrl}") center / cover no-repeat; }`
      // A <video> element takes the picture layer's place (see install); it fills the layer the same way.
      : `video${image} { width: 100%; height: 100%; object-fit: cover; }`,
    blur,
    `${tintLayer} { background: var(--za-tint); }`,
    // After the layers on purpose: with a picture behind the window its base and sidebar must
    // stay see-through even when a skin below gives them a colour. The base the shell root paints
    // on Windows is `bg-background-win-alt`; leaving that opaque covered the whole picture as
    // soon as the app mounted, so it showed on the start-up screen only.
    `${THEME_SELECTORS.split(', ').map((selector) => `${selector}.${SHOWN}`).join(', ')} { --color-background: transparent !important; --color-background-win-alt: transparent !important; --color-sidebar: transparent !important; }`,
    revealing,
  ];
}

function skinRules(skin) {
  if (!skin) return [];
  // The app derives a dozen semantic colours from a few: a secondary button (the composer's
  // stop button among them), hover backgrounds, borders on hover, subtle text, inputs, headers,
  // the selected card, the primary action. Each is mixed from the five of the mode here, in
  // the proportions the app's own themes use, so a skin covers them all; the first skins set
  // nine colours and left the stop button in the default theme's grey.
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
    `  --color-foreground-inverse: ${mode.base} !important;`,
    `  --color-foreground-subtle: color-mix(in oklab, ${mode.text} 60%, transparent) !important;`,
    `  --color-foreground-subtlest: color-mix(in oklab, ${mode.text} 30%, transparent) !important;`,
    `  --color-surface-hover: color-mix(in oklab, ${mode.text} 10%, transparent) !important;`,
    `  --color-border-hover: color-mix(in oklab, ${mode.text} 22%, transparent) !important;`,
    `  --color-secondary: color-mix(in oklab, ${mode.text} 18%, ${mode.base}) !important;`,
    `  --color-accent: color-mix(in oklab, ${mode.text} 10%, ${mode.base}) !important;`,
    `  --color-card-selected: color-mix(in oklab, ${mode.text} 12%, ${mode.base}) !important;`,
    `  --color-header: color-mix(in oklab, ${mode.surface} 70%, ${mode.base}) !important;`,
    `  --color-popover-header: color-mix(in oklab, ${mode.surface} 70%, ${mode.base}) !important;`,
    `  --color-input: ${mode.surface} !important;`,
    `  --color-input-focused: ${mode.surface} !important;`,
    `  --color-primary: ${mode.accent} !important;`,
    `  --color-primary-foreground: ${mode.base} !important;`,
  ].join('\n');
  const rules = [];
  if (skin.light) rules.push(`.theme-zai-light {\n${block(skin.light)}\n}`);
  if (skin.dark) rules.push(`.theme-zai-dark {\n${block(skin.dark)}\n}`);
  return rules;
}

export function buildCss(config, options = {}) {
  const background = backgroundRules(config, options);
  const rules = [
    ...skinRules(resolveSkin(config)),
    ...background,
    // The start-up screen gets its motion only when a background is shown: that is when this
    // plugin is showing anything at all.
    ...(background.length ? startupRules() : []),
  ];
  return rules.length ? `/* zcode-appearance */\n${rules.join('\n')}\n` : '';
}

// Short fingerprint of the stylesheet. The launcher polls each window with it instead of sending
// the whole stylesheet (the picture is inside it) every couple of seconds.
export function cssKey(css) {
  return createHash('sha1').update(css).digest('hex').slice(0, 12);
}

// A picture file as a data: URL, with the checks that keep a mistake from turning into a broken
// or enormous stylesheet. Null when there is nothing to show. The size is looked at before the
// file is read, so that a mistaken multi-gigabyte file is refused, not loaded.
export function imageDataUrl(file) {
  if (!file) return null;
  if (mediaKind(file) !== 'picture') throw new Error(`${file} is not a picture; a video is played from its file`);
  const tooBig = () => new Error(`${file} is above the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit`);
  let size;
  try {
    // Looked at before it is read: a mistaken multi-gigabyte file is refused, not loaded.
    size = fs.statSync(file).size;
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err.message}`);
  }
  if (size > MAX_IMAGE_BYTES) throw tooBig();
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err.message}`);
  }
  // Grown between the look and the read.
  if (bytes.length > MAX_IMAGE_BYTES) throw tooBig();
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
  // The same name as SHOWN above; this function is serialised and has nothing else in scope.
  const SHOWN = 'za-shown';
  const REVEALING = 'za-revealing';
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

  // The window keeps the app's own colours until three things are known: the app's colours (the
  // tint is mixed from them), the theme (the app puts `theme-zai-*` on <html> a moment after its
  // scripts run; until then the tint would be the light one whatever the theme is), and, in page
  // scope, the picture (an undecoded layer paints nothing). Then `za-shown` goes on <html>, and
  // the rules that make the window see-through apply (see backgroundRules) — in the conversation
  // scope too, whose rules wait for the same word. Each is waited for a while only: a build
  // that names its theme or its colours differently, or a picture that will not decode, must not
  // keep the app's colours for good. Shown once, it stays: a picture changed later swaps in
  // place, as it always did.
  function themed() {
    return /(^|\s)theme-zai-(light|dark)(\s|$)/.test(document.documentElement.className);
  }

  function reveal() {
    if (state.shown || !(payload.layers || payload.chatRoot)) return;
    if (themed()) state.themeAt ??= Math.round(performance.now());
    if (!captured && Date.now() < (state.captureUntil ?? Infinity)) return;
    // The conversation scope has no layer: its picture is the card's background, and the card
    // simply paints it once decoded; the window behind keeps the app's colours there.
    if (payload.layers && !state.mediaReady) return;
    if (!themed() && Date.now() < (state.revealAfter ?? Infinity)) return;
    // Shown, but not in one step: the base's colour fades (see backgroundRules), so the picture
    // layer, covered until now, is drawn before the window shows what is behind it. The fading
    // class goes on first, the shown one a frame later (a transition has to be in force before
    // the colour changes), and it comes off when the fade is over.
    state.shown = true;
    document.documentElement.classList.add(REVEALING);
    const show = () => {
      if (state.shownAt !== undefined) return;
      document.documentElement.classList.add(SHOWN);
      state.shownAt = Math.round(performance.now());
      setTimeout(() => document.documentElement.classList.remove(REVEALING), 600);
    };
    // Two frames when the page is drawing; a hidden page does not draw, and shows when it does.
    requestAnimationFrame(() => requestAnimationFrame(show));
    setTimeout(show, 80);
  }

  function watchMedia() {
    if (state.watchingMedia === payload.key) return;
    state.watchingMedia = payload.key;
    state.mediaReady = false;
    // Only the plan that asked decides: a picture swapped out while it decoded must not open
    // the door for the one that took its place.
    const done = () => {
      if (state.watchingMedia !== payload.key) return;
      state.mediaReady = true;
      reveal();
    };
    setTimeout(done, 3000);
    const layer = document.getElementById(IMAGE);
    if (!layer) return done();
    if (layer.tagName === 'VIDEO') {
      if (layer.readyState >= 2) return done();
      layer.addEventListener('loadeddata', done, { once: true });
      layer.addEventListener('error', done, { once: true });
      return;
    }
    // The picture is the layer's background; the same image, decoded by the browser, says when.
    // Only a data: picture of ours is decoded: the page could style the layer otherwise, and
    // what the page styles are not ours to load.
    const match = /^url\("(data:image\/[^"]*)"\)$/.exec(getComputedStyle(layer).backgroundImage);
    if (!match) return done();
    const picture = new Image();
    picture.src = match[1];
    if (picture.decode) picture.decode().then(done, done);
    else picture.onload = picture.onerror = done;
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
    // For whoever asks the page what has been going on (the launcher's --attach checks): how
    // often the stylesheet was put in, and when it first was.
    state.repaints = (state.repaints ?? 0) + 1;
    state.appliedAt ??= Math.round(performance.now());
    if (state.revealAfter === undefined) {
      // The theme is given four seconds: the app switches its class on when its settings have
      // loaded, and on a real start that was later than one second after the stylesheet came
      // (the window showed the picture under the light theme's tint for a moment, then turned
      // dark). Until then the window keeps the app's own colours, which is what it shows
      // without this plugin anyway.
      state.revealAfter = Date.now() + 4000;
      state.captureUntil = Date.now() + 5000;
      // Through the newest plan's reveal, like the observer's recapture: these timers outlive
      // the plan that set them.
      setTimeout(() => state.reveal?.(), 4000);
      // The colours, too, are given up on after a while: a build that names them differently
      // must not keep its window without the picture for good (the tint then uses the fallback).
      setTimeout(() => state.reveal?.(), 5100);
    }
    watchMedia();
    reveal();
    if (!captured && tries < RETRIES.length) {
      // A cold start runs this before the app's stylesheet is parsed: nothing to read from yet.
      const delay = RETRIES[tries];
      tries += 1;
      // Through repaint(), which takes the stylesheet out before it reads: reading with it in,
      // the colours read back were our own (`transparent`), and the tint stayed invisible until
      // the next theme change.
      setTimeout(function retry() {
        if (state.key !== payload.key || captured) return;
        repaint();
      }, delay);
    }
    if (payload.chatRoot && !document.querySelector(payload.chatRoot)) return 'missing-root';
    if (payload.note) return payload.note;
    return 'applied';
  }

  // When the app's first screen was ready, the same way: it says how long the start-up screen
  // stayed after the stylesheet came.
  function noteReady() {
    if (state.readyAt === undefined && document.body.classList.contains('zcode-startup-ready')) {
      state.readyAt = Math.round(performance.now());
    }
  }

  // Only the classes that say which theme is on: the app toggles `theme-zai-light` /
  // `theme-zai-dark` (and `dark`) on <html> when its theme changes.
  function themeKey(names) {
    return names.split(/\s+/).filter((name) => /^(theme-zai-(light|dark)|dark|light)$/.test(name)).sort().join(' ');
  }

  function watchTheme() {
    if (state.watching) return;
    state.watching = true;
    const observer = new MutationObserver((records) => {
      noteReady();
      // Only a change of theme is worth reading the colours again. Reading takes the stylesheet
      // out for a moment, and that retargets every transition the page is running: on any class
      // change at all (the app's `zcode-startup-ready` at the hand-off from its start-up screen,
      // our own reveal classes) the screen being faded in jumped — a flicker at every start.
      if (!records.some((record) => themeKey(record.oldValue ?? '') !== themeKey(record.target.className))) return;
      clearTimeout(repaintTimer);
      repaintTimer = setTimeout(() => {
        // The newest plan's: this observer is made once, by the first stylesheet the page got,
        // and that plan's own repaint would put its stylesheet back after every later change.
        state.recapture?.();
      }, 60);
    });
    for (const node of [document.documentElement, document.body]) {
      if (node) observer.observe(node, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    }
  }

  function start() {
    state.recapture = () => {
      captured = false;
      repaint();
    };
    state.reveal = reveal;
    const result = repaint();
    noteReady();
    watchTheme();
    watchVisibility();
    return result;
  }

  if (document.body && document.querySelector(payload.shellRoot)) return start();

  if (!payload.shellRoot) return 'skipped';
  // A document that is still loading: wait for the app to mount. Claim the key meanwhile
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
      clearInterval(poll);
      // Ten seconds and still no app root: this is not one of the app's pages (a sandbox, a
      // utility window). It stays claimed, so the launcher is not sent back here to re-send
      // the stylesheet every poll, and a slow look every second still catches a window that
      // mounts late. The claim ends when the launcher sends another stylesheet.
      const slow = setInterval(() => {
        if (state.key !== payload.key) {
          clearInterval(slow);
          state.pending = false;
        } else if (document.body && document.querySelector(payload.shellRoot)) {
          clearInterval(slow);
          start();
        }
      }, 1000);
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

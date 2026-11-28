import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { applyPatch, defaultConfig, MAX_IMAGE_BYTES } from '../src/config.mjs';
import { SKINS } from '../src/skins.mjs';
import {
  IMAGE_LAYER_ID,
  TINT_LAYER_ID,
  CHAT_ROOT,
  SHOWN,
  buildApplyScript,
  buildCheckScript,
  buildCss,
  buildPlan,
  cssKey,
  imageDataUrl,
} from '../src/css.mjs';

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const CLIP = 'file:///E:/Wallpapers/clip.webm';
const PNG_BYTES = Buffer.from(PIXEL.split(',')[1], 'base64');
const THEMES = ':root.za-shown, .theme-zai-light.za-shown, .theme-zai-dark.za-shown';
const withScope = (scope, extra = {}) => ({ ...defaultConfig(), background: { ...defaultConfig().background, scope, ...extra } });

describe('stylesheet', () => {
  it('is empty when there is nothing to show', () => {
    assert.equal(buildCss(defaultConfig()), '');
    assert.equal(buildCss(withScope('page', { enabled: false }), { imageDataUrl: PIXEL }), '');
    assert.ok(buildCss(withScope('page'), { imageDataUrl: PIXEL }).includes(IMAGE_LAYER_ID));
  });

  it('puts the picture behind the window with a tint of the theme colour on top', () => {
    const css = buildCss(withScope('page', { mask: 0.5, blur: 6 }), { imageDataUrl: PIXEL });
    // Id selectors: without the # the browser reads a tag name and nothing matches.
    assert.ok(css.includes(`#${IMAGE_LAYER_ID}, #${TINT_LAYER_ID} { position: fixed; inset: 0; z-index: -1;`));
    assert.ok(css.includes(`#${IMAGE_LAYER_ID} { background: url("${PIXEL}") center / cover no-repeat; }`));
    assert.ok(css.includes(`#${IMAGE_LAYER_ID} { filter: blur(6px);`));
    // On the body: that is where the app's colours were read onto, and a var() in a custom
    // property is resolved where the property is declared.
    assert.ok(css.includes('body { --za-tint: color-mix(in oklab, var(--za-orig-background, var(--za-fallback)) 50%, transparent); }'));
    assert.ok(css.includes(`#${TINT_LAYER_ID} { background: var(--za-tint); }`));
    assert.ok(css.includes('.theme-zai-dark { --za-fallback: #0a0a0a; }'));
    // One strength for both themes: a stronger one in the light theme was tried and made the
    // picture all but disappear.
    assert.ok(!css.includes('.theme-zai-light body'), 'no tint of its own for the light theme');
  });

  it('gives a video the same layer, filled by the element instead of a CSS background', () => {
    const css = buildCss(withScope('page', { blur: 4 }), { videoUrl: CLIP });
    assert.ok(css.includes(`video#${IMAGE_LAYER_ID} { width: 100%; height: 100%; object-fit: cover; }`));
    assert.ok(css.includes(`#${IMAGE_LAYER_ID} { filter: blur(4px);`), 'blur works on the element too');
    assert.ok(css.includes(`#${IMAGE_LAYER_ID}, #${TINT_LAYER_ID} { position: fixed; inset: 0; z-index: -1;`));
    // The URL of the file is given to the script, never written into the stylesheet.
    assert.ok(!css.includes('clip.webm'));
    assert.ok(!css.includes('url("data:'), 'a video is never embedded');
  });

  it('keeps the base and the sidebar see-through even under a skin', () => {
    const config = withScope('page');
    config.skin.preset = 'catppuccin';
    const css = buildCss(config, { imageDataUrl: PIXEL });
    const skinBase = css.indexOf(`--color-background: ${SKINS.catppuccin.light.base} !important;`);
    const seeThrough = css.lastIndexOf(`${THEMES} { --color-background: transparent !important; --color-background-win-alt: transparent !important; --color-sidebar: transparent !important; }`);
    assert.ok(skinBase > 0, 'the skin gives the base a colour');
    assert.ok(seeThrough > skinBase, 'and the later rule of equal specificity takes it away again');
  });

  it('paints the conversation area in chat scope, on the card the app draws there, with a picture', () => {
    const css = buildCss(withScope('chat', { mask: 0.3 }), { imageDataUrl: PIXEL });
    assert.equal(CHAT_ROOT, '[data-testid="conversation"], [data-testid="chat-view"]');
    // On the card right inside the area when there is one, otherwise on the area itself. The
    // card paints with the base colour; with that left opaque it covered the picture completely.
    // All of it under the page script's word (za-shown): see the test below.
    const cardRule = ':root.za-shown [data-testid="conversation"] > * > .bg-background';
    const flatRule = ':root.za-shown [data-testid="conversation"]:not(:has(> * > .bg-background))';
    assert.ok(css.includes(`\n${cardRule} { position: relative;`), 'the card inside');
    assert.ok(css.includes(`\n${flatRule} { position: relative;`), 'or the area itself');
    // One rule per selector: `::before` and the rest appended to the list as a whole once landed
    // on its last selector only, and the first got the tint layer's place and z-index instead.
    assert.equal(css.split(`background-image: url("${PIXEL}");`).length - 1, 4, 'the picture, with its URL filled in, on each of the four selectors');
    assert.equal(css.split('background-attachment: fixed;').length - 1, 4);
    // The picture's declaration holds no var(): with the tint's gradient beside a picture of a
    // few megabytes, Chromium dropped the whole declaration (see the browser test with a big one).
    assert.ok(!/background-image: url\("[^"]*"\)[^;}]*var\(/.test(css), 'nothing variable next to the picture');
    // The tint is a layer of its own, under the writing.
    assert.equal(css.split(`${cardRule}::before { content: ''; position: absolute; inset: 0; z-index: -1; background: var(--za-tint); pointer-events: none; }`).length - 1, 1);
    assert.equal(css.split("::before { content: ''; position: absolute; inset: 0; z-index: -1;").length - 1, 4, 'one for each of the four selectors');
    assert.ok(!css.includes('.bg-background, [data-testid="chat-view"] > * > .bg-background::before'), 'the pseudo-element is not stuck onto the last selector of a list');
    assert.ok(css.includes(':root.za-shown [data-testid="conversation"] { --color-background: transparent !important;') && css.includes(':root.za-shown [data-testid="chat-view"] { --color-background: transparent !important;'), 'the base colour goes see-through inside the area');
    assert.ok(!css.includes(IMAGE_LAYER_ID));
    assert.ok(!/\.theme-zai-(light|dark)[^{]*\{[^}]*--color-background: transparent/.test(css), 'the rest of the window is left as it is');
  });

  it('makes nothing see-through before the page script says the colours, the theme and the picture are known', () => {
    // The stylesheet lands early in the page (before the app has its theme class): made
    // see-through at once, the window showed the light theme's tint over a transparent root
    // for a moment — a white flash at every start.
    for (const scope of ['page', 'chat']) {
      const css = buildCss(withScope(scope), { imageDataUrl: PIXEL });
      const seeThrough = css.split('\n').filter((line) => line.includes('transparent !important'));
      assert.ok(seeThrough.length > 0, `${scope}: something goes see-through`);
      assert.ok(seeThrough.every((line) => line.includes(`.${SHOWN}`)), `${scope}: and only under ${SHOWN}`);
    }
    const script = buildPlan(withScope('page'), { imageDataUrl: PIXEL }).script;
    assert.ok(script.includes("classList.add(SHOWN)"), 'the page script gives the word');
    assert.ok(script.includes("theme-zai-(light|dark)"), 'once the app has named its theme');
    assert.ok(script.includes("picture.decode()"), 'and the picture is decoded');
    assert.ok(script.includes('setTimeout(done, 3000)') && script.includes('Date.now() + 4000') && script.includes('Date.now() + 5000'), 'but not for good: the theme after four seconds, the colours after five');
  });

  it('has nothing to offer a video in the conversation area', () => {
    assert.equal(buildCss(withScope('chat'), { videoUrl: CLIP }), '');
    assert.equal(buildPlan(withScope('chat'), { videoUrl: CLIP }).script.includes('video-needs-page'), true, 'and says so to the launcher');
  });

  it('lets the start-up logo breathe, only while a background is shown', () => {
    const css = buildCss(withScope('page'), { imageDataUrl: PIXEL });
    // By a transform, which the compositor animates: from the moment the stylesheet lands until
    // the first screen is ready, the main thread is the app's and paints nothing on its own.
    assert.ok(css.includes('#loading .startup-logo { transform-origin: center; animation: za-startup-breathe 2.4s ease-in-out infinite; }'), 'the logo breathes');
    assert.ok(css.includes('@keyframes za-startup-breathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.035); } }'));
    // The shell's animation is the app's own pop: replaced, it would play again when the
    // stylesheet arrives, while the pop is on.
    assert.equal(css.includes('#loading .startup-logo-shell {'), false, 'the shell\'s own animation is left alone');
    assert.equal(css.includes('za-beam'), false, 'no light on the border: tried and taken out');
    assert.ok(css.includes('#loading { transition: opacity 0.36s ease !important; }') && css.includes('#root { transition: opacity 0.3s ease !important; }'), 'and the screen leaves less abruptly');
    assert.ok(css.includes('@media (prefers-reduced-motion: reduce) { #loading .startup-logo { animation: none; } }'), 'and nothing moves for those who asked for less');
    assert.equal(buildCss(withScope('page'), {}).includes('#loading'), false, 'no background, no start-up rules of ours');
  });

  it('writes a skin per theme, or just the modes it has', () => {
    const kanagawa = defaultConfig();
    kanagawa.skin.preset = 'kanagawa';
    const preset = buildCss(kanagawa);
    assert.ok(preset.includes(`.theme-zai-light {\n  --color-background: ${SKINS.kanagawa.light.base} !important;`));
    assert.ok(preset.includes(`.theme-zai-dark {\n  --color-background: ${SKINS.kanagawa.dark.base} !important;`));
    for (const name of ['surface', 'panel', 'card', 'popover', 'sidebar', 'foreground', 'border', 'brand']) {
      assert.ok(preset.includes(`--color-${name}:`), name);
    }
    // What the app derives from a few colours, a skin derives too, in both themes: the
    // composer's stop button paints with `secondary`, hover with `accent`, and so on.
    for (const name of ['secondary', 'accent', 'input', 'input-focused', 'header', 'popover-header', 'card-selected', 'surface-hover', 'border-hover', 'foreground-subtle', 'foreground-subtlest', 'foreground-inverse', 'primary', 'primary-foreground']) {
      assert.equal(preset.split(`--color-${name}:`).length - 1, 2, `${name}, in both themes`);
    }
    const { text, base } = SKINS.kanagawa.dark;
    assert.ok(preset.includes(`--color-secondary: color-mix(in oklab, ${text} 18%, ${base}) !important;`), 'the secondary surfaces are mixed from the text and the base');
    const custom = applyPatch(defaultConfig(), { customSkin: { dark: { base: '#101418', surface: '#181d25', text: '#e6e6e6', accent: '#38bdf8', border: '#2a303a' } } });
    const only = buildCss(custom);
    assert.ok(!only.includes('.theme-zai-light'));
    assert.ok(only.includes('--color-brand: #38bdf8 !important;'));
  });
});

describe('picture file', () => {
  const inTempDir = (run) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appearance-image-'));
    try {
      return run(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it('becomes a data URL with its type', () => inTempDir((dir) => {
    const file = path.join(dir, 'Wall.PNG');
    fs.writeFileSync(file, PNG_BYTES);
    assert.ok(imageDataUrl(file).startsWith('data:image/png;base64,iVBORw0KGgo'));
    assert.equal(imageDataUrl(null), null);
  }));

  it('is not asked of a video', () => inTempDir((dir) => {
    const clip = path.join(dir, 'clip.webm');
    fs.writeFileSync(clip, Buffer.from('GkXfo59C', 'base64'));
    assert.throws(() => imageDataUrl(clip), /is not a picture; a video is played from its file/);
  }));

  it('says so when the picture cannot be read or is too large', () => inTempDir((dir) => {
    assert.throws(() => imageDataUrl(path.join(dir, 'gone.png')), /cannot read .*gone\.png/);
    const huge = path.join(dir, 'huge.png');
    fs.writeFileSync(huge, Buffer.alloc(MAX_IMAGE_BYTES + 1));
    assert.throws(() => imageDataUrl(huge), /above the 20 MB limit/);
  }));
});

describe('plan', () => {
  it('gives the stylesheet, the script and the check one fingerprint', () => {
    const plan = buildPlan(withScope('page'), { imageDataUrl: PIXEL });
    assert.equal(plan.key, cssKey(plan.css));
    assert.ok(plan.css.includes(IMAGE_LAYER_ID));
    assert.ok(plan.script.startsWith('(function install(payload)'));
    assert.ok(plan.script.includes(`"key":"${plan.key}"`));
    assert.ok(plan.script.includes('"video":""'), 'no video unless one is given');
    assert.ok(plan.check.includes(`.key === "${plan.key}"`));
    assert.notEqual(buildPlan(withScope('page', { mask: 0.9 }), { imageDataUrl: PIXEL }).key, plan.key);
    assert.equal(buildPlan(withScope('page'), { imageDataUrl: PIXEL }).key, plan.key, 'the same settings give the same key');
  });

  it('hands a video to the script as the address of its file', () => {
    const plan = buildPlan(withScope('page'), { videoUrl: CLIP });
    assert.ok(plan.script.includes(`"video":"file:///E:/Wallpapers/clip.webm"`));
    assert.equal(plan.key, cssKey(plan.css));
  });

  it('produces scripts that parse', () => {
    assert.doesNotThrow(() => new Function(buildApplyScript(withScope('chat'), { imageDataUrl: PIXEL })));
    assert.doesNotThrow(() => new Function(buildApplyScript(withScope('page'), { videoUrl: CLIP })));
    assert.doesNotThrow(() => new Function(buildCheckScript('abc')));
  });
});

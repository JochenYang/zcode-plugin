import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { applyPatch, defaultConfig, MAX_IMAGE_BYTES } from '../src/config.mjs';
import {
  IMAGE_LAYER_ID,
  TINT_LAYER_ID,
  CHAT_ROOT,
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
const THEMES = ':root, .theme-zai-light, .theme-zai-dark';
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
    config.skin.preset = 'midnight';
    const css = buildCss(config, { imageDataUrl: PIXEL });
    const skinBase = css.indexOf('--color-background: #eef1f6 !important;');
    const seeThrough = css.lastIndexOf(`${THEMES} { --color-background: transparent !important; --color-background-win-alt: transparent !important; --color-sidebar: transparent !important; }`);
    assert.ok(skinBase > 0, 'the skin gives the base a colour');
    assert.ok(seeThrough > skinBase, 'and the later rule of equal specificity takes it away again');
  });

  it('paints only the conversation area in chat scope, with a picture', () => {
    const css = buildCss(withScope('chat', { mask: 0.3 }), { imageDataUrl: PIXEL });
    assert.equal(CHAT_ROOT, '[data-testid="conversation"], [data-testid="chat-view"]');
    assert.ok(css.includes(`${CHAT_ROOT} {`));
    assert.ok(css.includes(`background-image: linear-gradient(var(--za-tint), var(--za-tint)), url("${PIXEL}");`));
    assert.ok(css.includes('background-attachment: fixed, fixed;'));
    assert.ok(!css.includes(IMAGE_LAYER_ID));
    assert.ok(!css.includes('--color-background: transparent'), 'the rest of the window is left as it is');
  });

  it('has nothing to offer a video in the conversation area', () => {
    assert.equal(buildCss(withScope('chat'), { videoUrl: CLIP }), '');
    assert.equal(buildPlan(withScope('chat'), { videoUrl: CLIP }).script.includes('video-needs-page'), true, 'and says so to the launcher');
  });

  it('writes a skin per theme, or just the modes it has', () => {
    const sepia = defaultConfig();
    sepia.skin.preset = 'sepia';
    const preset = buildCss(sepia);
    assert.ok(preset.includes('.theme-zai-light {\n  --color-background: #f4ead8 !important;'));
    assert.ok(preset.includes('.theme-zai-dark {\n  --color-background: #1c1611 !important;'));
    for (const name of ['surface', 'panel', 'card', 'popover', 'sidebar', 'foreground', 'border', 'brand']) {
      assert.ok(preset.includes(`--color-${name}:`), name);
    }
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

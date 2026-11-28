// End to end against a real Chromium, not Electron: the same debugging channel, the same CSP as
// the ZCode shell, the same injection. What this proves about the protocol and the page side is
// the part the launcher cannot be trusted on without a window to talk to; the ZCode-specific
// parts (the startup switch, the conversation area's hook) are checked on the real app instead.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { CdpSession, findFreePort, listTargets } from '../src/cdp.mjs';
import { closeAll, syncTarget } from '../src/apply.mjs';
import { CHAT_ROOT, IMAGE_LAYER_ID, SHOWN, STYLE_ID, TINT_LAYER_ID, buildPlan } from '../src/css.mjs';
import { defaultConfig } from '../src/config.mjs';
import { supervise } from '../src/launcher.mjs';
import { PIXEL, findBrowser, startTestBrowser, until } from './helpers/browser.mjs';

const BROWSER = findBrowser();
const quiet = { info() {}, warn() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shellTarget = async (port) => (await listTargets(port)).find((target) => target.url.endsWith('/shell.html'));
const pageWith = (extra) => ({ ...defaultConfig(), background: { ...defaultConfig().background, ...extra } });
// The card the app draws in the conversation area: where the picture goes in that scope.
const CARD = '[data-testid="conversation"] > * > .bg-background';

describe('debugging channel against a real browser', { skip: BROWSER ? false : 'no Chrome or Edge found' }, () => {
  let world;
  const sessions = new Map();

  before(async () => {
    world = await startTestBrowser(BROWSER);
  });

  after(async () => {
    closeAll(sessions);
    await world.stop();
  });

  it('finds a free port by listening, and skips a busy one', async () => {
    const busy = http.createServer();
    const taken = await new Promise((resolve) => busy.listen(0, '127.0.0.1', () => resolve(busy.address().port)));
    try {
      const free = await findFreePort(taken - 1, { tries: 5 });
      assert.ok(Number.isInteger(free) && free > 0);
      assert.notEqual(free, taken);
    } finally {
      await new Promise((resolve) => busy.close(resolve));
    }
  });

  // The window the tests talk to, once its page is really there. A target shows up in the list
  // before its navigation commits, so a test that does not wait races the page load.
  const settled = async () => {
    const { session } = sessions.get((await shellTarget(world.port)).id);
    await until(() => session.evaluate(`document.readyState === 'complete' && !!document.getElementById('root')`), Boolean);
    return session;
  };

  it('injects the stylesheet under the shell CSP, and a reload gets it again', async () => {
    const plan = buildPlan(pageWith({ media: ['pixel.png'] }), { imageDataUrl: PIXEL });
    const opened = await world.openPage(world.pages.shell);
    const target = await until(() => listTargets(world.port), (list) => list.some((entry) => entry.id === opened.id)).then((list) => list.find((entry) => entry.id === opened.id));
    // Registering before the document exists is what the launcher does on a cold start; which
    // of the two paths applied the stylesheet is not the point, the page state is.
    await syncTarget(target, sessions, plan);
    const { session } = sessions.get(target.id);
    await until(() => session.evaluate(`document.readyState === 'complete' && !!document.getElementById(${JSON.stringify(STYLE_ID)})`), Boolean);
    // Right after the stylesheet lands nothing is see-through yet: the page script waits for
    // the app's colours, the theme and the picture (see the next test). Here the picture is a
    // pixel, so only the theme is missing, and after a second the script gives up waiting for
    // it: this page never names one.
    assert.equal(await session.evaluate(`document.documentElement.classList.contains(${JSON.stringify(SHOWN)})`), false, 'not shown at once');
    assert.equal(await session.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--color-background')`), '#fafafa', 'the app\'s own colour stays');
    await until(() => session.evaluate(`document.documentElement.classList.contains(${JSON.stringify(SHOWN)})`), Boolean, { timeoutMs: 4000 });

    assert.equal(await session.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--color-background')`), 'transparent');
    assert.equal(await session.evaluate(`document.body.style.getPropertyValue('--za-orig-background')`), '#fafafa');
    // Every base the window paints with has to go: the shell root's own (`bg-background-win-alt`)
    // once stayed opaque and hid the picture behind everything but the start-up screen.
    assert.equal(await session.evaluate(`getComputedStyle(document.querySelector('.bg-background-win-alt')).backgroundColor`), 'rgba(0, 0, 0, 0)');
    assert.equal(await session.evaluate(`getComputedStyle(document.querySelector('.bg-sidebar')).backgroundColor`), 'rgba(0, 0, 0, 0)');
    // The layers are laid out as intended: fixed, the whole viewport, the picture on the first.
    // (A selector missing its # once left these as two empty static divs, and nothing showed.)
    const layers = JSON.parse(await session.evaluate(`JSON.stringify(['${IMAGE_LAYER_ID}', '${TINT_LAYER_ID}'].map((id) => { const node = document.getElementById(id); const box = node.getBoundingClientRect(); const style = getComputedStyle(node); return [node !== null, style.position, style.zIndex, Math.round(box.width) === document.documentElement.clientWidth && Math.round(box.height) === innerHeight, Math.round(box.left) === 0 && Math.round(box.top) === 0, style.backgroundImage.startsWith('url("data:image/png;base64,'), style.backgroundImage.length]; }))`));
    assert.deepEqual(layers[0].slice(0, 6), [true, 'fixed', '-1', true, true, true]);
    assert.ok(layers[0][6] > 80, 'the picture itself is in the computed value');
    assert.deepEqual(layers[1].slice(0, 6), [true, 'fixed', '-1', true, true, false]);
    assert.equal(await session.evaluate(`document.body.firstChild === document.getElementById('${IMAGE_LAYER_ID}') && document.body.children[1].id === '${TINT_LAYER_ID}'`), true);
    // The tint is the base colour the app had, at the configured strength. Compared with an
    // element given that very mix, so neither the untouched colour nor a fallback would pass.
    const tint = await session.evaluate(`(() => { const probe = document.createElement('div'); probe.style.background = 'color-mix(in oklab, #fafafa 72%, transparent)'; document.body.appendChild(probe); const wanted = getComputedStyle(probe).backgroundColor; const actual = getComputedStyle(document.getElementById('${TINT_LAYER_ID}')).backgroundColor; probe.remove(); return [actual, wanted]; })()`);
    assert.equal(tint[0], tint[1]);
    // The picture really loads: the policy lets data: URLs through, which a file path would not be.
    const width = await session.evaluate(`new Promise((resolve) => { const image = new Image(); image.onload = () => resolve(image.naturalWidth); image.onerror = () => resolve('blocked'); image.src = ${JSON.stringify(PIXEL)}; })`, { awaitPromise: true });
    assert.equal(width, 1);

    // Nothing to do on the next poll. Then a reload: the registered script restores the stylesheet
    // before any page code runs, without the launcher sending it again.
    assert.equal(await syncTarget(await shellTarget(world.port), sessions, plan), null);
    // The start-up screen's logo breathes (by a transform, which the compositor animates: the
    // main thread is the app's while that screen is on); the shell's own animation, the app's
    // pop, is not touched. The screen is hidden in this page, so the names are what is read.
    const startup = JSON.parse(await session.evaluate(`JSON.stringify([getComputedStyle(document.querySelector('.startup-logo-shell')).animationName, getComputedStyle(document.querySelector('.startup-logo')).animationName, getComputedStyle(document.querySelector('.startup-logo')).transformOrigin, getComputedStyle(document.getElementById('loading')).transitionDuration, getComputedStyle(document.getElementById('root')).transitionDuration])`));
    assert.deepEqual(startup, ['fixture-pop', 'za-startup-breathe', '50% 50%', '0.36s', '0.3s'], 'the shell keeps the animation the page gave it');
    // When the page says the first screen is ready, the moment is kept for whoever asks.
    await session.evaluate(`document.body.classList.add('zcode-startup-ready')`);
    await until(() => session.evaluate(`window.__zcodeAppearance.readyAt`), (value) => Number.isInteger(value) && value >= 0);
    await session.evaluate(`document.body.classList.remove('zcode-startup-ready')`);
    const loaded = new Promise((resolve) => session.on('Page.loadEventFired', resolve));
    await session.send('Page.reload');
    await loaded;
    await until(() => session.evaluate(`document.getElementById(${JSON.stringify(STYLE_ID)}) !== null`), Boolean);
    assert.equal(await session.evaluate(plan.check), 'ok');
    assert.equal(await syncTarget(await shellTarget(world.port), sessions, plan), null);
  });

  it('keeps the app\'s own colours until the theme and the picture are known, then goes see-through with the right tint', async () => {
    // A stylesheet that lands before the app has named its theme made the window see-through at
    // once, under the light theme's tint (the fallback until the theme is known): a white flash
    // at every start. A fresh page, as at a start.
    const plan = buildPlan(pageWith({ media: ['pixel.png'], mask: 0.5 }), { imageDataUrl: PIXEL });
    const opened = await world.openPage(world.pages.shell);
    const target = await until(() => listTargets(world.port), (list) => list.some((entry) => entry.id === opened.id)).then((list) => list.find((entry) => entry.id === opened.id));
    assert.equal(await syncTarget(target, sessions, plan), 'applied');
    const { session } = sessions.get(target.id);
    try {
      await until(() => session.evaluate(`document.readyState === 'complete' && !!document.getElementById(${JSON.stringify(STYLE_ID)})`), Boolean);
      // The picture is a pixel and decodes at once, and the colours are read at once: only the
      // theme is missing here, and a moment on nothing is see-through.
      await sleep(300);
      assert.equal(await session.evaluate(`document.documentElement.classList.contains(${JSON.stringify(SHOWN)})`), false, 'waits for the theme');
      assert.equal(await session.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--color-background')`), '#fafafa', 'the app\'s own colour stays');
      // The app names its theme (the class it puts on <html>): shown now, and the tint is mixed
      // from the dark theme's base colour, read while our stylesheet was out of the document —
      // not from the `transparent` our own rule writes.
      await session.evaluate(`document.documentElement.classList.add('theme-zai-dark')`);
      await until(() => session.evaluate(`document.documentElement.classList.contains(${JSON.stringify(SHOWN)})`), Boolean, { timeoutMs: 4000 });
      assert.equal(await session.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--color-background')`), 'transparent');
      assert.equal(await session.evaluate(`document.body.style.getPropertyValue('--za-orig-background')`), '#0a0a0a');
      const tint = await session.evaluate(`(() => { const probe = document.createElement('div'); probe.style.background = 'color-mix(in oklab, #0a0a0a 50%, transparent)'; document.body.appendChild(probe); const wanted = getComputedStyle(probe).backgroundColor; const actual = getComputedStyle(document.getElementById('${TINT_LAYER_ID}')).backgroundColor; probe.remove(); return [actual, wanted]; })()`);
      assert.equal(tint[0], tint[1]);
    } finally {
      // A second page hides the first; the video tests after this one need theirs visible.
      await session.send('Page.close').catch(() => {});
      sessions.delete(target.id);
    }
  });

  it('reads the app\'s colours with the stylesheet out of the document, on the retries too', async () => {
    // At a cold start the stylesheet lands before the app's own stylesheet is parsed: nothing
    // to read from yet, and the page script tries again later. Reading with our stylesheet in,
    // it read back the `transparent` our own rule writes, and the tint stayed invisible until
    // the next theme change.
    const plan = buildPlan(pageWith({ media: ['pixel.png'] }), { imageDataUrl: PIXEL });
    const opened = await world.openPage(world.pages.shell);
    const target = await until(() => listTargets(world.port), (list) => list.some((entry) => entry.id === opened.id)).then((list) => list.find((entry) => entry.id === opened.id));
    await syncTarget(target, sessions, plan).catch(() => {});
    const live = sessions.get(target.id).session;
    try {
      await until(() => live.evaluate(`document.readyState === 'complete'`), Boolean);
      // The app's colours are not there yet…
      await live.evaluate(`window.__fixtureStyle = document.querySelector('style'); window.__fixtureStyle.remove(); true`);
      assert.equal(await syncTarget(target, sessions, buildPlan(pageWith({ media: ['pixel.png'], mask: 0.4 }), { imageDataUrl: PIXEL })), 'applied');
      // …and come a moment later, as the app's stylesheet does.
      await sleep(100);
      await live.evaluate(`document.head.appendChild(window.__fixtureStyle); true`);
      await until(() => live.evaluate(`document.body.style.getPropertyValue('--za-orig-background')`), (value) => value === '#fafafa', { timeoutMs: 4000 });
      assert.notEqual(await live.evaluate(`document.body.style.getPropertyValue('--za-orig-background')`), 'transparent');
    } finally {
      await live.send('Page.close').catch(() => {});
      sessions.delete(target.id);
    }
  });

  it('gives up waiting for colours that never come, and shows the picture under the fallback tint', async () => {
    // A build that names its colours differently must not keep its window without the picture
    // for good: after five seconds the tint uses the fallback for the theme.
    const plan = buildPlan(pageWith({ media: ['pixel.png'] }), { imageDataUrl: PIXEL });
    const opened = await world.openPage(world.pages.shell);
    const target = await until(() => listTargets(world.port), (list) => list.some((entry) => entry.id === opened.id)).then((list) => list.find((entry) => entry.id === opened.id));
    await syncTarget(target, sessions, plan).catch(() => {});
    const live = sessions.get(target.id).session;
    try {
      await until(() => live.evaluate(`document.readyState === 'complete'`), Boolean);
      await live.evaluate(`document.querySelector('style').remove(); ['background', 'surface', 'panel', 'sidebar', 'card', 'popover'].forEach((name) => document.body.style.removeProperty('--za-orig-' + name)); true`);
      assert.equal(await syncTarget(target, sessions, buildPlan(pageWith({ media: ['pixel.png'], mask: 0.3 }), { imageDataUrl: PIXEL })), 'applied');
      await sleep(3000);
      assert.equal(await live.evaluate(`document.documentElement.classList.contains(${JSON.stringify(SHOWN)})`), false, 'not yet: the theme and picture waits are over, the colours one is not');
      await until(() => live.evaluate(`document.documentElement.classList.contains(${JSON.stringify(SHOWN)})`), Boolean, { timeoutMs: 4000 });
      assert.equal(await live.evaluate(`document.body.style.getPropertyValue('--za-orig-background')`), '', 'no colours were ever read');
      const tint = await live.evaluate(`(() => { const probe = document.createElement('div'); probe.style.background = 'color-mix(in oklab, #f4f4f5 30%, transparent)'; document.body.appendChild(probe); const wanted = getComputedStyle(probe).backgroundColor; const actual = getComputedStyle(document.getElementById('${TINT_LAYER_ID}')).backgroundColor; probe.remove(); return [actual, wanted]; })()`);
      assert.equal(tint[0], tint[1], 'the light fallback: this page names no theme');
    } finally {
      await live.send('Page.close').catch(() => {});
      sessions.delete(target.id);
    }
  });

  it('shows the picture in the conversation area on a page of its own, and keeps the newest plan when a class changes', async () => {
    // Two things a page that had a page-scope plan first would hide: the conversation scope's
    // rules wait for the page script's word too, and that scope has no layer to wait for; and
    // the observer that re-reads the colours on a class change must re-insert the newest plan,
    // not the first one the page was given.
    const opened = await world.openPage(world.pages.shell);
    const target = await until(() => listTargets(world.port), (list) => list.some((entry) => entry.id === opened.id)).then((list) => list.find((entry) => entry.id === opened.id));
    assert.equal(await syncTarget(target, sessions, buildPlan(pageWith({ scope: 'chat', mask: 0.5 }), { imageDataUrl: PIXEL })), 'applied');
    const { session } = sessions.get(target.id);
    try {
      await until(() => session.evaluate(`document.readyState === 'complete'`), Boolean);
      await until(() => session.evaluate(`document.documentElement.classList.contains(${JSON.stringify(SHOWN)})`), Boolean, { timeoutMs: 4000 });
      assert.match(await session.evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(CARD)})).backgroundImage`), /^url\("data:image\/png;base64,/, 'the card carries the picture');
      // A newer plan, then a class change on the body (the window losing focus does that).
      assert.equal(await syncTarget(target, sessions, buildPlan(pageWith({ scope: 'chat', mask: 0.6 }), { imageDataUrl: PIXEL })), 'applied');
      const before = await session.evaluate(`window.__zcodeAppearance.repaints`);
      await session.evaluate(`document.body.classList.add('inactive')`);
      await until(() => session.evaluate(`window.__zcodeAppearance.repaints`), (count) => count > before);
      await sleep(120);
      const tint = await session.evaluate(`(() => { const probe = document.createElement('div'); probe.style.background = 'color-mix(in oklab, #fafafa 60%, transparent)'; document.body.appendChild(probe); const newest = getComputedStyle(probe).backgroundColor; probe.style.background = 'color-mix(in oklab, #fafafa 50%, transparent)'; const older = getComputedStyle(probe).backgroundColor; const actual = getComputedStyle(document.querySelector(${JSON.stringify(CARD)}), '::before').backgroundColor; probe.remove(); return [actual, newest, older]; })()`);
      assert.equal(tint[0], tint[1], 'the newest plan is in force after the class change');
      assert.notEqual(tint[0], tint[2], 'not the one before it');
      assert.equal(await session.evaluate(`document.getElementById(${JSON.stringify(STYLE_ID)}).textContent.includes('60%, transparent')`), true);
    } finally {
      await session.send('Page.close').catch(() => {});
      sessions.delete(target.id);
    }
  });

  it('switches to the conversation area when the plan changes', async () => {
    await settled();
    const plan = buildPlan(pageWith({ scope: 'chat', mask: 0.5 }), { imageDataUrl: PIXEL });
    assert.equal(await syncTarget(await shellTarget(world.port), sessions, plan), 'applied');
    const { session } = sessions.get((await shellTarget(world.port)).id);
    // The area's rules too wait for the page script's word; this page names no theme, so it
    // comes after the second the script gives the theme.
    await until(() => session.evaluate(`document.documentElement.classList.contains(${JSON.stringify(SHOWN)})`), Boolean, { timeoutMs: 4000 });
    assert.equal(await session.evaluate(`document.getElementById(${JSON.stringify(IMAGE_LAYER_ID)}) === null`), true);
    // The card the app draws in the area carries the picture and no longer paints over it; the
    // area itself paints nothing. Where there is no such card, the area itself carries it.
    const CARD = '[data-testid="conversation"] > * > .bg-background';
    const chat = JSON.parse(await session.evaluate(`(() => {
      const card = document.querySelector(${JSON.stringify(CARD)});
      const probe = document.createElement('div');
      probe.style.background = 'color-mix(in oklab, #fafafa 50%, transparent)';
      document.body.appendChild(probe);
      const tint = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return JSON.stringify([getComputedStyle(card).backgroundImage, getComputedStyle(card).backgroundAttachment, getComputedStyle(card).backgroundColor, getComputedStyle(card, '::before').backgroundColor, getComputedStyle(card, '::before').zIndex, getComputedStyle(document.querySelector('[data-testid="conversation"]')).backgroundImage, getComputedStyle(document.querySelector('[data-testid="chat-view"]')).backgroundImage, getComputedStyle(document.documentElement).getPropertyValue('--color-background'), getComputedStyle(document.querySelector('.bg-background-win-alt')).backgroundColor, tint]);
    })()`));
    const [image, attachment, cardBase, tintLayer, tintPlace, area, flat, baseColour, rootAlt, tint] = chat;
    assert.match(image, /^url\("data:image\/png;base64,/, `the picture, and nothing else, in the declaration (${image.slice(0, 90)})`);
    assert.equal(attachment, 'fixed');
    // The card's base colour went see-through inside the area; with it left opaque the card
    // covered the picture, and on the real app the scope looked as if nothing had happened.
    assert.equal(cardBase, 'rgba(0, 0, 0, 0)');
    // The tint is a layer of its own over the picture and under the writing.
    assert.equal(tintLayer, tint);
    assert.equal(tintPlace, '-1');
    assert.equal(area, 'none');
    assert.match(flat, /^url\("data:image\/png;base64,/, 'an area that is a painted box itself carries the picture');
    // The conversation area alone: the rest of the window keeps the app's own colours, the
    // shell root's base included.
    assert.equal(baseColour.trim(), '#fafafa');
    assert.equal(rootAlt, 'rgb(228, 228, 231)');
    assert.equal(await session.evaluate(plan.check), 'ok');
  });

  it('keeps a picture of a few megabytes in the conversation area', async () => {
    // The picture a person actually uses: noise, which does not compress, drawn by the browser
    // itself and handed back as a data URL of about the size of a photograph.
    const big = await (async () => {
      const target = await shellTarget(world.port);
      const { session } = sessions.get(target.id);
      return session.evaluate(`(() => { const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 700; const context = canvas.getContext('2d'); const picture = context.createImageData(canvas.width, canvas.height); let seed = 123456789; const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; }; for (let i = 0; i < picture.data.length; i += 4) { const value = next(); picture.data[i] = value & 255; picture.data[i + 1] = (value >>> 8) & 255; picture.data[i + 2] = (value >>> 16) & 255; picture.data[i + 3] = 255; } context.putImageData(picture, 0, 0); return canvas.toDataURL('image/png'); })()`);
    })();
    assert.ok(big.length > 2_000_000, `the picture is ${Math.round(big.length / 1e6 * 10) / 10} MB as a data URL, as a photograph is (${String(big).slice(0, 60)})`);
    const plan = buildPlan(pageWith({ scope: 'chat', mask: 0.5 }), { imageDataUrl: big });
    assert.equal(await syncTarget(await shellTarget(world.port), sessions, plan), 'applied');
    const { session } = sessions.get((await shellTarget(world.port)).id);
    await until(() => session.evaluate(`getComputedStyle(document.querySelector('[data-testid="conversation"] > * > .bg-background')).backgroundImage.startsWith('url("data:image/png;base64,')`), Boolean, { timeoutMs: 8000 });
    const image = await session.evaluate(`getComputedStyle(document.querySelector('[data-testid="conversation"] > * > .bg-background')).backgroundImage`);
    assert.ok(image.startsWith(`url("${big}")`), `the whole picture is in the computed value (beside a var() it used to be dropped, and nothing showed): computed ${image.length} characters, picture ${big.length}; starts ${image.slice(0, 40)} ends ${image.slice(-30)}`);
  });

  it('reports a missing conversation area instead of failing silently', async () => {
    const target = await shellTarget(world.port);
    await sessions.get(target.id).session.evaluate(`document.querySelectorAll(${JSON.stringify(CHAT_ROOT)}).forEach((node) => node.removeAttribute('data-testid'))`);
    // A different picture makes it a different plan, so the window is brought up to date again.
    const plan = buildPlan(pageWith({ scope: 'chat' }), { imageDataUrl: `${PIXEL}=` });
    assert.equal(await syncTarget(target, sessions, plan), 'missing-root');
  });

  it('leaves a window without the app root alone, and does not keep asking', async () => {
    const plan = buildPlan(defaultConfig(), { imageDataUrl: PIXEL });
    const opened = await world.openPage(world.pages.other);
    const target = await until(() => listTargets(world.port), (list) => list.some((entry) => entry.id === opened.id)).then((list) => list.find((entry) => entry.id === opened.id));
    assert.equal(await syncTarget(target, sessions, plan), 'waiting');
    const { session } = sessions.get(target.id);
    await until(() => session.evaluate(`document.readyState === 'complete' && !!document.querySelector('h1')`), Boolean);
    await sleep(300);
    assert.equal(await session.evaluate(`document.getElementById(${JSON.stringify(STYLE_ID)}) === null`), true);
    assert.equal(await session.evaluate(`document.getElementById(${JSON.stringify(IMAGE_LAYER_ID)}) === null`), true);
    // Once the wait for the app to mount has run out, the stylesheet is not sent again on every
    // poll (it used to be, every ten seconds, picture and all), and the window stays untouched.
    await sleep(10400);
    assert.equal(await syncTarget(target, sessions, plan), null, 'not sent again');
    assert.equal(await session.evaluate(plan.check), 'ok');
    assert.equal(await session.evaluate(`document.getElementById(${JSON.stringify(STYLE_ID)}) === null`), true);
  });

  it('leaves a page from the web alone, even one that mounts the app root', async () => {
    const plan = buildPlan(pageWith({ media: ['pixel.png'] }), { imageDataUrl: PIXEL });
    const opened = await world.openPage(world.pages.remote);
    // It loads like any page; the launcher's own list of windows just never names it.
    await until(() => world.rawTargets(), (list) => list.some((entry) => entry.id === opened.id));
    const remote = await CdpSession.connect(opened.webSocketDebuggerUrl);
    try {
      await until(() => remote.evaluate(`document.readyState === 'complete' && !!document.getElementById('root')`), Boolean);
      assert.equal((await listTargets(world.port)).some((entry) => entry.id === opened.id), false, 'not a window the launcher talks to');
      await supervise({ port: world.port, getPlan: async () => plan, shouldStop: () => false, logger: quiet, once: true, sessions: new Map() });
      assert.equal(await remote.evaluate(`document.getElementById(${JSON.stringify(STYLE_ID)}) === null && typeof window.__zcodeAppearance === 'undefined'`), true, 'nothing of the launcher reached it');
    } finally {
      remote.close();
    }
  });
});

// The launcher's loop against a real browser, a real config file and the real folder watch:
// it has to notice a change on disk by itself and at once, bring every window up to date, play
// a video as an element, and know when it is done.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { closeAll, syncTarget } from '../src/apply.mjs';
import { CdpSession, listTargets } from '../src/cdp.mjs';
import { CHAT_ROOT, IMAGE_LAYER_ID, buildPlan } from '../src/css.mjs';
import { saveConfig } from '../src/config.mjs';
import { createPlanSource, supervise } from '../src/launcher.mjs';
import { PIXEL, VIDEO, findBrowser, startTestBrowser, until } from './helpers/browser.mjs';

const BROWSER = findBrowser();
const PNG_BYTES = Buffer.from(PIXEL.split(',')[1], 'base64');
const CLIP_BYTES = Buffer.from(fs.readFileSync(new URL('./fixtures/tiny.webm.base64', import.meta.url), 'utf8').trim(), 'base64');
const quiet = { info() {}, warn() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A config in a directory of its own with real picture and video files next to it. The second
// picture has other bytes: two identical pictures would give two identical stylesheets.
function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appearance-home-'));
  fs.writeFileSync(path.join(dir, 'first.png'), PNG_BYTES);
  fs.writeFileSync(path.join(dir, 'second.png'), Buffer.concat([PNG_BYTES, Buffer.from([0])]));
  fs.writeFileSync(path.join(dir, 'clip.webm'), CLIP_BYTES);
  const file = path.join(dir, 'appearance.json');
  const write = (background) => saveConfig({
    background: {
      enabled: true,
      media: [path.join(dir, 'first.png'), path.join(dir, 'second.png')],
      scope: 'page',
      rotateMinutes: 0,
      mask: 0.72,
      blur: 0,
      ...background,
    },
    skin: { preset: 'default', custom: null },
    launcher: { zcodePath: null, port: 9337 },
  }, { file });
  write({});
  return { dir, file, write };
}

const readIn = async (port, expression) => {
  const target = (await listTargets(port)).find((entry) => entry.url.endsWith('/shell'));
  const session = await CdpSession.connect(target.webSocketDebuggerUrl);
  try {
    await session.send('Page.enable');
    return await session.evaluate(expression);
  } finally {
    session.close();
  }
};
const layerIn = (port) => readIn(port, `document.getElementById(${JSON.stringify(IMAGE_LAYER_ID)}) !== null`);
const chatIn = (port) => readIn(port, `getComputedStyle(document.querySelector(${JSON.stringify(CHAT_ROOT)})).backgroundImage.includes('data:image/png')`);

describe('launcher loop against a real browser', { skip: BROWSER ? false : 'no Chrome or Edge found' }, () => {
  let world;
  let home;
  const sessions = new Map();

  before(async () => {
    world = await startTestBrowser(BROWSER);
    home = makeHome();
    await world.openPage(`${world.base}/shell`);
  });

  after(async () => {
    closeAll(sessions);
    await world.stop();
    fs.rmSync(home.dir, { recursive: true, force: true });
  });

  it('applies the file once and returns when asked to', async () => {
    const source = createPlanSource({ file: home.file, logger: quiet });
    await supervise({ port: world.port, getPlan: source.getPlan, shouldStop: () => false, logger: quiet, pollMs: 100, once: true, sessions });
    await until(() => layerIn(world.port), Boolean);
    source.stop();
  });

  it('follows a change to the file the moment it is written, not at the next tick', async () => {
    const source = createPlanSource({ file: home.file, logger: quiet });
    let stop = false;
    // A long interval on purpose: if the change were noticed only by the tick this would take 5 s.
    const loop = supervise({ port: world.port, getPlan: source.getPlan, shouldStop: () => stop, logger: quiet, pollMs: 5000, wake: () => source.change(), sessions });
    await until(() => layerIn(world.port), Boolean);
    const written = Date.now();
    home.write({ scope: 'chat', mask: 0.4 });
    await until(() => chatIn(world.port), Boolean, { timeoutMs: 8000 });
    const lag = Date.now() - written;
    assert.ok(lag < 2500, `the window showed the change ${lag} ms after the file was written`);
    assert.equal(await layerIn(world.port), false, 'the full-window layers are gone in chat scope');
    stop = true;
    await loop;
    source.stop();
  });

  it('keeps the last good settings while the file is wrong, and recovers', async () => {
    home.write({ mask: 0.72, scope: 'page' });
    const warnings = [];
    const logger = { info() {}, warn: (message) => warnings.push(message) };
    const source = createPlanSource({ file: home.file, logger });
    const good = await source.getPlan();
    await sleep(30);
    fs.writeFileSync(home.file, '{ "background": ');
    // The real watch reports the broken file; the plan stays the one from before.
    await until(() => source.getPlan().then((plan) => plan.key === good.key && warnings.length > 0), Boolean, { timeoutMs: 5000 });
    assert.equal((await source.getPlan()).key, good.key);
    assert.equal(warnings.length, 1, 'and it says so once');
    assert.match(warnings[0], /not valid JSON/);
    await sleep(30);
    home.write({ mask: 0.1 });
    const repaired = await until(() => source.getPlan().then((plan) => (plan.key === good.key ? null : plan)), Boolean, { timeoutMs: 5000 });
    assert.ok(repaired.css.includes('10%, transparent'));
    source.stop();
  });

  it('plays a video as an element in the picture layer, and swaps back to a picture', async () => {
    const config = { background: { enabled: true, media: [], scope: 'page', rotateMinutes: 0, mask: 0.72, blur: 0 }, skin: { preset: 'default', custom: null }, launcher: { zcodePath: null, port: 9337 } };
    const target = (await listTargets(world.port)).find((entry) => entry.url.endsWith('/shell'));
    const video = buildPlan(config, { videoUrl: VIDEO });
    assert.equal(await syncTarget(target, sessions, video, { log: quiet.info }), 'applied');
    const facts = JSON.parse(await readIn(world.port, `(() => { const v = document.getElementById(${JSON.stringify(IMAGE_LAYER_ID)}); return JSON.stringify([v.tagName, v.muted, v.loop, v.getAttribute('src').slice(0, 22), document.body.firstChild === v, document.body.children[1].id]); })()`));
    assert.deepEqual(facts, ['VIDEO', true, true, 'data:video/webm;base64', true, 'zcode-appearance-tint']);
    // Decoded and playing: a 16x16 frame, not paused. (The video is muted, so no click is needed.)
    await until(() => readIn(world.port, `(() => { const v = document.getElementById(${JSON.stringify(IMAGE_LAYER_ID)}); return v.videoWidth === 16 && !v.paused; })()`), Boolean, { timeoutMs: 6000 });
    // Back to a picture: the element is a plain layer again, and the video is gone.
    const picture = buildPlan(config, { imageDataUrl: PIXEL });
    await syncTarget(target, sessions, picture, { log: quiet.info });
    assert.deepEqual(JSON.parse(await readIn(world.port, `JSON.stringify([document.getElementById(${JSON.stringify(IMAGE_LAYER_ID)}).tagName, document.querySelectorAll('video').length])`)), ['DIV', 0]);
  });
});

// What the view's page is made of, read from its source. The view shows paths and file names
// that come from the settings file and from the system's file dialog, and it runs in a sandbox
// whose policy is the host's. So it has no way of turning text into markup or code, and it talks
// to nobody but the extension. Pinned here: a rendering test passes just the same once one of
// these appears, and the first sign is a path that renders as markup.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const PAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui', 'index.html');
// The one URL in the page: it names the SVG vocabulary and is never requested.
const NAMESPACES = ['http://www.w3.org/2000/svg'];

describe('what the view\'s page is made of', () => {
  const source = fs.readFileSync(PAGE, 'utf8');

  it('has no way of turning text into markup or code', () => {
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'new AsyncFunction', 'setTimeout("', 'setInterval("']) {
      assert.equal(source.includes(sink), false, sink);
    }
    assert.equal(/<[a-z][^>]*\son[a-z]+\s*=/i.test(source), false, 'an inline event handler');
    assert.equal(/javascript:/i.test(source), false, 'a javascript: URL');
  });

  it('talks to nobody but the extension', () => {
    for (const call of ['fetch(', 'XMLHttpRequest', 'WebSocket(', 'EventSource(', 'sendBeacon', 'postMessage(', 'importScripts', '@import', '<img', '<iframe', '<link', '<script src', 'srcset']) {
      assert.equal(source.includes(call), false, call);
    }
    const urls = [...new Set([...source.matchAll(/\bhttps?:\/\/[^\s"'`)>]+/g)].map((match) => match[0]))];
    assert.deepEqual(urls, NAMESPACES);
  });

  it('carries the official sandbox stylesheet whole and unedited', () => {
    // The app gives its own views out/plugin-sandbox/visualize.css; this view is to look the
    // same, so the first <style> is that file, copied whole after its header comment. The
    // fixture is the copy the test compares with: when ZCode changes its sheet, copy again
    // (.tmp/bg/splice-full.mjs) rather than edit a rule here.
    const text = source.replace(/\r\n/g, '\n');
    const open = text.indexOf('<style id="zcode-contract">');
    const end = text.indexOf('</style>', open);
    assert.ok(open !== -1 && end !== -1, 'the contract block is there');
    const block = text.slice(open, end);
    const body = block.slice(block.indexOf('*/') + 2).replace(/^\n/, '');
    const sheet = fs.readFileSync(path.join(path.dirname(PAGE), '..', 'tests', 'fixtures', 'visualize.css'), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(body, sheet, 'the block after its header is the fixture, byte for byte');
    assert.ok(sheet.includes('.form-switch .form-check-input:checked') && sheet.includes('.form-range::-webkit-slider-thumb'), 'the fixture is the official sheet with its components');
  });
});

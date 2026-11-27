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
});

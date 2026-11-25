// The icons of the storage view (ui/index.html) are Lucide's own files, inlined. The sandbox
// gives an extension view no icon library, so the page carries the symbols itself; ui/icons/
// holds the files they were taken from. This holds the two together, without parsing anything:
// each file's markup, as a run of text, has to be in the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGE = fs.readFileSync(path.join(PLUGIN, 'ui', 'index.html'), 'utf8');
const ICONS = path.join(PLUGIN, 'ui', 'icons');
const oneLine = (text) => text.replace(/\s+/g, ' ').trim();
const names = fs.readdirSync(ICONS).filter((file) => file.endsWith('.svg')).map((file) => path.basename(file, '.svg')).sort();

test('every icon in ui/icons is Lucide\'s file, at one known version, and is in the page word for word', () => {
  assert.deepEqual(names, ['copy', 'database', 'file-text', 'folder', 'folder-open', 'map-pin', 'refresh-cw', 'trash-2']);
  const page = oneLine(PAGE);
  for (const name of names) {
    const file = fs.readFileSync(path.join(ICONS, `${name}.svg`), 'utf8');
    assert.match(file, /^<!-- @license lucide-static v0\.468\.0 - ISC -->/, `${name}: where it came from`);
    const inner = oneLine(file.replace(/^<!--[\s\S]*?-->/, '').match(/<svg[^>]*>([\s\S]*)<\/svg>/)[1]);
    assert.match(inner, /^(<[a-z]+ [\s\S]+)$/, `${name}: the drawing, nothing else`);
    assert.ok(page.includes(`<symbol id="codegraph-icon-${name}" viewBox="0 0 24 24"> ${inner} </symbol>`), `${name}: in the page as it is in the file`);
  }
  // The ISC license asks for its notice to travel with the files.
  const license = fs.readFileSync(path.join(ICONS, 'LICENSE.lucide.txt'), 'utf8');
  assert.match(license, /^ISC License\n/);
  assert.match(license, /Lucide Contributors 2022/);
  assert.match(license, /Permission to use, copy, modify, and\/or distribute this software/);
});

test('the page uses each symbol through an icon that is 24 units wide, drawn in the text colour, and hidden from assistive technology', () => {
  const uses = [...PAGE.matchAll(/<svg class="storage-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><use href="#codegraph-icon-([a-z0-9-]+)"><\/use><\/svg>/g)].map((match) => match[1]);
  assert.ok(uses.length >= 8, `${uses.length} icons drawn`);
  for (const name of uses) assert.ok(names.includes(name), `${name}: a symbol that exists`);
  // Nothing in the page may name an icon any other way.
  const everyUse = [...PAGE.matchAll(/<use href="#([^"]+)"/g)].length;
  assert.equal(everyUse, uses.length, 'every use of a symbol is one of these icons');
  assert.equal(PAGE.includes('data-lucide'), false, 'the sandbox has no Lucide runtime to answer that attribute');
  assert.equal(/<svg(?![^>]*aria-hidden="true")[^>]*>/.test(PAGE), false, 'every svg is marked as decoration');
});

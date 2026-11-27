// The icon symbols inlined in the view are the drawings of the files in ui/icons/, attribute
// for attribute where it matters, so that an edit to one shows up as a difference in the other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui');
const page = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const files = fs.readdirSync(path.join(UI, 'icons')).filter((file) => file.endsWith('.svg')).sort();

test('every icon file is inlined once, as a symbol, and nothing else is', () => {
  assert.ok(files.length >= 7, `only ${files.length} icon files`);
  const symbols = [...page.matchAll(/<symbol id="appearance-icon-([a-z0-9-]+)" viewBox="0 0 24 24">/g)].map((match) => match[1]).sort();
  assert.deepEqual(symbols, files.map((file) => file.slice(0, -4)));
});

test('each symbol is the drawing of its file', () => {
  for (const file of files) {
    const name = file.slice(0, -4);
    const svg = fs.readFileSync(path.join(UI, 'icons', file), 'utf8').replace(/\r\n/g, '\n');
    const drawing = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(svg)[1].trim();
    const symbol = new RegExp(`<symbol id="appearance-icon-${name}" viewBox="0 0 24 24">\\n([\\s\\S]*?)\\n  </symbol>`).exec(page);
    assert.ok(symbol, `${name} has no symbol in the page`);
    assert.equal(symbol[1], drawing.split('\n').map((line) => `    ${line.trim()}`).join('\n'), `${name} differs from ui/icons/${file}`);
  }
});

test('the files are Lucide\'s own: the license header, the 24 grid, drawn in the current colour', () => {
  for (const file of files) {
    const svg = fs.readFileSync(path.join(UI, 'icons', file), 'utf8');
    assert.match(svg, /@license lucde|@license lucide/, file);
    assert.ok(svg.includes('viewBox="0 0 24 24"') && svg.includes('stroke="currentColor"') && svg.includes('stroke-width="2"'), file);
    assert.doesNotMatch(svg, /<script|<foreignObject|href="http|xlink:href/i, `${file} carries more than a drawing`);
  }
  assert.ok(fs.readFileSync(path.join(UI, 'icons', 'LICENSE.lucide.txt'), 'utf8').startsWith('ISC License'));
});

test('every icon the page uses has a symbol, and nothing uses an icon that is not there', () => {
  const used = [...page.matchAll(/<use href="#appearance-icon-([a-z0-9-]+)"><\/use>/g)].map((match) => match[1]).sort();
  const built = [...page.matchAll(/`#appearance-icon-\$\{name\}`/g)].length;
  assert.ok(built === 1, 'the page builds one icon reference from data (a file\'s kind)');
  for (const name of used) assert.ok(files.includes(`${name}.svg`), `#${name} is used but has no file`);
  for (const file of files) assert.ok(used.includes(file.slice(0, -4)) || ['image', 'film', 'trash-2'].includes(file.slice(0, -4)), `${file} is inlined but never used`);
});

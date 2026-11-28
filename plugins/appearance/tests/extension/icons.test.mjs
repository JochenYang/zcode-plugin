// The icon symbols inlined in the view are the drawings of the files in ui/icons/, attribute
// for attribute where it matters, so that an edit to one shows up as a difference in the other.
// Nothing references the sprite: the page copies a drawing when it draws one, and the icons in
// its markup carry theirs inline. (A <use> into the hidden sprite now and then came up empty in
// the app's sandbox until something repainted.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui');
const page = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const files = fs.readdirSync(path.join(UI, 'icons')).filter((file) => file.endsWith('.svg')).sort();
const symbols = [...page.matchAll(/<symbol id="appearance-icon-([a-z0-9-]+)" viewBox="0 0 24 24">\n([\s\S]*?)\n  <\/symbol>/g)];

test('every icon file is inlined once, as a symbol, and nothing else is', () => {
  assert.ok(files.length >= 7, `only ${files.length} icon files`);
  assert.deepEqual(symbols.map((match) => match[1]).sort(), files.map((file) => file.slice(0, -4)));
});

test('each symbol is the drawing of its file', () => {
  for (const file of files) {
    const name = file.slice(0, -4);
    const svg = fs.readFileSync(path.join(UI, 'icons', file), 'utf8').replace(/\r\n/g, '\n');
    const drawing = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(svg)[1].trim();
    const symbol = symbols.find((match) => match[1] === name);
    assert.ok(symbol, `${name} has no symbol in the page`);
    assert.equal(symbol[2], drawing.split('\n').map((line) => `    ${line.trim()}`).join('\n'), `${name} differs from ui/icons/${file}`);
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

test('every icon is drawn from a symbol, and nothing draws an icon that is not there', () => {
  assert.equal(/<use href="#appearance-icon-/.test(page), false, 'a reference into the sprite is left in the markup');
  assert.equal(page.match(/getElementById\(`appearance-icon-\$\{name\}`\)/g)?.length, 1, 'the page copies one drawing by name, when it draws a row');
  // The names the page asks for by hand, and the two it chooses between for a file's kind.
  const names = [...page.matchAll(/\bicon\('([a-z0-9-]+)'\)/g)].map((match) => match[1]);
  const kinds = /icon\(item\.kind === 'video' \? 'film' : 'image'\)/.test(page) ? ['film', 'image'] : [];
  for (const name of [...names, ...kinds]) assert.ok(files.includes(`${name}.svg`), `icon('${name}') has no file`);
  // The icons in the page's own markup carry their drawing inline: the first line of the
  // symbol appears once more outside the sprite.
  const outside = page.replace(/<svg aria-hidden="true" focusable="false" hidden>[\s\S]*?<\/svg>/, '');
  for (const file of files) {
    const name = file.slice(0, -4);
    const firstLine = symbols.find((match) => match[1] === name)[2].split('\n')[0].trim();
    assert.ok(names.includes(name) || kinds.includes(name) || outside.includes(firstLine), `${file} is inlined but never drawn`);
  }
});

// lstat over many paths, and the rule that a link is never followed (CONTRACTS.md §9): the
// target of a link can be outside the project or loop, so nothing reached through one is indexed.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { statMany, underLink, isLinkDir } from '../../src/index/fsstat.mjs';
import { scratchDir, rmrf } from './_helpers.mjs';

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmrf(d);
});
// A directory link can be made without a privilege on every platform this runs on; a link to a
// file needs one on Windows, where this suite runs without it.
function linkedDir() {
  const base = scratchDir('fsstat');
  dirs.push(base);
  const root = path.join(base, 'project');
  const elsewhere = path.join(base, 'elsewhere');
  fs.mkdirSync(root);
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, 'hidden.ts'), 'export const hidden = 1;\n');
  fs.writeFileSync(path.join(root, 'main.ts'), 'export const main = 1;\n');
  fs.symlinkSync(elsewhere, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  return { root, main: path.join(root, 'main.ts'), link: path.join(root, 'linked'), hidden: path.join(root, 'linked', 'hidden.ts') };
}

describe('statMany', () => {
  test('is an lstat: a link is reported as a link, never as what it points at; a missing path is absent', async () => {
    const { root, main, link } = linkedDir();
    const stats = await statMany([main, link, path.join(root, 'gone.ts')]);
    assert.equal(stats.get(main)?.isFile(), true);
    assert.equal(stats.get(link)?.isSymbolicLink(), true);
    assert.equal(stats.get(link)?.isDirectory(), false, 'not followed');
    assert.equal(stats.has(path.join(root, 'gone.ts')), false);
  });
});

describe('underLink', () => {
  test('a file behind a directory link is reached through one; a file of the project is not; the root is not looked at', () => {
    const { root, main, link, hidden } = linkedDir();
    assert.equal(underLink(root, hidden), true);
    assert.equal(underLink(root, path.join(link, 'deeper', 'x.ts')), true, 'at any depth below the link');
    assert.equal(underLink(root, main), false);
    // The link itself is a candidate like any other: its own lstat says it is not a file.
    assert.equal(underLink(root, link), false);
    assert.equal(isLinkDir(link), true);
    assert.equal(isLinkDir(root), false);
    assert.equal(isLinkDir(path.join(root, 'gone')), false, 'gone is not news here');
  });
});

// Path conventions shared by the server, the hooks and the indexer (CONTRACTS.md §2): the check
// every read of a path from the index makes.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isInside } from '../../src/paths.mjs';

describe('isInside', () => {
  const root = path.resolve('project');
  const win32 = process.platform === 'win32';

  test('the root itself and what is below it; not a sibling that only shares its name as a prefix', () => {
    assert.equal(isInside(root, root), true);
    assert.equal(isInside(root, path.resolve(root, 'src/a.ts')), true);
    assert.equal(isInside(root, path.resolve(root, 'src/../src/a.ts')), true);
    assert.equal(isInside(root, path.resolve(root, '../project-other/a.ts')), false, "a sibling whose name starts with the root's");
    assert.equal(isInside(root, path.resolve(root, '../elsewhere/a.ts')), false);
    assert.equal(isInside(root, path.resolve('a.ts')), false, 'an absolute path elsewhere');
  });

  test('the spelling of the root does not decide: forward slashes, a trailing separator, and case where the file system does not care', () => {
    const slashed = root.split(path.sep).join('/');
    assert.equal(isInside(slashed, path.resolve(root, 'src/a.ts')), true);
    assert.equal(isInside(`${slashed}/`, path.resolve(root, 'src/a.ts')), true);
    assert.equal(isInside(root.toUpperCase(), path.resolve(root, 'src/a.ts')), win32);
  });
});

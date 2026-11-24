import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { listFiles, compileExclude, isExcluded } from '../../src/index/walker.mjs';
import { loadSpecs } from '../../src/languages/registry.mjs';
import { scratchDir, writeProject, git, rmrf, SAMPLE } from './_helpers.mjs';

const specs = await loadSpecs();
const dirs = [];
const project = (name, files) => {
  const dir = scratchDir(name);
  dirs.push(dir);
  writeProject(dir, files);
  return dir;
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmrf(d);
});

describe('exclude patterns', () => {
  test('plain entries are paths or directory prefixes; globs match the full path or the basename', () => {
    const m = compileExclude(['generated', 'src/legacy/', 'docs/*.md', '**/*.d.ts', 'src/**/*.snap', 'build']);
    assert.equal(isExcluded('generated', m), true);
    assert.equal(isExcluded('generated/x.ts', m), true);
    assert.equal(isExcluded('src/generated/x.ts', m), false);
    assert.equal(isExcluded('src/legacy/x.ts', m), true);
    assert.equal(isExcluded('src/legacy', m), true);
    assert.equal(isExcluded('src/legacyx/a.ts', m), false);
    assert.equal(isExcluded('docs/a.md', m), true);
    assert.equal(isExcluded('docs/sub/a.md', m), false);
    assert.equal(isExcluded('x.d.ts', m), true);
    assert.equal(isExcluded('src/types/x.d.ts', m), true);
    assert.equal(isExcluded('src/a/b/x.snap', m), true);
    assert.equal(isExcluded('src/x.snap', m), true);
    assert.equal(isExcluded('src/build.ts', m), false);
    assert.equal(isExcluded('a/b/build/x.ts', m), false);
  });

  test('empty entries are ignored and backslashes are accepted', () => {
    const m = compileExclude(['', '  ', 'src\\win', './rel']);
    assert.equal(m.length, 2);
    assert.equal(isExcluded('src/win/a.ts', m), true);
    assert.equal(isExcluded('rel/a.ts', m), true);
  });

  test('consecutive "**/" groups compile as one group (no exponential backtracking) and match the same paths', () => {
    const collapsed = compileExclude(['**/**/**/**/**/**/**/**/x']);
    assert.equal(collapsed.length, 1);
    assert.equal((collapsed[0].re.source.match(/\(\?:\.\*\\?\/\)\?/g) ?? []).length, 1, 'one optional-directory group, not eight nested ones');
    assert.equal(isExcluded('x', collapsed), true);
    assert.equal(isExcluded('a/b/c/x', collapsed), true);
    assert.equal(isExcluded('a/b/c/y', collapsed), false);
    assert.deepEqual([1, 2, 3, 4, 6, 8].map((g) => compileExclude([Array.from({ length: g }, () => '**').join('/') + '/x'])[0].re.source),
      Array(6).fill(collapsed[0].re.source), 'every repetition of "**/" compiles to the same regex');
    const longPath = Array.from({ length: 60 }, () => 'segment').join('/') + '/y.ts';
    const t = performance.now();
    assert.equal(isExcluded(longPath, compileExclude([Array.from({ length: 12 }, () => '**').join('/') + '/x'])), false);
    assert.ok(performance.now() - t < 500, 'a long non-matching path is rejected quickly');
    // Existing spellings keep their meaning.
    const m = compileExclude(['src/**/*.snap', '**/*.d.ts']);
    assert.equal(isExcluded('src/a/b/x.snap', m), true);
    assert.equal(isExcluded('src/x.snap', m), true);
    assert.equal(isExcluded('x.d.ts', m), true);
    assert.equal(isExcluded('src/types/x.d.ts', m), true);
  });
});

describe('listFiles (git repository)', () => {
  test('lists tracked and untracked files, honours .gitignore, built-in ignore, exclude, size and count limits', async () => {
    const dir = project('walker-git', {
      'src/tracked.ts': SAMPLE,
      'untracked.ts': SAMPLE,
      'ignored.ts': SAMPLE,
      'node_modules/pkg/dep.ts': SAMPLE,
      'generated/gen.ts': SAMPLE,
      'dist/bundle.ts': SAMPLE,
      'src/big.ts': `${SAMPLE}//${'x'.repeat(4_300_000)}`,
      'readme.md': '# not code',
      '.gitignore': 'ignored.ts\n',
    });
    git(dir, 'init', '-q');
    git(dir, 'add', 'src/tracked.ts', '.gitignore');

    const listing = await listFiles(dir, { config: { exclude: ['generated'] }, specs });
    assert.deepEqual(listing.files.map((f) => f.path), ['src/tracked.ts', 'untracked.ts']);
    assert.equal(listing.truncated, false);
    // everything git listed after ignore/exclude: .gitignore, readme.md, src/big.ts and the two hits
    assert.equal(listing.total, 5);
    const [a, b] = listing.files;
    assert.equal(a.lang, 'typescript');
    assert.equal(a.abs, path.join(dir, 'src', 'tracked.ts'));
    assert.equal(fs.existsSync(a.abs), true);
    assert.equal(Number.isInteger(a.mtimeMs), true);
    assert.equal(a.size, Buffer.byteLength(SAMPLE));
    assert.equal(b.path, 'untracked.ts');
  });

  test('truncates at maxFiles and reports it', async () => {
    const dir = project('walker-git-max', { 'a.ts': SAMPLE, 'b.ts': SAMPLE, 'c.ts': SAMPLE });
    git(dir, 'init', '-q');
    git(dir, 'add', 'a.ts');
    const listing = await listFiles(dir, { config: { maxFiles: 2 }, specs });
    assert.deepEqual(listing.files.map((f) => f.path), ['a.ts', 'b.ts']);
    assert.equal(listing.truncated, true);
    assert.equal(listing.total, 3);
  });

  test('git ls-files failure falls back to a directory walk', async () => {
    // A `.git` file that is not a valid work tree makes git fail; the walker must still list.
    const dir = project('walker-git-broken', { 'x.ts': SAMPLE, '.git': 'gitdir: nowhere\n' });
    const listing = await listFiles(dir, { config: {}, specs });
    assert.deepEqual(listing.files.map((f) => f.path), ['x.ts']);
  });
});

describe('listFiles (plain directory)', () => {
  test('walks recursively with built-in ignore dirs pruned and no .gitignore support', async () => {
    const dir = project('walker-fs', {
      'src/a.ts': SAMPLE,
      'src/deep/b.ts': SAMPLE,
      'ignored-by-gitignore.ts': SAMPLE,
      '.gitignore': 'ignored-by-gitignore.ts\n',
      'node_modules/x.ts': SAMPLE,
      'dist/x.ts': SAMPLE,
      'build/x.ts': SAMPLE,
      'out/x.ts': SAMPLE,
      'target/x.ts': SAMPLE,
      'vendor/x.ts': SAMPLE,
      '.codegraph/x.ts': SAMPLE,
      '.tmp/x.ts': SAMPLE,
      'src/generated/g.ts': SAMPLE,
      'notes.txt': 'x',
    });
    const listing = await listFiles(dir, { config: { exclude: ['src/generated'] }, specs });
    assert.deepEqual(listing.files.map((f) => f.path), ['ignored-by-gitignore.ts', 'src/a.ts', 'src/deep/b.ts']);
    assert.equal(listing.truncated, false);
    // .gitignore and notes.txt count as enumerated files; ignored/excluded dirs do not
    assert.equal(listing.total, 5);
  });

  test('languages restricts which packs may claim a file; total still counts every file', async () => {
    const dir = project('walker-langs', { 'a.ts': SAMPLE, 'b.txt': 'x' });
    const onlyTs = await listFiles(dir, { config: { languages: ['typescript'] }, specs });
    assert.deepEqual(onlyTs.files.map((f) => f.path), ['a.ts']);
    assert.equal(onlyTs.total, 2);
    const none = await listFiles(dir, { config: { languages: ['python'] }, specs });
    assert.deepEqual(none.files, []);
    assert.equal(none.total, 2);
  });

  test('maxFileBytes comes from the config', async () => {
    const dir = project('walker-size', { 'a.ts': SAMPLE, 'b.ts': `${SAMPLE}//${'y'.repeat(5000)}` });
    const listing = await listFiles(dir, { config: { maxFileBytes: Buffer.byteLength(SAMPLE) + 10 }, specs });
    assert.deepEqual(listing.files.map((f) => f.path), ['a.ts']);
  });

  test('rejects a missing root and a non-directory root', async () => {
    const dir = project('walker-errors', { 'a.ts': SAMPLE });
    await assert.rejects(listFiles(path.join(dir, 'missing'), { config: {}, specs }), { code: 'ENOENT' });
    await assert.rejects(listFiles(path.join(dir, 'a.ts'), { config: {}, specs }), /is not a directory/);
    await assert.rejects(listFiles('', { config: {}, specs }), TypeError);
    await assert.rejects(listFiles(dir, { config: {}, specs: null }), TypeError);
  });
});

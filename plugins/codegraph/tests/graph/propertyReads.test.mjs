// Property reads found in the source files (CONTRACTS.md §8 "property reads"): the scan, its
// order and grouping, what it leaves out, its limits, and how `search` merges it with the
// index. The index is a real one, built by the indexer over a throwaway project; the scan runs
// in its real worker.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Indexer } from '../../src/index/indexer.mjs';
import { SCAN_FILES_MAX, scanPropertyReads, warmPropertyReads } from '../../src/graph/propertyReads.mjs';
import { propertyReadNeedle } from '../../src/graph/prefilter.mjs';
import { search } from '../../src/graph/queries.mjs';
import { upsertFile } from '../../src/store/repo.mjs';
import { scratchDir, rmrf, writeProject, closeAll, useScratchData } from '../index/_helpers.mjs';

const data = useScratchData('data-propreads');
const indexers = [];
const dirs = [];
const strayFiles = [];
afterEach(async () => {
  await closeAll(indexers);
  for (const d of dirs.splice(0)) rmrf(d);
  for (const file of strayFiles.splice(0)) rmrf(file);
});
after(() => rmrf(data));

async function indexed(files, config = { minFilesToAutoIndex: 1 }) {
  const root = scratchDir('propreads');
  dirs.push(root);
  writeProject(root, files);
  const ix = new Indexer({ root, config, workers: 2 });
  indexers.push(ix);
  await ix.buildAll();
  return { root, db: ix.db };
}
const NOTHING = { rows: [], uses: 0, files: 0, fileIds: [], names: [], capped: false, skipped: null };
// `places` drops what is the file's own: rows are compared without file ids.
const places = (out) => out.rows.map(({ file_id, ...row }) => row);
const scan = (ctx, query, options = {}) => scanPropertyReads({ ...ctx, query, ...options });

describe('scanPropertyReads', () => {
  test('a query that is not a single name is not looked for, before anything is started', async () => {
    assert.deepEqual(await scanPropertyReads({ root: process.cwd(), db: null, query: 'max idle days' }), { ...NOTHING, skipped: 'not-identifier' });
    assert.deepEqual(await scanPropertyReads({ root: process.cwd(), db: null, query: '  ' }), { ...NOTHING, skipped: 'not-identifier' });
    assert.deepEqual(await scanPropertyReads({ root: process.cwd(), db: null, query: 'a.b' }), { ...NOTHING, skipped: 'not-identifier' });
  });

  test('the places that read the name as a property: grouped by receiver and containing symbol, source before tests', async () => {
    await warmPropertyReads();
    const { root, db } = await indexed({
      'src/sweep.ts': [
        'export interface Policy {',
        '  maxIdleDays: number;',
        '}',
        '',
        'export class Sweeper {',
        '  run(policy: Policy): number {',
        '    return policy.maxIdleDays > 0 ? policy.maxIdleDays * 2 : this.fallback.maxIdleDays;',
        '  }',
        '}',
        '',
        'cfg?.maxIdleDays;',
        '',
      ].join('\n'),
      'src/ui.tsx': [
        'export function Row({ row }: Props) {',
        '  const days = getList().maxIdleDays;',
        '  return <span>{days}</span>;',
        '}',
        '',
      ].join('\n'),
      'src/calls.ts': 'export function load(policy: Policy) {\n  return policy.maxIdleDays(1);\n}\nconst note = "config.maxIdleDays"; // a comment on .maxIdleDays\n',
      // A test file whose path sorts before src/: only the rule puts it after the source.
      'e2e/sweep.spec.ts': 'export function specSweep(policy: Policy) {\n  return policy.maxIdleDays;\n}\n',
      'tests/sweep.test.ts': 'export function testSweep(policy: Policy) {\n  return policy.maxIdleDays + 1;\n}\n',
      // Two receivers on one line, named the other way round than they are written.
      'src/order.ts': 'export function g() {\n  return zeta.maxIdleDays + alpha.maxIdleDays;\n}\n',
      'tools/probe.py': 'def f(policy):\n    return policy.maxIdleDays\n',
    });
    const out = await scan({ root, db }, 'maxIdleDays');
    assert.deepEqual(places(out), [
      { name: 'maxIdleDays', kind: 'property', receiver: 'alpha', count: 1, start_line: 2, path: 'src/order.ts', owner: 'g', owner_qual: 'g', owner_kind: 'function' },
      { name: 'maxIdleDays', kind: 'property', receiver: 'zeta', count: 1, start_line: 2, path: 'src/order.ts', owner: 'g', owner_qual: 'g', owner_kind: 'function' },
      { name: 'maxIdleDays', kind: 'property', receiver: 'policy', count: 2, start_line: 7, path: 'src/sweep.ts', owner: 'run', owner_qual: 'Sweeper.run', owner_kind: 'method' },
      { name: 'maxIdleDays', kind: 'property', receiver: 'this.fallback', count: 1, start_line: 7, path: 'src/sweep.ts', owner: 'run', owner_qual: 'Sweeper.run', owner_kind: 'method' },
      { name: 'maxIdleDays', kind: 'property', receiver: 'cfg', count: 1, start_line: 11, path: 'src/sweep.ts', owner: null, owner_qual: null, owner_kind: null },
      { name: 'maxIdleDays', kind: 'property', receiver: 'getList()', count: 1, start_line: 2, path: 'src/ui.tsx', owner: 'Row', owner_qual: 'Row', owner_kind: 'component' },
      { name: 'maxIdleDays', kind: 'property', receiver: 'policy', count: 1, start_line: 2, path: 'e2e/sweep.spec.ts', owner: 'specSweep', owner_qual: 'specSweep', owner_kind: 'function' },
      { name: 'maxIdleDays', kind: 'property', receiver: 'policy', count: 1, start_line: 2, path: 'tests/sweep.test.ts', owner: 'testSweep', owner_qual: 'testSweep', owner_kind: 'function' },
    ]);
    assert.deepEqual({ uses: out.uses, files: out.files, names: out.names, capped: out.capped, skipped: out.skipped }, { uses: 9, files: 5, names: ['maxIdleDays'], capped: false, skipped: null });
    // One id per file with a read, whatever the number of rows.
    assert.equal(out.fileIds.length, 5);
    // Rows in a file come in line order, then by receiver, whatever order the tree yielded them.
    assert.deepEqual((await scan({ root, db }, 'maxIdleDays')).rows.map((row) => `${row.path}:${row.start_line}`), ['src/order.ts:2', 'src/order.ts:2', 'src/sweep.ts:7', 'src/sweep.ts:7', 'src/sweep.ts:11', 'src/ui.tsx:2', 'e2e/sweep.spec.ts:2', 'tests/sweep.test.ts:2']);
  });

  test('a method call, a construction, a decorator, a plain write, a destructuring target, a string, a comment, another language and another spelling are not reads', async () => {
    await warmPropertyReads();
    const { root, db } = await indexed({
      'src/a.ts': [
        'export function f(policy: Policy, row: Row) {',
        '  policy.maxIdleDays(1);',
        '  policy.maxIdleDays = 2;',
        '  return new policy.maxIdleDays(row.MaxIdleDays + row.maxIdleDaysV2);',
        '}',
        'const text = "policy.maxIdleDays"; // policy.maxIdleDays',
        'class C {',
        '  @policy.maxIdleDays',
        '  m(): void {}',
        '}',
        // Written to, not read: wherever the target of an assignment sits.
        '[policy.maxIdleDays] = rows;',
        '({ key: policy.maxIdleDays } = rows[0]);',
        '({ key: policy.maxIdleDays = 1 } = rows[0]);',
        '[...policy.maxIdleDays] = rows;',
        'for (policy.maxIdleDays of rows) {}',
        '',
      ].join('\n'),
      'src/b.py': 'def f(policy):\n    return policy.maxIdleDays\n',
    });
    assert.deepEqual(await scan({ root, db }, 'maxIdleDays'), NOTHING);
  });

  test('a compound assignment, an update, a delete and a default value use the property, so they are reads', async () => {
    await warmPropertyReads();
    const { root, db } = await indexed({
      // The default value is a read whether the destructuring declares or assigns.
      'src/a.ts': 'export function f(policy: Policy) {\n  policy.maxIdleDays += 3;\n  policy.maxIdleDays++;\n  delete policy.maxIdleDays;\n  return --policy.maxIdleDays;\n}\nconst [a = policy.maxIdleDays] = rows;\n[b = policy.maxIdleDays] = rows;\n({ key: c = policy.maxIdleDays } = rows[0]);\n',
    });
    const out = await scan({ root, db }, 'maxIdleDays');
    assert.deepEqual(places(out).slice(0, 1), [
      { name: 'maxIdleDays', kind: 'property', receiver: 'policy', count: 4, start_line: 2, path: 'src/a.ts', owner: 'f', owner_qual: 'f', owner_kind: 'function' },
    ]);
    // The three default values are module-level reads of one receiver: one row of three.
    assert.deepEqual(out.rows.filter((row) => row.owner === null).map((row) => [row.count, row.start_line]), [[3, 7]]);
  });

  test('whitespace and a block comment between the dot and the name are still a read', async () => {
    await warmPropertyReads();
    const { root, db } = await indexed({
      'src/a.ts': 'export function f(row: Row) {\n  return [row. zzqP, row?. zzqP, row.\nzzqP, row /* c */ . zzqP];\n}\n',
    });
    const out = await scan({ root, db }, 'zzqP');
    assert.deepEqual([out.uses, out.files, out.rows[0]?.count], [4, 1, 4]);
  });

  test('of two definitions on one line the read belongs to the one that starts nearest before it', async () => {
    await warmPropertyReads();
    const { root, db } = await indexed({
      'src/a.ts': 'export const one = (row: Row) => row.zzqOne, two = (row: Row) => row.zzqTwo;\nexport const obj = { m(row: Row) { return row.zzqThree; } };\n',
    });
    assert.deepEqual((await scan({ root, db }, 'zzqTwo')).rows.map((row) => row.owner_qual), ['two']);
    assert.deepEqual((await scan({ root, db }, 'zzqOne')).rows.map((row) => row.owner_qual), ['one']);
    assert.deepEqual((await scan({ root, db }, 'zzqThree')).rows.map((row) => row.owner_qual), ['obj.m']);
  });

  test('a name read in more files than the cut is a hub: nothing is parsed and the answer says so', async () => {
    await warmPropertyReads();
    const files = {};
    for (let i = 0; i <= SCAN_FILES_MAX; i++) files[`src/f${i}.ts`] = `export const v${i} = row.hubName;\n`;
    const { root, db } = await indexed(files);
    assert.deepEqual(await scan({ root, db }, 'hubName'), { ...NOTHING, capped: true, skipped: 'hub' });
    // One file fewer: the cut is not reached and every read is listed.
    delete files[`src/f${SCAN_FILES_MAX}.ts`];
    const { root: root2, db: db2 } = await indexed(files);
    assert.equal((await scan({ root: root2, db: db2 }, 'hubName')).files, SCAN_FILES_MAX);
    // The cut is on files that have a hit: one more file without one changes nothing.
    files['src/zz-none.ts'] = 'export const none = 1;\n';
    const { root: root3, db: db3 } = await indexed(files);
    assert.equal((await scan({ root: root3, db: db3 }, 'hubName')).files, SCAN_FILES_MAX);
  });

  test('a file that the index places outside the project is not read, and the answer says it is short of a file', async () => {
    await warmPropertyReads();
    const { root, db } = await indexed({ 'src/a.ts': 'export const a = row.zzqP;\n' });
    // In this run's scratch area, one level above the project.
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.ts`);
    strayFiles.push(outside);
    fs.writeFileSync(outside, 'export const b = row.zzqOut;\n');
    upsertFile(db, { path: `../${path.basename(outside)}`, lang: 'typescript', hash: 'outside', mtimeMs: 1, size: 1, parseOk: true, errorNodes: 0, indexedAt: 1 });
    const out = await scan({ root, db }, 'zzqOut');
    assert.deepEqual([out.uses, out.capped, out.skipped], [0, false, 'unreadable'], 'the read outside the project is not a row, and "none found" is not claimed');
    // With reads of its own found, the answer is a lower bound.
    const both = await scan({ root, db }, 'zzqP');
    assert.deepEqual([both.uses, both.capped, both.rows.map((row) => row.path)], [1, true, ['src/a.ts']]);
  });

  test('a file that is gone is not news; files that cannot be read are', async () => {
    await warmPropertyReads();
    const { root, db } = await indexed({ 'src/a.ts': 'export const a = row.zzqP;\n' });
    upsertFile(db, { path: 'src/gone.ts', lang: 'typescript', hash: 'gone', mtimeMs: 1, size: 1, parseOk: true, errorNodes: 0, indexedAt: 1 });
    assert.equal((await scan({ root, db }, 'zzqGone')).skipped, null, 'the next sync drops a file that is gone');
    // No root at all: every file is left out, which is not "looked for and found none".
    assert.deepEqual(await scanPropertyReads({ db, query: 'zzqGone' }), { ...NOTHING, skipped: 'unreadable' });
  });

  test('a receiver is on one line, as the index records a call’s receiver, so one receiver spelled with other whitespace makes one row', async () => {
    await warmPropertyReads();
    const { root, db } = await indexed({
      'src/a.ts': 'export function f(): number {\n  return getList(\n    1\n  ).zzqP + getList( 1 ).zzqP;\n}\n',
    });
    const out = await scan({ root, db }, 'zzqP');
    assert.deepEqual([out.rows.length, out.rows[0].receiver, out.rows[0].count], [1, 'getList( 1 )', 2]);
  });

  test('the limits bound every step: a file too big, too many bytes to read, too many hits to be worth parsing, too many bytes to parse', async () => {
    await warmPropertyReads();
    const { root, db } = await indexed({
      'src/0-hits.ts': `${Array.from({ length: 40 }, (_, i) => `const h${i} = row.zzqP;`).join('\n')}\n`,
      'src/a.ts': 'export const a = row.zzqP;\n',
      // Two hundred kilobytes with one read: over a small `maxFileBytes`, and last to be parsed.
      'src/big.ts': 'export const big = row.zzqP; const text = "' + 'x'.repeat(200_000) + '.zzqP";\n',
      'src/zz.ts': 'export const z = row.zzqP;\n',
    });
    // `maxFileBytes` is the caller's (the indexer's own limit).
    const small = await scan({ root, db }, 'zzqP', { maxFileBytes: 1000 });
    assert.deepEqual([...new Set(small.rows.map((row) => row.path))].sort(), ['src/0-hits.ts', 'src/a.ts', 'src/zz.ts']);
    assert.equal(small.capped, false, 'a skipped file is not a cut');
    // Hits: forty in the first file read are more than are worth parsing, whatever the file count.
    assert.deepEqual(await scan({ root, db }, 'zzqP', { limits: { maxHits: 20 } }), { ...NOTHING, capped: true, skipped: 'limit' });
    // Bytes: the read step stops once it has read more than it may. Both say why there is no
    // row: "none found" would be false.
    assert.deepEqual(await scan({ root, db }, 'zzqP', { limits: { maxReadBytes: 150_000 } }), { ...NOTHING, capped: true, skipped: 'limit' });
    // The parse step, the smallest files first: the one file that would cross the budget is left
    // out, and what was parsed is returned, as a lower bound.
    const parsed = await scan({ root, db }, 'zzqP', { limits: { maxParseBytes: 1000 } });
    assert.deepEqual([parsed.capped, parsed.skipped, parsed.uses, parsed.files, [...new Set(parsed.rows.map((row) => row.path))].sort()], [true, null, 42, 3, ['src/0-hits.ts', 'src/a.ts', 'src/zz.ts']]);
    // Nothing is small enough for the budget: no row, and the limit is why.
    assert.deepEqual(await scan({ root, db }, 'zzqP', { limits: { maxParseBytes: 10 } }), { ...NOTHING, capped: true, skipped: 'limit' });
  });

  test('a scan that cannot finish in time gives up, and is reported as not looked for', async () => {
    await warmPropertyReads();
    // A quarter of a megabyte to parse for one hit (the shape of a minified bundle): more than a
    // hundred milliseconds of work in the worker.
    const { root, db } = await indexed({ 'src/big.ts': `export const data = [row.zzqP, ${'{a:1},'.repeat(43_700)}];\n` });
    const slow = await scan({ root, db }, 'zzqP', { timeoutMs: 1 });
    assert.deepEqual(slow, { ...NOTHING, skipped: 'not-ready' }, 'one millisecond is not enough for a scan that parses a quarter of a megabyte');
    // The stuck worker was replaced: the next scan is answered. Which worker answers is pinned
    // with a worker that is not real, in propertyReads.worker.test.mjs.
    assert.equal((await scan({ root, db }, 'zzqP')).uses, 1);
  });
});

// The pattern is written with escaped backslashes inside a template literal, so what it matches
// is stated here rather than once, at run time, in the worker.
describe('the prefilter of the scan', () => {
  const found = (name, text) => [...text.matchAll(propertyReadNeedle(name))].length;

  test('a read behind a dot or ?. (whitespace and block comments allowed); not a spread, a call, a bare word or a longer name', () => {
    assert.equal(found('zzqP', 'row.zzqP'), 1);
    assert.equal(found('zzqP', 'row?. zzqP'), 1);
    assert.equal(found('zzqP', 'row /* c */ .\nzzqP'), 1);
    assert.equal(found('zzqP', 'row. // note\nzzqP'), 1, 'a line comment in between ends with its newline');
    assert.equal(found('zzqP', 'getList().zzqP'), 1, 'the dot is what matters, not what is in front of it');
    assert.equal(found('zzqP', 'a.b.zzqP'), 1, 'only the last dot is followed by the name');
    assert.equal(found('zzqP', '...zzqP'), 0, 'a spread is not a read');
    assert.equal(found('zzqP', 'obj.zzqP('), 0, 'a call is in the index');
    assert.equal(found('zzqP', 'obj.zzqPicker'), 0);
    assert.equal(found('zzqP', 'row zzqP'), 0, 'a word of its own is not a property read');
  });

  test('the name is taken literally', () => {
    assert.equal(found('$name', 'obj.$name'), 1);
    assert.equal(found('name', 'obj.$name'), 0);
    // Cannot be asked through the scan (it takes identifiers only); the escaping still holds.
    assert.equal(found('a.b', 'x.a\\b'), 0, 'the dot of the name is a dot, not any character');
    assert.equal(found('a.b', 'x.a.b'), 1);
  });

  test('the gap between the dot and the name is bounded: whitespace runs of 40 characters, block comments of 200, line comments of 1000, eight comments', () => {
    assert.equal(found('zzqP', `o.${' '.repeat(40)}zzqP`), 1);
    assert.equal(found('zzqP', `o.${' '.repeat(41)}zzqP`), 0);
    assert.equal(found('zzqP', `o. /*${'x'.repeat(200)}*/ zzqP`), 1);
    assert.equal(found('zzqP', `o. /*${'x'.repeat(201)}*/ zzqP`), 0);
    assert.equal(found('zzqP', `o. ${'/*c*/ '.repeat(8)}zzqP`), 1);
    assert.equal(found('zzqP', `o. ${'/*c*/ '.repeat(9)}zzqP`), 0, 'nine comments');
    // The whitespace after a comment has the bound of the whitespace before it.
    assert.equal(found('zzqP', `o. /*c*/${' '.repeat(41)}zzqP`), 0);
    // A line comment ends with its newline, and is bounded like the rest.
    assert.equal(found('zzqP', `o. //${'x'.repeat(1000)}\nzzqP`), 1);
    assert.equal(found('zzqP', `o. //${'x'.repeat(1001)}\nzzqP`), 0);
  });

  test('the cost stays linear: a dot followed by comments or a run of whitespace, a few ten thousand times over', () => {
    // Each of these took seconds (quadratic, or exponential on the whitespace) while its piece
    // could run on: a line comment with no newline after it runs to the end of a one-line file.
    const shapes = {
      'closed block comments': 'a. /* x */ b; ',
      'unclosed block comments': 'a. /* x ',
      'line comments': 'a. // x\n ',
      'line comments with no newline after them': 'a.//xxxxxx ',
      'line comments in a file of carriage returns': 'a. // x\rb; ',
      'runs of whitespace': `a.${' '.repeat(40)}`,
      'the most a gap can cost': `a.${' '.repeat(40)}/*${'x'.repeat(200)}*/${' '.repeat(40)}`,
    };
    for (const [shape, piece] of Object.entries(shapes)) {
      const text = piece.repeat(Math.ceil(200_000 / piece.length));
      const at = performance.now();
      assert.equal(found('zzqP', text), 0, shape);
      const ms = performance.now() - at;
      assert.ok(ms < 250, `${shape}: 200 KB took ${ms.toFixed(0)} ms`);
    }
  });
});

describe('search with property reads', () => {
  // A provider answers in the store's shape, which `search` maps like the index's rows.
  const scannedFor = (answer) => ({ propertyReads: () => answer });
  const refShape = (query) => ({ kind: 'property', name: query, receiver: 'row', count: 1, path: 'src/a.ts', startLine: 2, owner: 'f', ownerQual: 'f', ownerKind: 'function' });
  const refStore = (query) => ({ kind: 'property', name: query, receiver: 'row', count: 1, start_line: 2, file_id: 1, path: 'src/a.ts', owner: 'f', owner_qual: 'f', owner_kind: 'function' });
  const scanned = async (ctx, query, options) => scannedFor(await scan(ctx, query, options));

  test('when nothing in the index has the name, the scan answers and the header says it was scanned', async () => {
    await warmPropertyReads();
    const ctx = await indexed({ 'src/a.ts': 'export function f(row: Row) {\n  return row.zzqPlugh;\n}\n', 'src/b.ts': 'export function membershipCache(): void {}\n' });
    const info = {};
    const rows = search(ctx.db, { query: 'zzqPlugh' }, info, await scanned(ctx, 'zzqPlugh'));
    assert.deepEqual(rows, [refShape('zzqPlugh')]);
    assert.deepEqual(info, { refs: { uses: 1, files: 1, names: ['zzqPlugh'], capped: false, fromIndex: 0, fromScan: 1, skipped: null, symbols: [], symbolCount: 0 } });
  });

  test('a name the index has in one language is still looked for in the JS/TS source: one list, index rows first at the same place', async () => {
    await warmPropertyReads();
    const ctx = await indexed({
      'src/a.ts': 'export function f(row: Row, client: Client) {\n  client.zzqPlugh(row.zzqPlugh);\n  return row.zzqPlugh;\n}\n',
      'src/b.py': 'def g(row):\n    return row.zzqPlugh\n',
      'tests/a.test.ts': 'export function t(row: Row) {\n  return row.zzqPlugh;\n}\n',
    });
    const info = {};
    const rows = search(ctx.db, { query: 'zzqPlugh' }, info, await scanned(ctx, 'zzqPlugh'));
    // Both reads in `f` are one row of the scan (same receiver, same function).
    assert.deepEqual(rows.map((row) => [row.kind, row.path, row.startLine, row.count]), [
      ['call', 'src/a.ts', 2, 1],
      ['property', 'src/a.ts', 2, 2],
      ['ref', 'src/b.py', 2, 1],
      ['property', 'tests/a.test.ts', 2, 1],
    ]);
    assert.deepEqual(info, { refs: { uses: 5, files: 3, names: ['zzqPlugh'], capped: false, fromIndex: 2, fromScan: 2, skipped: null, symbols: [], symbolCount: 0 } });
    // A scan that gave up (the name is read in too many files) leaves the index's rows and marks
    // the totals as lower bounds.
    const hub = {};
    assert.equal(search(ctx.db, { query: 'zzqPlugh' }, hub, scannedFor({ ...NOTHING, capped: true })).length, 2);
    assert.deepEqual(hub.refs, { uses: 2, files: 2, names: ['zzqPlugh'], capped: true, fromIndex: 2, fromScan: 0, skipped: null, symbols: [], symbolCount: 0 });
  });

  test('the files of the index are counted over all its rows, cut or not; rows are cut to the limit', async () => {
    await warmPropertyReads();
    const files = { 'src/reads.ts': 'export function f(row: Row) {\n  return row.zzqPlugh;\n}\n' };
    for (let i = 0; i < 12; i++) files[`src/c${i}.ts`] = `export function c${i}(client: Client) {\n  client.zzqPlugh();\n}\n`;
    const ctx = await indexed(files);
    const info = {};
    const rows = search(ctx.db, { query: 'zzqPlugh', limit: 3 }, info, await scanned(ctx, 'zzqPlugh'));
    assert.equal(rows.length, 3, 'the caller asked for three rows');
    assert.deepEqual(info.refs, { uses: 13, files: 13, names: ['zzqPlugh'], capped: false, fromIndex: 3, fromScan: 1, skipped: null, symbols: [], symbolCount: 0 });
  });

  test('why the scan has no row is passed on: a hub is told apart from a scan that never looked', async () => {
    await warmPropertyReads();
    const ctx = await indexed({ 'src/a.ts': 'export function f(client: Client) {\n  client.zzqPlugh();\n}\nexport function zzqOther(): void {}\n' });
    const hub = {};
    search(ctx.db, { query: 'zzqPlugh' }, hub, scannedFor({ ...NOTHING, capped: true, skipped: 'hub' }));
    assert.equal(hub.refs.skipped, 'hub');
    const idle = {};
    search(ctx.db, { query: 'zzqPlugh' }, idle, scannedFor({ ...NOTHING, skipped: 'not-ready' }));
    assert.equal(idle.refs.skipped, 'not-ready');
    const limit = {};
    search(ctx.db, { query: 'zzqPlugh' }, limit, scannedFor({ ...NOTHING, capped: true, skipped: 'limit' }));
    assert.equal(limit.refs.skipped, 'limit');
    // Partial symbol matches are shown as they are; `hub` is read only for an empty result.
    assert.deepEqual(search(ctx.db, { query: 'zzqOtherName' }, {}, scannedFor({ ...NOTHING, capped: true, skipped: 'hub' })).map((row) => row.name), ['zzqOther']);
    // Nothing anywhere but the hub: the result is empty, and says that the name is read everywhere.
    const nowhere = {};
    assert.deepEqual(search(ctx.db, { query: 'xyzzyPlugh' }, nowhere, scannedFor({ ...NOTHING, capped: true, skipped: 'hub' })), []);
    assert.equal(nowhere.hub, true);
  });

  test('a fake provider drives the decision the same way: empty answers never lead, a kind never asks', async () => {
    await warmPropertyReads();
    const { db } = await indexed({ 'src/a.ts': 'export function zzqOther(): void {}\nexport function zzqFull(): void {}\n' });
    const never = { propertyReads: () => { throw new Error('must not be asked'); } };
    assert.deepEqual(search(db, { query: 'zzqFull' }, {}, never).map((row) => row.name), ['zzqFull'], 'a symbol carries the name');
    assert.deepEqual(search(db, { query: 'zzqOther', kind: 'function' }, {}, never).map((row) => row.name), ['zzqOther']);
    // A kind filter keeps even a partial search to symbols: the scan is not asked then either.
    const withKind = search(db, { query: 'zzqOtherName', kind: 'function' }, {}, never).map((row) => row.name);
    assert.ok(withKind.length > 0, 'partial symbol matches are still shown');
    assert.deepEqual(withKind, search(db, { query: 'zzqOtherName', kind: 'function' }, {}).map((row) => row.name));
    // A hub or an empty answer adds nothing: what the symbol search had stays, exactly as without a scan.
    const without = search(db, { query: 'zzqNothing' }, {}).map((row) => row.name);
    assert.ok(without.length > 0, 'the symbol search had partial matches');
    assert.deepEqual(search(db, { query: 'zzqNothing' }, {}, scannedFor({ ...NOTHING, capped: true })).map((row) => row.name), without);
    assert.deepEqual(search(db, { query: 'zzqNothing' }, {}, scannedFor(NOTHING)).map((row) => row.name), without);
    const leads = search(db, { query: 'zzqOtherName' }, {}, scannedFor({ rows: [refStore('zzqOtherName')], uses: 40, files: 1, fileIds: [1], names: ['zzqOtherName'], capped: false, skipped: null }));
    assert.deepEqual(leads.map((row) => row.name), ['zzqOtherName'], 'a partial symbol match gives way to 40 reads of the name itself');
  });
});

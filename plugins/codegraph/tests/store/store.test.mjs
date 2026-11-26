// Store lane tests (CONTRACTS.md §7). Each test gets its own database in a
// temporary directory; afterEach closes every handle before removing the
// directory, which on Windows only works when the handle is really closed.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, close } from '../../src/store/db.mjs';
import {
  beginBulkLoad, beginWriteGroup, clearPendingFiles, clearPurgedSymbols, countFiles, deleteFile, dirtyCount, dirtyPaths, endBulkLoad,
  findSymbolsByName, getFileByPath, importersOfPath, importsOfFile, inTransaction, listFiles, markDirty, metaGet, metaSet,
  pendingFiles, refsByName, refsInFile, refsTo, replaceAllForFile, replaceFile, searchSymbols, searchSymbolsDetailed, setRefResolution, symbolById,
  symbolsInFile, takeDirty, takePurgedSymbols, unresolvedRefs, upsertFile,
} from '../../src/store/repo.mjs';

const open = [];

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-store-'));
  const entry = { dir, file: path.join(dir, 'nested', 'graph.db'), db: null };
  open.push(entry);
  // The "nested" directory does not exist yet: openDatabase must create it.
  entry.db = openDatabase(entry.file);
  return entry;
}

afterEach(() => {
  const entries = open.splice(0);
  for (const { db } of entries) if (db) close(db);
  for (const dir of new Set(entries.map(e => e.dir))) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

function fileRecord(p, extra = {}) {
  return { path: p, lang: 'typescript', hash: `${p}#1`, mtimeMs: 1000, size: 100, parseOk: true, errorNodes: 0, indexedAt: 1000, ...extra };
}

const symbol = (kind, name, startLine, endLine, extra = {}) => ({
  kind, name, qual: name, startLine, endLine, startCol: 0, parent: null, ...extra,
});

// src/config.ts: class Parser { method parseConfig }, const cfg, function loadConfig
const CONFIG = {
  symbols: [
    symbol('class', 'Parser', 1, 20, { signature: 'class Parser' }),
    symbol('method', 'parseConfig', 2, 10, { qual: 'Parser.parseConfig', signature: 'parseConfig(raw: string)', parent: 0, startCol: 2 }),
    symbol('variable', 'cfg', 12, 12, { startCol: 6 }),
    symbol('function', 'loadConfig', 14, 20, { signature: 'loadConfig(): void' }),
  ],
  refs: [
    { name: 'cfg', kind: 'ref', startLine: 5, startCol: 4, endLine: 5, symbol: 1, localDef: 2 },
    { name: 'Parser', kind: 'type', startLine: 13, startCol: 4, endLine: 13, symbol: 0 },
    { name: 'parseConfig', kind: 'call', startLine: 16, startCol: 2, endLine: 16, symbol: 3, receiver: 'this' },
  ],
  imports: [{ spec: 'node:fs', names: null, kind: 'import', startLine: 1 }],
};

// src/main.ts: function main() calls loadConfig(), imports ./config
const MAIN = {
  symbols: [symbol('function', 'main', 1, 5)],
  refs: [{ name: 'loadConfig', kind: 'call', startLine: 2, startCol: 2, endLine: 2, symbol: 0 }],
  imports: [{ spec: './config', names: 'loadConfig', kind: 'from', startLine: 1 }],
};

const ftsCount = (db, match) => db.prepare('SELECT COUNT(*) AS count FROM symbols_fts WHERE symbols_fts MATCH ?').get(match).count;
const names = rows => rows.map(r => r.name);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('db', () => {
  test('openDatabase creates the parent directory and every table, with foreign keys and WAL on', () => {
    const { db, file } = tmpDb();
    assert.equal(fs.existsSync(file), true);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(r => r.name);
    for (const t of ['files', 'symbols', 'refs', 'imports', 'dirty', 'symbols_fts']) {
      assert.equal(tables.includes(t), true, `table ${t} exists`);
    }
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  });

  test('close is idempotent and really releases the file (Windows keeps it locked otherwise)', () => {
    const { db, file } = tmpDb();
    close(db);
    close(db);
    fs.unlinkSync(file);
    assert.equal(fs.existsSync(file), false);
    assert.throws(() => close(null), /close: "db"/);
  });

  test('schema application is idempotent and data survives a reopen', () => {
    const { db, file, dir } = tmpDb();
    upsertFile(db, fileRecord('a.ts'));
    close(db);
    const again = openDatabase(file);
    open.push({ dir, file, db: again });
    assert.equal(countFiles(again), 1);
    assert.equal(getFileByPath(again, 'a.ts').path, 'a.ts');
  });

  test('openDatabase rejects a missing or non-string file', () => {
    assert.throws(() => openDatabase(''), /openDatabase: "file" must be a non-empty string/);
    assert.throws(() => openDatabase(42), TypeError);
  });
});

describe('files', () => {
  test('upsertFile inserts, then updates in place and drops the previous extraction', () => {
    const { db } = tmpDb();
    const id = upsertFile(db, fileRecord('a.ts'));
    assert.equal(Number.isInteger(id) && id > 0, true);
    replaceAllForFile(db, id, CONFIG);
    assert.equal(symbolsInFile(db, 'a.ts').length, 4);

    const again = upsertFile(db, fileRecord('a.ts', { hash: 'a.ts#2', size: 200, parseOk: false, errorNodes: 3 }));
    assert.equal(again, id);
    const row = getFileByPath(db, 'a.ts');
    assert.equal(row.hash, 'a.ts#2');
    assert.equal(row.size, 200);
    assert.equal(row.parse_ok, 0);
    assert.equal(row.error_nodes, 3);
    assert.deepEqual(symbolsInFile(db, 'a.ts'), []);
    assert.deepEqual(refsInFile(db, id), []);
    assert.deepEqual(importsOfFile(db, 'a.ts'), []);
    assert.deepEqual(searchSymbols(db, 'parseConfig'), []);
    assert.equal(ftsCount(db, 'parseconfig*'), 0);
    assert.equal(countFiles(db), 1);
    assert.deepEqual(listFiles(db).map(r => r.path), ['a.ts']);
    assert.equal(getFileByPath(db, 'missing.ts'), null);
  });

  test('upsertFile validates every column and writes nothing on failure', () => {
    const { db } = tmpDb();
    assert.throws(() => upsertFile(db, { ...fileRecord('a.ts'), path: '' }), /upsertFile: "path" must be a non-empty string/);
    assert.throws(() => upsertFile(db, { ...fileRecord('a.ts'), parseOk: 1 }), /upsertFile: "parseOk" must be a boolean/);
    assert.throws(() => upsertFile(db, { ...fileRecord('a.ts'), mtimeMs: 1.5 }), /upsertFile: "mtimeMs" must be an integer/);
    assert.throws(() => upsertFile(db, { ...fileRecord('a.ts'), errorNodes: -1 }), /upsertFile: "errorNodes" must be an integer >= 0/);
    assert.throws(() => upsertFile(db, null), /upsertFile: "file" must be an object/);
    assert.equal(countFiles(db), 0);
  });
});

describe('replaceAllForFile', () => {
  test('maps parent / symbol / localDef indexes to row ids and exposes path and signature', () => {
    const { db } = tmpDb();
    const configId = upsertFile(db, fileRecord('src/config.ts'));
    const mainId = upsertFile(db, fileRecord('src/main.ts'));
    const { symbolIds } = replaceAllForFile(db, configId, CONFIG);
    assert.equal(symbolIds.length, 4);
    assert.equal(new Set(symbolIds).size, 4);
    replaceAllForFile(db, mainId, MAIN);

    const rows = symbolsInFile(db, 'src/config.ts');
    assert.deepEqual(names(rows), ['Parser', 'parseConfig', 'cfg', 'loadConfig']);
    assert.deepEqual(rows.map(r => r.start_line), [1, 2, 12, 14]);
    assert.deepEqual(rows.map(r => r.id), symbolIds);
    assert.ok(rows.every(r => r.path === 'src/config.ts'));
    assert.equal(rows[1].signature, 'parseConfig(raw: string)');
    assert.equal(rows[1].qual, 'Parser.parseConfig');
    assert.equal(rows[1].parent_id, symbolIds[0]);
    assert.equal(rows[0].parent_id, null);
    assert.equal(rows[1].start_col, 2);

    const refs = refsInFile(db, configId);
    assert.deepEqual(names(refs), ['cfg', 'Parser', 'parseConfig']);
    assert.equal(refs[0].symbol_id, symbolIds[1]);
    assert.equal(refs[0].local_def_id, symbolIds[2]);
    assert.equal(refs[1].symbol_id, symbolIds[0]);
    assert.equal(refs[1].local_def_id, null);
    assert.equal(refs[2].receiver, 'this');
    assert.ok(refs.every(r => r.path === 'src/config.ts' && r.target_id === null && r.resolution === null));

    const imports = importsOfFile(db, 'src/config.ts');
    assert.equal(imports.length, 1);
    assert.equal(imports[0].spec, 'node:fs');
    assert.equal(imports[0].names, null);
    assert.equal(imports[0].file_id, configId);
    assert.equal(ftsCount(db, 'parseconfig'), 1);
  });

  test('accepts children listed before their parents and stores import names arrays as JSON', () => {
    const { db } = tmpDb();
    const id = upsertFile(db, fileRecord('a.ts'));
    const { symbolIds } = replaceAllForFile(db, id, {
      symbols: [
        symbol('method', 'run', 2, 3, { qual: 'A.run', parent: 1, startCol: 2 }),
        symbol('class', 'A', 1, 4),
      ],
      refs: [],
      imports: [{ spec: './x', names: [{ imported: 'a', alias: 'b' }], kind: 'from', startLine: 1 }],
    });
    const rows = symbolsInFile(db, 'a.ts');
    assert.equal(rows.find(r => r.name === 'run').parent_id, symbolIds[1]);
    assert.equal(JSON.parse(importsOfFile(db, 'a.ts')[0].names)[0].imported, 'a');
  });

  test('rejects invalid input naming the offending field and writes nothing', () => {
    const { db } = tmpDb();
    const id = upsertFile(db, fileRecord('a.ts'));
    const base = symbol('function', 'f', 1, 1);
    const ref = { name: 'x', kind: 'ref', startLine: 1, startCol: 0, endLine: 1 };

    assert.throws(() => replaceAllForFile(db, id, { symbols: 'nope' }), /replaceAllForFile: "symbols" must be an array/);
    assert.throws(() => replaceAllForFile(db, id, { symbols: [{ ...base, name: '' }] }), /"symbols\[0\].name" must be a non-empty string/);
    assert.throws(() => replaceAllForFile(db, id, { symbols: [{ ...base, endLine: 0 }] }), /"symbols\[0\].endLine" must be an integer >= 1/);
    assert.throws(() => replaceAllForFile(db, id, { symbols: [{ ...base, parent: 5 }] }), /"symbols\[0\].parent" must be null or the index of another symbol/);
    assert.throws(() => replaceAllForFile(db, id, { symbols: [{ ...base, parent: 0 }] }), /"symbols\[0\].parent"/);
    assert.throws(
      () => replaceAllForFile(db, id, { symbols: [{ ...base, parent: 1 }, { ...base, parent: 0 }] }),
      /"symbols\[1\].parent" forms a cycle/
    );
    assert.throws(() => replaceAllForFile(db, id, { refs: [{ ...ref, symbol: 3 }] }), /"refs\[0\].symbol" must be null or a symbols index/);
    assert.throws(() => replaceAllForFile(db, id, { refs: [{ ...ref, localDef: 0 }] }), /"refs\[0\].localDef" must be null or a symbols index/);
    assert.throws(() => replaceAllForFile(db, id, { refs: [{ ...ref, startCol: undefined, startLine: 0 }] }), /"refs\[0\].startLine"/);
    assert.throws(() => replaceAllForFile(db, id, { imports: [{ spec: 'x', names: 42, kind: 'import', startLine: 1 }] }), /"imports\[0\].names" must be a string, an array or null/);
    assert.throws(() => replaceAllForFile(db, id, { imports: [{ spec: 'x', kind: 'import', startLine: 0 }] }), /"imports\[0\].startLine" must be an integer >= 1/);

    assert.deepEqual(symbolsInFile(db, 'a.ts'), []);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM refs').get().count, 0);
    assert.equal(ftsCount(db, 'f'), 0);
  });

  test('throws for an unknown or invalid file id', () => {
    const { db } = tmpDb();
    assert.throws(() => replaceAllForFile(db, 999, CONFIG), /replaceAllForFile: no file with id 999/);
    assert.throws(() => replaceAllForFile(db, 0, CONFIG), /replaceAllForFile: "fileId" must be an integer >= 1/);
    assert.throws(() => replaceAllForFile(db, null, CONFIG), /"fileId"/);
  });

  test('a replace keeps the ids of unchanged definitions, gives new ones fresh ids and follows the FTS content', () => {
    const { db } = tmpDb();
    const configId = upsertFile(db, fileRecord('src/config.ts'));
    const mainId = upsertFile(db, fileRecord('src/main.ts'));
    const otherId = upsertFile(db, fileRecord('src/other.ts'));
    const first = replaceAllForFile(db, configId, CONFIG).symbolIds;
    replaceAllForFile(db, mainId, MAIN);
    replaceAllForFile(db, otherId, { symbols: [symbol('function', 'g', 1, 1)], refs: [{ name: 'parseConfig', kind: 'call', startLine: 1, startCol: 2, endLine: 1, symbol: 0 }], imports: [] });
    const mainRef = refsInFile(db, mainId)[0];
    const otherRef = refsInFile(db, otherId)[0];
    setRefResolution(db, [
      { refId: mainRef.id, targetId: first[3], resolution: '~' }, // main.ts -> config.loadConfig (removed below)
      { refId: otherRef.id, targetId: first[1], resolution: '=' }, // other.ts -> config.parseConfig (kept below)
    ]);

    // Same definitions with moved lines and a new signature for parseConfig:
    // Parser, parseConfig and cfg keep their ids, loadConfig is gone.
    const moved = {
      symbols: [
        CONFIG.symbols[0],
        { ...CONFIG.symbols[1], startLine: 3, endLine: 11, signature: 'parseConfig(raw: string, strict: boolean)' },
        { ...CONFIG.symbols[2], startLine: 13, endLine: 13 },
      ],
      refs: CONFIG.refs.slice(0, 2),
      imports: CONFIG.imports,
    };
    const second = replaceAllForFile(db, configId, moved).symbolIds;
    assert.deepEqual(second, first.slice(0, 3), 'unchanged definitions keep their ids');
    const rows = symbolsInFile(db, 'src/config.ts');
    assert.deepEqual(rows.map(r => r.id), second);
    assert.deepEqual(rows.map(r => [r.start_line, r.signature]), [[1, 'class Parser'], [3, 'parseConfig(raw: string, strict: boolean)'], [13, null]]);
    assert.equal(rows[1].parent_id, first[0]);
    assert.deepEqual(names(rows), ['Parser', 'parseConfig', 'cfg']);
    // The file's own refs are pending again and name the kept ids.
    assert.deepEqual(refsInFile(db, configId).map(r => r.symbol_id), [second[1], second[0]]);
    assert.equal(refsInFile(db, configId)[0].local_def_id, second[2]);
    assert.ok(refsInFile(db, configId).every(r => r.target_id === null && r.resolution === null));
    // Elsewhere: the ref to the removed symbol is detached, the one to a kept
    // symbol is untouched.
    const detached = refsInFile(db, mainId)[0];
    assert.equal(detached.id, mainRef.id);
    assert.equal(detached.target_id, null);
    assert.equal(detached.resolution, null);
    assert.deepEqual(refsTo(db, first[3]), []);
    assert.deepEqual(unresolvedRefs(db, { fileId: mainId }).map(r => r.name), ['loadConfig']);
    assert.deepEqual([otherRef.id, refsInFile(db, otherId)[0].target_id, refsInFile(db, otherId)[0].resolution], [otherRef.id, first[1], '=']);
    assert.deepEqual(refsTo(db, first[1]).map(r => r.path), ['src/other.ts']);

    // FTS follows the content: the new signature is indexed, the old is gone.
    assert.equal(ftsCount(db, 'loadconfig*'), 0);
    assert.equal(ftsCount(db, 'parseconfig*'), 1);
    assert.equal(ftsCount(db, 'strict'), 1, 'the new signature text is indexed');
    // A removed name is not matched as such any more: the search falls back to the words it
    // still finds and reports which one it dropped.
    const gone = searchSymbolsDetailed(db, 'loadConfig');
    assert.deepEqual(gone.dropped, ['load']);
    assert.equal(gone.rows.some((r) => r.name === 'loadConfig'), false);
    assert.deepEqual(names(searchSymbols(db, 'parseConfig')), ['parseConfig']);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  });

  test('a definition whose kind, qual or name changed, and every member of an ambiguous key group, gets a fresh id', () => {
    const { db } = tmpDb();
    const id = upsertFile(db, fileRecord('a.ts'));
    // Two methods named run of one class: the key is ambiguous on the old side.
    const first = replaceAllForFile(db, id, {
      symbols: [
        symbol('class', 'C', 1, 10),
        symbol('method', 'run', 2, 3, { qual: 'C.run', parent: 0 }),
        symbol('method', 'run', 4, 5, { qual: 'C.run', parent: 0 }),
        symbol('function', 'helper', 12, 12),
      ],
      refs: [],
      imports: [],
    }).symbolIds;
    // Now one run remains and helper moved under C (its qual changed).
    const second = replaceAllForFile(db, id, {
      symbols: [
        symbol('class', 'C', 1, 10),
        symbol('method', 'run', 2, 3, { qual: 'C.run', parent: 0 }),
        symbol('method', 'helper', 12, 12, { qual: 'C.helper', parent: 0 }),
      ],
      refs: [],
      imports: [],
    }).symbolIds;
    assert.equal(second[0], first[0], 'the class is unchanged: same id');
    assert.ok(!first.includes(second[1]), 'run was ambiguous before: not paired');
    assert.ok(!first.includes(second[2]), 'helper changed qual: not paired');
    assert.equal(symbolById(db, second[2]).parent_id, second[0]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM symbols WHERE file_id = ?').get(id).n, 3);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    // A kept parent with a new child: the child is inserted with the parent's kept id.
    const third = replaceAllForFile(db, id, {
      symbols: [
        symbol('class', 'C', 1, 10),
        symbol('method', 'run', 2, 3, { qual: 'C.run', parent: 0 }),
        symbol('method', 'helper', 12, 12, { qual: 'C.helper', parent: 0 }),
        symbol('method', 'extra', 14, 14, { qual: 'C.extra', parent: 0 }),
      ],
      refs: [],
      imports: [],
    }).symbolIds;
    assert.deepEqual(third.slice(0, 3), second);
    assert.equal(symbolById(db, third[3]).parent_id, second[0]);
    assert.equal(ftsCount(db, 'helper'), 1);
  });

  test('the files whose refs were made pending are recorded for the resolver until its pass succeeds', () => {
    const { db } = tmpDb();
    const configId = upsertFile(db, fileRecord('src/config.ts'));
    const mainId = upsertFile(db, fileRecord('src/main.ts'));
    const otherId = upsertFile(db, fileRecord('src/other.ts'));
    const first = replaceAllForFile(db, configId, CONFIG).symbolIds;
    replaceAllForFile(db, mainId, MAIN);
    replaceAllForFile(db, otherId, { symbols: [symbol('function', 'g', 1, 1)], refs: [{ name: 'loadConfig', kind: 'call', startLine: 1, startCol: 2, endLine: 1, symbol: 0 }], imports: [] });
    setRefResolution(db, [
      { refId: refsInFile(db, mainId)[0].id, targetId: first[3], resolution: '~' },
      { refId: refsInFile(db, otherId)[0].id, targetId: first[3], resolution: '~' },
    ]);
    assert.deepEqual([...pendingFiles(db)], [], 'nothing pending yet');

    // loadConfig goes: both files' refs are pending again and both are recorded.
    replaceAllForFile(db, configId, { symbols: CONFIG.symbols.slice(0, 3), refs: CONFIG.refs.slice(0, 2), imports: CONFIG.imports });
    assert.deepEqual([...pendingFiles(db)].sort(), [mainId, otherId].sort());
    assert.deepEqual([...pendingFiles(db)].sort(), [mainId, otherId].sort(), 'reading does not consume: a failed resolver pass must find them');
    clearPendingFiles(db);
    assert.deepEqual([...pendingFiles(db)], []);
    // A replace that keeps every definition records nothing.
    replaceAllForFile(db, configId, CONFIG);
    assert.deepEqual([...pendingFiles(db)], []);
    // A deletion records every file still pointing at the deleted definitions.
    setRefResolution(db, [{ refId: refsInFile(db, mainId)[0].id, targetId: first[1], resolution: '=' }]);
    deleteFile(db, 'src/config.ts');
    assert.deepEqual([...pendingFiles(db)], [mainId]);
    assert.equal(refsInFile(db, mainId)[0].target_id, null);
  });
});

describe('deleteFile', () => {
  test('cascades symbols / refs / imports / FTS and detaches other files', () => {
    const { db } = tmpDb();
    const configId = upsertFile(db, fileRecord('src/config.ts'));
    const mainId = upsertFile(db, fileRecord('src/main.ts'));
    const s = replaceAllForFile(db, configId, CONFIG).symbolIds;
    const m = replaceAllForFile(db, mainId, MAIN).symbolIds;
    db.prepare('UPDATE imports SET resolved_file_id = ? WHERE file_id = ?').run(configId, mainId);
    const configRef = refsInFile(db, configId)[2];
    setRefResolution(db, [{ refId: configRef.id, targetId: m[0], resolution: '=' }]);
    assert.equal(importersOfPath(db, 'src/config.ts').length, 1);

    assert.equal(deleteFile(db, 'src/main.ts'), true);
    assert.equal(deleteFile(db, 'src/main.ts'), false);
    assert.equal(getFileByPath(db, 'src/main.ts'), null);
    assert.equal(countFiles(db), 1);
    for (const table of ['symbols', 'refs', 'imports']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE file_id = ?`).get(mainId).count, 0, table);
    }
    assert.equal(ftsCount(db, 'main'), 0);
    assert.equal(ftsCount(db, 'loadconfig'), 1);

    const detached = refsInFile(db, configId)[2];
    assert.equal(detached.target_id, null);
    assert.equal(detached.resolution, null);
    assert.deepEqual(refsTo(db, m[0]), []);
    assert.equal(symbolsInFile(db, 'src/config.ts').length, 4);
    assert.deepEqual(importsOfFile(db, 'src/config.ts').map(r => r.spec), ['node:fs']);
    assert.deepEqual(importersOfPath(db, 'src/config.ts'), []);
    assert.equal(symbolById(db, m[0]), null);
    assert.equal(deleteFile(db, 'src/config.ts'), true);
    assert.equal(countFiles(db), 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM symbols').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM refs').get().count, 0);
    assert.equal(ftsCount(db, 'parser'), 0);
  });

  test('validates the path', () => {
    const { db } = tmpDb();
    assert.throws(() => deleteFile(db, ''), /deleteFile: "path" must be a non-empty string/);
  });
});

describe('setRefResolution', () => {
  test('writes =, ~, ? with their target and unresolvedRefs lists only unprocessed refs', () => {
    const { db } = tmpDb();
    const configId = upsertFile(db, fileRecord('src/config.ts'));
    const mainId = upsertFile(db, fileRecord('src/main.ts'));
    const s = replaceAllForFile(db, configId, CONFIG).symbolIds;
    replaceAllForFile(db, mainId, MAIN);
    const refs = refsInFile(db, configId);

    assert.equal(unresolvedRefs(db).length, 4);
    const written = setRefResolution(db, [
      { refId: refs[0].id, targetId: s[1], resolution: '=' },
      { refId: refs[1].id, targetId: s[0], resolution: '~' },
      { refId: refs[2].id, targetId: null, resolution: '?' },
    ]);
    assert.equal(written, 3);
    assert.deepEqual(
      refsInFile(db, configId).map(r => [r.target_id, r.resolution]),
      [[s[1], '='], [s[0], '~'], [null, '?']]
    );
    assert.deepEqual(unresolvedRefs(db).map(r => r.name), ['loadConfig']);
    assert.deepEqual(unresolvedRefs(db, { fileId: configId }), []);
    assert.deepEqual(unresolvedRefs(db, { fileId: mainId }).map(r => r.path), ['src/main.ts']);
    assert.deepEqual(refsTo(db, s[0]).map(r => r.name), ['Parser']);
  });

  test('rejects bad batches as a whole and unknown ref ids', () => {
    const { db } = tmpDb();
    const configId = upsertFile(db, fileRecord('src/config.ts'));
    const s = replaceAllForFile(db, configId, CONFIG).symbolIds;
    const refs = refsInFile(db, configId);
    setRefResolution(db, [{ refId: refs[0].id, targetId: s[1], resolution: '=' }]);

    assert.throws(() => setRefResolution(db, 'nope'), /setRefResolution: "entries" must be an array/);
    assert.throws(() => setRefResolution(db, [{ refId: refs[0].id, targetId: null, resolution: 'x' }]), /"entries\[0\].resolution" must be one of "=", "~", "\?"/);
    assert.throws(() => setRefResolution(db, [{ refId: 0, targetId: null, resolution: '?' }]), /"entries\[0\].refId" must be an integer >= 1/);
    assert.throws(() => setRefResolution(db, [{ refId: refs[1].id, targetId: 'abc', resolution: '=' }]), /"entries\[0\].targetId" must be an integer/);
    // The first entry is valid but the batch is rejected before anything runs.
    assert.throws(
      () => setRefResolution(db, [
        { refId: refs[1].id, targetId: s[0], resolution: '~' },
        { refId: 999, targetId: null, resolution: '?' },
      ]),
      /setRefResolution: no ref with id 999/
    );
    assert.equal(refsInFile(db, configId)[1].resolution, null);
    assert.equal(refsInFile(db, configId)[0].resolution, '=');
  });

  test('many rows are batched by target and resolution: last entry wins, a missing id rejects the batch', () => {
    const { db } = tmpDb();
    const id = upsertFile(db, fileRecord('big.ts'));
    const symbols = Array.from({ length: 3 }, (_, i) => symbol('function', `f${i}`, i + 1, i + 1));
    const refs = Array.from({ length: 120 }, (_, i) => ({ name: `f${i % 3}`, kind: 'call', startLine: i + 1, startCol: 0, endLine: i + 1 }));
    const s = replaceAllForFile(db, id, { symbols, refs }).symbolIds;
    const rows = refsInFile(db, id);
    const entries = rows.map((r, i) => ({ refId: r.id, targetId: i % 4 === 0 ? null : s[i % 3], resolution: i % 4 === 0 ? '?' : '~' }));
    entries.push({ refId: rows[0].id, targetId: s[1], resolution: '=' }); // listed twice: the last entry wins
    assert.equal(setRefResolution(db, entries), 121);
    const after = refsInFile(db, id);
    assert.deepEqual([after[0].target_id, after[0].resolution], [s[1], '=']);
    assert.deepEqual([after[4].target_id, after[4].resolution], [null, '?']);
    assert.deepEqual([after[5].target_id, after[5].resolution], [s[2], '~']);
    assert.deepEqual(after.reduce((acc, r) => { acc[r.resolution]++; return acc; }, { '=': 0, '~': 0, '?': 0 }), { '=': 1, '~': 90, '?': 29 });

    const bad = entries.map((e) => ({ ...e }));
    bad[70].refId = 999;
    assert.throws(() => setRefResolution(db, bad), /setRefResolution: no ref with id 999 \(changed 119 of 120 refs\)/);
    assert.equal(refsInFile(db, id)[4].resolution, '?', 'nothing was written');
    // Below the batch threshold the per-row path reports the same way.
    assert.throws(() => setRefResolution(db, bad.slice(60, 80)), /setRefResolution: no ref with id 999$/);
  });
});

describe('lookups', () => {
  test('return rows with path, and empty results when nothing matches', () => {
    const { db } = tmpDb();
    const configId = upsertFile(db, fileRecord('src/config.ts'));
    const mainId = upsertFile(db, fileRecord('src/main.ts'));
    const s = replaceAllForFile(db, configId, CONFIG).symbolIds;
    replaceAllForFile(db, mainId, MAIN);
    db.prepare('UPDATE imports SET resolved_file_id = ? WHERE file_id = ?').run(configId, mainId);
    const cfgRef = refsInFile(db, configId)[0];
    setRefResolution(db, [{ refId: cfgRef.id, targetId: s[1], resolution: '=' }]);

    assert.equal(symbolById(db, s[1]).name, 'parseConfig');
    assert.equal(symbolById(db, s[1]).path, 'src/config.ts');
    assert.equal(symbolById(db, s[1]).signature, 'parseConfig(raw: string)');
    assert.equal(symbolById(db, 999999), null);
    assert.throws(() => symbolById(db, 'x'), /symbolById: "id" must be an integer/);

    assert.deepEqual(importsOfFile(db, 'src/main.ts').map(r => [r.spec, r.path]), [['./config', 'src/main.ts']]);
    assert.deepEqual(importsOfFile(db, 'nope.ts'), []);
    assert.deepEqual(importersOfPath(db, 'src/config.ts').map(r => [r.path, r.spec]), [['src/main.ts', './config']]);
    assert.deepEqual(importersOfPath(db, 'nope.ts'), []);

    assert.deepEqual(refsTo(db, s[1]).map(r => [r.name, r.path, r.resolution]), [['cfg', 'src/config.ts', '=']]);
    assert.deepEqual(refsTo(db, s[2]), []);
    assert.deepEqual(refsByName(db, 'parseConfig').map(r => r.start_line), [16]);
    assert.deepEqual(refsByName(db, 'nope'), []);
    assert.deepEqual(names(refsInFile(db, configId)), ['cfg', 'Parser', 'parseConfig']);
    assert.deepEqual(refsInFile(db, 999), []);

    assert.deepEqual(symbolsInFile(db, 'nope.ts'), []);
    assert.deepEqual(findSymbolsByName(db, 'cfg').map(r => r.path), ['src/config.ts']);
    assert.deepEqual(findSymbolsByName(db, 'parseconfig'), []);
    assert.deepEqual(names(findSymbolsByName(db, 'parseconfig', { exact: false })), ['parseConfig']);
    assert.deepEqual(names(findSymbolsByName(db, 'zzz', { exact: false })), []);
    assert.equal(symbolById(db, s[3]).name, 'loadConfig');
  });
});

describe('dirty', () => {
  test('markDirty keeps one row per path with the earliest at; takeDirty drains oldest first', async () => {
    const { db } = tmpDb();
    assert.equal(markDirty(db, []), 0);
    assert.equal(dirtyCount(db), 0);

    markDirty(db, ['a.ts', 'b.ts']);
    const firstAt = db.prepare('SELECT at FROM dirty WHERE path = ?').get('a.ts').at;
    await sleep(5);
    markDirty(db, ['a.ts', 'c.ts']);
    assert.equal(dirtyCount(db), 3);
    assert.equal(db.prepare('SELECT at FROM dirty WHERE path = ?').get('a.ts').at, firstAt);
    assert.equal(db.prepare('SELECT at FROM dirty WHERE path = ?').get('c.ts').at > firstAt, true);

    const taken = takeDirty(db, 1);
    assert.equal(taken.length, 1);
    assert.equal(taken[0].path, 'a.ts');
    assert.equal(taken[0].at, firstAt);
    assert.equal(dirtyCount(db), 2);
    assert.deepEqual(takeDirty(db).map(r => r.path), ['b.ts', 'c.ts']);
    assert.equal(dirtyCount(db), 0);
    assert.deepEqual(takeDirty(db), []);

    assert.throws(() => takeDirty(db, 0), /takeDirty: "limit" must be an integer >= 1/);
    assert.throws(() => markDirty(db, 'a.ts'), /markDirty: "paths" must be an array/);
    assert.throws(() => markDirty(db, ['a.ts', 7]), /markDirty: "paths\[1\]" must be a non-empty string/);
  });

  test('dirtyPaths answers only for the paths asked about', () => {
    const { db } = tmpDb();
    assert.deepEqual([...dirtyPaths(db, [])], []);
    markDirty(db, ['a.ts', 'b.ts', 'c.ts']);
    assert.deepEqual([...dirtyPaths(db, ['c.ts', 'zz.ts', 'c.ts', 'a.ts'])].sort(), ['a.ts', 'c.ts'], 'only the dirty ones, each once');
    assert.deepEqual([...dirtyPaths(db, ['zz.ts'])], []);
    assert.deepEqual([...dirtyPaths(db, ['a.ts', 'b.ts', 'c.ts'])].sort(), ['a.ts', 'b.ts', 'c.ts']);
    assert.throws(() => dirtyPaths(db), /dirtyPaths: "paths" must be an array/);
    assert.throws(() => dirtyPaths(db, 'a.ts'), /dirtyPaths: "paths" must be an array/);
  });
});

describe('transactions', () => {
  test('purges leave foreign keys enabled, no dangling keys, and nest inside a caller transaction', () => {
    const { db } = tmpDb();
    const configId = upsertFile(db, fileRecord('src/config.ts'));
    const mainId = upsertFile(db, fileRecord('src/main.ts'));
    const first = replaceAllForFile(db, configId, CONFIG).symbolIds;
    replaceAllForFile(db, mainId, MAIN);
    setRefResolution(db, [{ refId: refsInFile(db, mainId)[0].id, targetId: first[3], resolution: '~' }]);

    // Fast path (own transaction): definitions that survive keep their ids, so
    // the other file's ref stays attached; a removed one detaches it explicitly,
    // with FK enforcement back afterwards either way.
    const kept = replaceAllForFile(db, configId, CONFIG).symbolIds;
    assert.deepEqual(kept, first);
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.deepEqual([refsInFile(db, mainId)[0].target_id, refsInFile(db, mainId)[0].resolution], [first[3], '~'], 'still attached');
    replaceAllForFile(db, configId, { symbols: CONFIG.symbols.slice(0, 3), refs: CONFIG.refs.slice(0, 2), imports: CONFIG.imports });
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.equal(refsInFile(db, mainId)[0].target_id, null);
    assert.equal(refsInFile(db, mainId)[0].resolution, null);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

    // Nested path: the caller owns the transaction, so the replace keeps FK
    // enforcement (SET NULL through the schema) and the savepoint nests.
    const second = replaceAllForFile(db, configId, CONFIG).symbolIds;
    setRefResolution(db, [{ refId: refsInFile(db, mainId)[0].id, targetId: second[3], resolution: '~' }]);
    db.exec('BEGIN');
    try {
      replaceAllForFile(db, configId, CONFIG);
      assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
      assert.equal(refsInFile(db, mainId)[0].target_id, second[3], 'a surviving definition keeps the ref attached');
      deleteFile(db, 'src/main.ts');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.equal(symbolsInFile(db, 'src/config.ts').length, 4);
    assert.equal(getFileByPath(db, 'src/main.ts'), null);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM refs').get().count, 3);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });

  test('a failing write rolls back completely and keeps the handle usable with foreign keys on', () => {
    const { db } = tmpDb();
    const id = upsertFile(db, fileRecord('a.ts'));
    replaceAllForFile(db, id, CONFIG);
    const before = symbolsInFile(db, 'a.ts').map(r => r.id);

    // The purge has already run when the ref insert aborts, so only a real
    // rollback can bring the previous extraction back.
    db.exec("CREATE TRIGGER boom BEFORE INSERT ON refs BEGIN SELECT RAISE(ABORT, 'boom'); END");
    assert.throws(() => replaceAllForFile(db, id, CONFIG), /boom/);
    db.exec('DROP TRIGGER boom');

    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.deepEqual(symbolsInFile(db, 'a.ts').map(r => r.id), before);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM refs').get().count, 3);
    assert.equal(ftsCount(db, 'parseconfig'), 1);
    replaceAllForFile(db, id, CONFIG);
    assert.equal(symbolsInFile(db, 'a.ts').length, 4);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM refs').get().count, 3);
  });
});

describe('meta', () => {
  test('metaGet / metaSet round-trip and upsert', () => {
    const { db } = tmpDb();
    assert.equal(metaGet(db, 'schema'), null);
    metaSet(db, 'schema', '1');
    metaSet(db, 'schema', '2');
    assert.equal(metaGet(db, 'schema'), '2');
    assert.throws(() => metaSet(db, 'k', 1), /metaSet: "value" must be a string/);
    assert.throws(() => metaGet(db, ''), /metaGet: "key" must be a non-empty string/);
  });
});

describe('bulk writes', () => {
  // Symbols / refs / imports go in as multi-row VALUES statements of at most
  // 200 rows (then 20, 4, 1). The sizes below hit every boundary: exact
  // multiples of a shape, one past it, and a parent chain whose members land in
  // different statements.
  test('replaceAllForFile keeps ids, parents and FTS rows right across multi-row statement boundaries', () => {
    const { db } = tmpDb();
    const fileId = upsertFile(db, fileRecord('big.ts'));
    for (const count of [200, 201, 220, 221, 450]) {
      // Every 5th symbol is a class, the four after it its methods.
      const symbols = [];
      for (let i = 0; i < count; i++) {
        const isClass = i % 5 === 0;
        symbols.push(symbol(isClass ? 'class' : 'method', isClass ? `C${i}` : `m${i}`, i + 1, i + 1, {
          qual: isClass ? `C${i}` : `C${i - (i % 5)}.m${i}`,
          parent: isClass ? null : i - (i % 5),
          exported: isClass,
        }));
      }
      const refs = symbols.map((s, i) => ({
        name: `m${(i * 7) % symbols.length}`, kind: 'call', startLine: i + 1, startCol: 1, endLine: i + 1,
        symbol: i, localDef: i % 5 === 0 ? null : i - (i % 5),
      }));
      const imports = symbols.map((s, i) => ({ spec: `./mod${i}`, kind: 'import', startLine: i + 1 }));

      const { symbolIds } = replaceAllForFile(db, fileId, { symbols, refs, imports });
      assert.equal(symbolIds.length, count);
      assert.equal(new Set(symbolIds).size, count);
      const rows = symbolsInFile(db, 'big.ts');
      assert.deepEqual(rows.map(r => r.id), symbolIds, `${count}: ids follow the input order`);
      rows.forEach((r, i) => {
        const p = symbols[i].parent;
        assert.equal(r.parent_id, p === null ? null : symbolIds[p], `${count}: parent of symbol ${i}`);
        assert.equal(r.exported, symbols[i].exported ? 1 : 0);
      });
      const storedRefs = refsInFile(db, fileId);
      assert.equal(storedRefs.length, count);
      storedRefs.forEach((r, i) => {
        assert.equal(r.symbol_id, symbolIds[i]);
        assert.equal(r.local_def_id, refs[i].localDef === null ? null : symbolIds[refs[i].localDef]);
      });
      assert.equal(importsOfFile(db, 'big.ts').length, count);
      // FTS rows follow the content rows into every statement shape.
      for (const i of [0, 200, 220, 445].filter((i) => i < count)) {
        assert.equal(ftsCount(db, `c${i}`), 1, `${count}: FTS row for C${i}`);
        assert.equal(symbolById(db, symbolIds[i]).name, `C${i}`);
      }
      assert.equal(ftsCount(db, 'c445'), count > 445 ? 1 : 0, 'rows of the previous replace are gone');
    }
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  });

  test('takePurgedSymbols reports what a replace or delete removed, per file, once', () => {
    const { db } = tmpDb();
    clearPurgedSymbols(db); // never created: no-op
    const a = upsertFile(db, fileRecord('a.ts'));
    const b = upsertFile(db, fileRecord('b.ts'));
    replaceAllForFile(db, a, CONFIG);
    assert.equal(takePurgedSymbols(db).size, 0, 'a first extraction removes nothing');

    replaceAllForFile(db, a, { symbols: CONFIG.symbols.slice(0, 3), refs: CONFIG.refs.slice(0, 2), imports: CONFIG.imports });
    const purged = takePurgedSymbols(db);
    assert.deepEqual([...purged.keys()], [a]);
    assert.deepEqual(purged.get(a).map(r => [r.name, r.kind, r.exported, r.top]), [
      ['Parser', 'class', null, 1],
      ['parseConfig', 'method', null, 0],
      ['cfg', 'variable', null, 1],
      ['loadConfig', 'function', null, 1],
    ]);
    assert.equal(takePurgedSymbols(db).size, 0, 'consumed');

    replaceAllForFile(db, b, CONFIG);
    deleteFile(db, 'b.ts');
    assert.deepEqual(takePurgedSymbols(db).get(b).map(r => r.name), names(CONFIG.symbols));
    replaceAllForFile(db, a, CONFIG);
    clearPurgedSymbols(db);
    assert.equal(takePurgedSymbols(db).size, 0, 'cleared without consuming');
  });

  test('beginWriteGroup commits several files in one commit and keeps each file atomic on its own', () => {
    const entry = tmpDb();
    const { db, file } = entry;
    const reader = openDatabase(file); // a second connection sees committed state only
    open.push({ dir: entry.dir, db: reader });

    const end = beginWriteGroup(db);
    replaceFile(db, fileRecord('g1.ts'), CONFIG);
    assert.equal(countFiles(db), 1, 'visible on the writing connection');
    assert.equal(countFiles(reader), 0, 'not committed yet');
    // A failing file rolls back to its own savepoint; the group stays open and usable.
    assert.throws(() => replaceFile(db, fileRecord('g2.ts'), { symbols: 'nope' }), /replaceAllForFile: "symbols" must be an array/);
    assert.equal(getFileByPath(db, 'g2.ts'), null, 'the file row went with it');
    replaceFile(db, fileRecord('g3.ts'), CONFIG);
    assert.equal(countFiles(reader), 0);
    end();
    end(); // idempotent
    assert.equal(countFiles(reader), 2, 'one commit for the whole group');
    assert.deepEqual(listFiles(reader).map(r => r.path), ['g1.ts', 'g3.ts']);
    assert.equal(symbolsInFile(reader, 'g3.ts').length, 4);

    // After the group, writes commit on their own again.
    replaceFile(db, fileRecord('g2.ts'), CONFIG);
    assert.equal(countFiles(reader), 3);
  });
});

describe('bulk load', () => {
  const PLUGIN = path.resolve(import.meta.dirname, '..', '..');
  const schemaIndexNames = () =>
    [...fs.readFileSync(path.join(PLUGIN, 'src', 'store', 'schema.sql'), 'utf8').matchAll(/CREATE INDEX IF NOT EXISTS (\w+)\s+ON (?:refs|symbols)\s*\(/g)]
      .map((m) => m[1]).sort();
  const indexNames = (db) =>
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('refs', 'symbols') AND sql IS NOT NULL ORDER BY name").all().map((r) => r.name);
  const fk = (db) => db.prepare('PRAGMA foreign_keys').get().foreign_keys;

  test('begin clears every row and FTS entry, drops the schema indexes and turns FKs off; end rebuilds, verifies and analyzes', () => {
    const { db } = tmpDb();
    assert.deepEqual(schemaIndexNames().length, 9, 'the schema declares the nine refs/symbols indexes');
    const configId = upsertFile(db, fileRecord('src/config.ts'));
    const mainId = upsertFile(db, fileRecord('src/main.ts'));
    const s = replaceAllForFile(db, configId, CONFIG).symbolIds;
    replaceAllForFile(db, mainId, MAIN);
    setRefResolution(db, [{ refId: refsInFile(db, mainId)[0].id, targetId: s[3], resolution: '~' }]);
    assert.ok(ftsCount(db, 'parser') >= 1);

    beginBulkLoad(db);
    for (const t of ['files', 'symbols', 'refs', 'imports']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, `${t} cleared`);
    assert.equal(ftsCount(db, 'parser'), 0, 'FTS index rebuilt from the empty content table');
    assert.deepEqual(indexNames(db), [], 'refs/symbols indexes dropped');
    assert.equal(fk(db), 0);
    assert.equal(takePurgedSymbols(db).size, 0, 'nothing to compare against after a full clear');
    assert.equal(symbolById(db, s[1]), null);

    // Writes during the load: a new file needs no purge (the file indexes are
    // gone), and FK checks are deferred to the end.
    const bulkId = upsertFile(db, fileRecord('bulk.ts'));
    const ids = replaceAllForFile(db, bulkId, CONFIG).symbolIds;
    db.prepare('UPDATE refs SET target_id = ? WHERE file_id = ?').run(ids[1], bulkId);
    assert.deepEqual(indexNames(db), [], 'still no index while loading');
    assert.equal(endBulkLoad(db), true);
    assert.equal(fk(db), 1);
    assert.deepEqual(indexNames(db), schemaIndexNames(), 'exactly the schema indexes are back');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'sqlite_stat1'").get(), 'ANALYZE ran');
    assert.deepEqual(names(symbolsInFile(db, 'bulk.ts')), names(CONFIG.symbols));
    assert.equal(refsInFile(db, bulkId).length, CONFIG.refs.length);
    assert.equal(refsTo(db, ids[1]).length, CONFIG.refs.length, 'targets written during the load are kept');
    assert.equal(ftsCount(db, 'parser'), 1);
    assert.equal(endBulkLoad(db), false, 'nothing left to finish');
  });

  test('end rejects a dangling key with its count and still leaves the index usable', () => {
    const { db } = tmpDb();
    beginBulkLoad(db);
    const id = upsertFile(db, fileRecord('x.ts'));
    replaceAllForFile(db, id, CONFIG);
    db.prepare('UPDATE refs SET target_id = 99999 WHERE file_id = ?').run(id); // accepted while FKs are off
    assert.throws(() => endBulkLoad(db), /endBulkLoad: 3 foreign key violation\(s\) after the bulk load \(first: refs rowid \d+ -> symbols\)/);
    assert.equal(fk(db), 1, 'enforcement is back on');
    assert.deepEqual(indexNames(db), schemaIndexNames(), 'indexes are back');
    assert.equal(endBulkLoad(db), false, 'the load is no longer active');
  });

  test('begin and end refuse a transaction or a second load; every group commit verifies the load invariants', () => {
    const { db } = tmpDb();
    assert.throws(() => inTransaction(db, () => beginBulkLoad(db)), /beginBulkLoad: cannot start inside a transaction/);
    beginBulkLoad(db);
    assert.throws(() => beginBulkLoad(db), /already active/);
    assert.throws(() => inTransaction(db, () => endBulkLoad(db)), /endBulkLoad: cannot finish inside a transaction/);

    // Both settings are only effective outside a transaction, so a foreign
    // change happens between two groups and the next commit notices it.
    beginWriteGroup(db)();
    db.exec('PRAGMA foreign_keys = ON');
    assert.throws(() => beginWriteGroup(db)(), /bulk load: PRAGMA foreign_keys was turned back on/);
    db.exec('PRAGMA foreign_keys = OFF');
    // Indexes recreated by another process opening the database (openDatabase runs the
    // schema's CREATE INDEX IF NOT EXISTS) only slow the rest of the load down, so the
    // group commit must go through instead of failing the build.
    db.exec('CREATE INDEX refs_target ON refs(target_id)');
    const fine = beginWriteGroup(db);
    fine();
    assert.equal(endBulkLoad(db), true);
    assert.deepEqual(indexNames(db), schemaIndexNames(), 'endBulkLoad rebuilt every index');
  });

  test('a crash between begin and end leaves an index that openDatabase repairs', () => {
    const entry = tmpDb();
    const first = upsertFile(entry.db, fileRecord('a.ts'));
    replaceAllForFile(entry.db, first, CONFIG);
    beginBulkLoad(entry.db);
    const second = upsertFile(entry.db, fileRecord('b.ts'));
    replaceAllForFile(entry.db, second, CONFIG);
    close(entry.db); // the process dies: no endBulkLoad, indexes still dropped
    const again = openDatabase(entry.file);
    open.push({ dir: entry.dir, db: again });
    assert.deepEqual(indexNames(again), schemaIndexNames(), 'schema.sql recreated the indexes');
    assert.equal(fk(again), 1, 'a new connection starts with FKs on');
    assert.equal(again.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.deepEqual(names(symbolsInFile(again, 'b.ts')), names(CONFIG.symbols), 'the rows written before the crash are complete');
    assert.equal(ftsCount(again, 'parser'), 1);
    assert.equal(endBulkLoad(again), false, 'nothing active on the new connection');
  });
});

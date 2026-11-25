// searchSymbols: style-insensitive FTS5 lookup with exact / prefix priority and
// a LIKE fallback (CONTRACTS.md §7). Shares the temp-database pattern with
// store.test.mjs; files run as separate processes under `node --test`.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, close } from '../../src/store/db.mjs';
import { REF_GROUPS_MAX, REF_ROWS_MAX, SECONDARY_PATH_PARTS, identifierSegments, isSecondaryPath, replaceAllForFile, searchRefs, searchSymbols, searchSymbolsDetailed, upsertFile } from '../../src/store/repo.mjs';

const open = [];

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-store-'));
  const entry = { dir, db: null };
  open.push(entry);
  entry.db = openDatabase(path.join(dir, 'graph.db'));
  return entry;
}

afterEach(() => {
  const entries = open.splice(0);
  for (const { db } of entries) if (db) close(db);
  for (const dir of new Set(entries.map(e => e.dir))) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

// parse2config is unreachable for the tokenizer ("parseconfig*" and
// "parse_config*" do not match its single token) and is only found by LIKE.
const SEED = [
  ['function', 'parse_config'],
  ['function', 'parseConfig'],
  ['function', 'parseconfigFile'],
  ['variable', 'parse'],
  ['class', 'Config'],
  ['function', 'parse2config'],
  ['function', 'parse_config_v2'],
];
const ALL = ['parseConfig', 'parseconfigFile', 'parse_config', 'parse_config_v2', 'parse2config'];
const names = rows => rows.map(r => r.name);
const sameSet = (rows, expected, query) => assert.deepEqual([...new Set(names(rows))].sort(), [...expected].sort(), `query ${JSON.stringify(query)}`);

function seed(db) {
  const id = upsertFile(db, { path: 'src/s.ts', lang: 'ts', hash: 'h', mtimeMs: 1, size: 1, parseOk: true, errorNodes: 0, indexedAt: 1 });
  replaceAllForFile(db, id, {
    symbols: SEED.map(([kind, name], i) => ({ kind, name, qual: name, startLine: i + 1, endLine: i + 1, startCol: 0, parent: null })),
  });
}

describe('identifierSegments', () => {
  test('splits camelCase, snake_case, kebab-case, dots and acronyms into the same segments', () => {
    assert.deepEqual(identifierSegments('parseConfig'), ['parse', 'config']);
    assert.deepEqual(identifierSegments('parse_config'), ['parse', 'config']);
    assert.deepEqual(identifierSegments('parse-config'), ['parse', 'config']);
    assert.deepEqual(identifierSegments('Parse2Config'), ['parse2', 'config']);
    assert.deepEqual(identifierSegments('HTTPServer'), ['http', 'server']);
    assert.deepEqual(identifierSegments('XMLHttpRequest.run'), ['xml', 'http', 'request', 'run']);
    assert.deepEqual(identifierSegments('  '), []);
    assert.deepEqual(identifierSegments('!!!'), []);
  });
});

describe('searchSymbols', () => {
  test('matches across case and naming style; exact name first, then name prefix', () => {
    const { db } = tmpDb();
    seed(db);

    const rows = searchSymbols(db, 'parseConfig');
    assert.equal(names(rows)[0], 'parseConfig');
    assert.equal(names(rows)[1], 'parseconfigFile');
    sameSet(rows, ALL, 'parseConfig');
    assert.ok(rows.every(r => r.path === 'src/s.ts' && r.kind && r.start_line >= 1));
    assert.equal('rank' in rows[0], false);

    for (const query of ['parse_config', 'parse-config', 'parse config', 'parse.config', 'PARSE_CONFIG', 'parse_Config']) {
      sameSet(searchSymbols(db, query), ALL, query);
    }
    assert.equal(names(searchSymbols(db, 'parse_config'))[0], 'parse_config');
    assert.equal(names(searchSymbols(db, 'parseconfigfile'))[0], 'parseconfigFile');
    assert.deepEqual(names(searchSymbols(db, 'parseconfigfile')), ['parseconfigFile']);
  });

  test('kind filter and limit apply', () => {
    const { db } = tmpDb();
    seed(db);

    assert.deepEqual(names(searchSymbols(db, 'parse', { kind: 'variable' })), ['parse']);
    assert.deepEqual(names(searchSymbols(db, 'parse', { kind: 'class' })), []);
    assert.ok(!names(searchSymbols(db, 'parseConfig', { kind: 'function' })).includes('parse'));
    assert.equal(searchSymbols(db, 'parse', { kind: 'function' }).length, 5);

    assert.deepEqual(names(searchSymbols(db, 'parseConfig', { limit: 1 })), ['parseConfig']);
    assert.deepEqual(names(searchSymbols(db, 'parseConfig', { limit: 2 })), ['parseConfig', 'parseconfigFile']);
    assert.equal(searchSymbols(db, 'parseConfig', { limit: 3 }).length, 3);
    assert.equal(searchSymbols(db, 'parseConfig', { limit: 500 }).length, 5);
  });

  test('LIKE-only hits rank after FTS hits', () => {
    const { db } = tmpDb();
    seed(db);
    const order = names(searchSymbols(db, 'parseConfig'));
    assert.ok(order.indexOf('parse2config') > order.indexOf('parse_config'));
    assert.deepEqual(names(searchSymbols(db, 'parse2config')), ['parse2config']);
  });

  test('returns [] for no match or an empty query; TypeError for bad arguments', () => {
    const { db } = tmpDb();
    seed(db);
    assert.deepEqual(searchSymbols(db, 'zzz'), []);
    assert.deepEqual(searchSymbols(db, '   '), []);
    assert.deepEqual(searchSymbols(db, '!!!'), []);
    assert.throws(() => searchSymbols(db, 42), /searchSymbols: "query" must be a string/);
    assert.throws(() => searchSymbols(db, 'x', { limit: 0 }), /searchSymbols: "limit" must be an integer >= 1/);
    assert.throws(() => searchSymbols(db, 'x', { limit: 2.5 }), /searchSymbols: "limit" must be an integer/);
    assert.throws(() => searchSymbols(db, 'x', { kind: 5 }), /searchSymbols: "kind" must be a non-empty string/);
    assert.throws(() => searchSymbols(db, 'x', null), /searchSymbols: "options" must be an object/);
    assert.deepEqual(searchSymbolsDetailed(db, 'zzz'), { rows: [], matched: [], dropped: [] });
  });
});

// How a model actually searches: a guessed name ("setCookie"), a description ("gift card
// redeem", "sign-in cookie") or a short name that is also a word fragment ("signIn").
describe('searchSymbolsDetailed', () => {
  const add = (db, path, defs) => {
    const id = upsertFile(db, { path, lang: 'ts', hash: path, mtimeMs: 1, size: 1, parseOk: true, errorNodes: 0, indexedAt: 1 });
    replaceAllForFile(db, id, {
      symbols: defs.map(([kind, name], i) => ({ kind, name, qual: name, startLine: i + 1, endLine: i + 1, startCol: 0, parent: null })),
    });
  };
  const project = () => {
    const { db } = tmpDb();
    add(db, 'src/auth.ts', [
      ['function', 'setAuthCookie'], ['function', 'signIn'], ['function', 'isSignedIn'], ['function', 'parseCookie'],
      ['class', 'SigningIdentity'], ['function', 'signIndex'], ['function', 'resolveComposer'],
    ]);
    add(db, 'src/billing.ts', [['function', 'redeemGiftCard'], ['component', 'GiftCardRedeemDialog']]);
    add(db, 'tests/auth.test.ts', [['function', 'resolveComposer']]);
    return db;
  };
  const order = (rows) => rows.map((r) => `${r.name}@${r.path}`);
  // The same database, counting the statements a search prepares.
  const counting = (db) => {
    const state = { prepares: 0, db: null };
    state.db = new Proxy(db, {
      get(target, prop) {
        if (prop === 'prepare') return (sql) => { state.prepares += 1; return target.prepare(sql); };
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return state;
  };

  test('words match in any order and a guessed name finds its real spelling', () => {
    const db = project();
    // "gift card redeem": the joined prefix and the phrase miss redeemGiftCard; the words find it.
    assert.deepEqual(new Set(names(searchSymbols(db, 'gift card redeem'))), new Set(['GiftCardRedeemDialog', 'redeemGiftCard']));
    assert.equal(names(searchSymbols(db, 'gift card redeem'))[0], 'GiftCardRedeemDialog', 'joined prefix still ranks first');
    assert.deepEqual(names(searchSymbols(db, 'setCookie')), ['setAuthCookie']);
    assert.equal(names(searchSymbols(db, 'set cookie'))[0], 'setAuthCookie');
  });

  test('a short word must be a whole word: "signIn" is not "SigningIdentity" or "signIndex"', () => {
    const db = project();
    assert.deepEqual(order(searchSymbols(db, 'signIn')), ['signIn@src/auth.ts', 'isSignedIn@src/auth.ts']);
    assert.deepEqual(order(searchSymbols(db, 'sign in')), ['signIn@src/auth.ts', 'isSignedIn@src/auth.ts']);
    // A long word may still be a word prefix or a substring: signing → SigningIdentity.
    assert.deepEqual(names(searchSymbols(db, 'signing')), ['SigningIdentity']);
    // Whole words anywhere in the name, shortest name first.
    assert.deepEqual(names(searchSymbols(db, 'cookie')), ['parseCookie', 'setAuthCookie']);
  });

  test('a description no name fully holds falls back to partial matches anchored on its longest words', () => {
    const db = project();
    // The anchors are the two longest words (cookie, sign). A name that contains more of the
    // query's words outranks one that contains a longer word: the order the SQL pool is cut in.
    const found = searchSymbolsDetailed(db, 'sign-in cookie');
    assert.deepEqual([found.matched, found.dropped], [['sign', 'in'], ['cookie']]);
    assert.deepEqual(names(found.rows), ['signIn', 'isSignedIn', 'parseCookie', 'setAuthCookie', 'signIndex', 'SigningIdentity']);
    // A word that is there on its own is not relaxed: "gift card" keeps both words.
    assert.deepEqual(searchSymbolsDetailed(db, 'gift card').dropped, []);
    // A repeated word is one word: the query says cookie twice and zebra once.
    const twice = searchSymbolsDetailed(db, 'cookie cookie zebra');
    assert.deepEqual([twice.matched, twice.dropped, names(twice.rows)], [['cookie'], ['zebra'], ['parseCookie', 'setAuthCookie']]);
    // Nothing at all: no rows, and no claim about which words were used.
    assert.deepEqual(searchSymbolsDetailed(db, 'unicorn zebra'), { rows: [], matched: [], dropped: [] });
    // A one-letter word is never an anchor; the two long words are, and the best name has both.
    const both = project();
    add(both, 'src/x.ts', [['function', 'cookieRedeem']]);
    const partial = searchSymbolsDetailed(both, 'x cookie redeem');
    assert.deepEqual([partial.matched, partial.dropped, names(partial.rows).slice(0, 1)], [['cookie', 'redeem'], ['x'], ['cookieRedeem']]);
    // "reasoning + efforts" is found although the query names words no symbol has. Both were
    // typed by real sessions; six subset trials never got past the three-word combinations.
    const efforts = project();
    add(efforts, 'src/efforts.ts', [['function', 'reasoningEfforts'], ['function', 'reasoningState']]);
    for (const query of ['reasoning efforts discovery', 'reasoning efforts discovery merge']) {
      const pair = searchSymbolsDetailed(efforts, query);
      assert.deepEqual([pair.matched, names(pair.rows)[0]], [['reasoning', 'efforts'], 'reasoningEfforts'], query);
    }
    // Five words: the best names pair two of them.
    add(db, 'src/browser-auth.ts', [['class', 'BrowserAuth'], ['function', 'signedCookie']]);
    const five = searchSymbolsDetailed(db, 'sign in auth cookie browser');
    assert.deepEqual([five.matched, names(five.rows).slice(0, 2)], [['auth', 'browser'], ['BrowserAuth', 'signedCookie']]);
    // Seven words, and the best names still surface: the old subset search never reached them.
    // Both names hold the same three words; the shorter one is listed first.
    const seven = searchSymbolsDetailed(db, 'sign in cookie jar gift card redeem bill');
    assert.deepEqual([seven.matched, names(seven.rows).slice(0, 2)], [['gift', 'card', 'redeem'], ['redeemGiftCard', 'GiftCardRedeemDialog']]);
    // The cost does not grow with the number of words: the full query (FTS and its LIKE pool)
    // and one query per anchor. Counted on an empty database, where nothing can match.
    for (const query of ['sign in cookie jar gift card redeem bill', 'a b c d e f g h i j k l m cookie']) {
      const counted = counting(tmpDb().db);
      assert.deepEqual(searchSymbolsDetailed(counted.db, query), { rows: [], matched: [], dropped: [] }, query);
      assert.equal(counted.prepares, 4, `${query}: ${counted.prepares} statements`);
    }
  });

  test('a pool that overflows is cut in favour of names that contain more of the query', () => {
    // The anchors of this query are "cookie" and "sign". 2001 short names hold "cookie" and
    // fill its pool; "authCookie" can only be reached through that same pool (it has no
    // "sign"), and must still come first because the SQL cut itself ranks by the words
    // contained. A LIKE chain without parentheses made that key 0 and this test fail.
    const { db } = tmpDb();
    add(db, 'src/many.ts', [...Array.from({ length: 2001 }, (_, i) => ['variable', `cookie${i}`]), ['function', 'authCookie']]);
    const found = searchSymbolsDetailed(db, 'sign in auth cookie');
    assert.deepEqual([names(found.rows)[0], found.matched, found.dropped], ['authCookie', ['auth', 'cookie'], ['sign', 'in']]);
    assert.deepEqual(names(found.rows).slice(1, 3), ['cookie0', 'cookie1'], 'the rest of the pool follows, shortest first');
  });

  test('relaxed search: one name reached from both anchors is listed once; limit keeps the best', () => {
    const db = project();
    add(db, 'src/jar.ts', [['function', 'signCookie']]);
    const found = searchSymbolsDetailed(db, 'sign-in cookie');
    // signCookie holds two long words, signIn two short ones: the more specific pair is first.
    assert.deepEqual([names(found.rows)[0], found.matched, names(found.rows).filter((n) => n === 'signCookie').length], ['signCookie', ['sign', 'cookie'], 1]);
    assert.deepEqual(names(searchSymbols(db, 'sign-in cookie', { limit: 3 })), names(found.rows).slice(0, 3));
    assert.deepEqual(names(searchSymbols(db, 'sign-in cookie', { limit: 1 })), ['signCookie']);
  });

  test('a repeated word in a full match is queried once', () => {
    const { db } = tmpDb();
    seed(db);
    assert.deepEqual(names(searchSymbols(db, 'parse parse config')), names(searchSymbols(db, 'parse config')));
    assert.deepEqual(searchSymbolsDetailed(db, 'parse parse config').matched, ['parse', 'config']);
  });

  // The first `search` a model sends decides whether codegraph is of any use in that session.
  // These are the first queries of the real sessions of 2026-11-24 (T20, bench.md), replayed on a
  // small project that stands in for the two repositories; the old search returned nothing for
  // four of them. `first` is the name that has to come out on top.
  test('the first queries of real sessions each land on the right symbol', () => {
    const db = project();
    add(db, 'src/real.ts', [
      ['class', 'BrowserAuth'], ['function', 'signedCookie'], ['function', 'cookieName'], ['function', 'tokenExchange'],
      ['function', 'composerSeat'], ['function', 'composerApi'], ['function', 'reasoningEfforts'],
    ]);
    const cases = [
      ['composer', 'composerSeat'],
      ['gift card redeem', 'GiftCardRedeemDialog'],
      ['sign-in cookie', 'signedCookie'],
      ['sign in cookie', 'signedCookie'],
      ['reasoning efforts discovery', 'reasoningEfforts'],
      ['reasoning efforts discovery merge', 'reasoningEfforts'],
      ['sign in auth cookie browser', 'BrowserAuth'],
      ['signin token cookie login', 'signIn'],
    ];
    for (const [query, first] of cases) {
      const rows = searchSymbols(db, query);
      assert.ok(rows.length > 0, `${query}: no matches`);
      assert.equal(names(rows)[0], first, `${query}: first row`);
    }
  });

  test('a short ASCII word must be whole, a short CJK word may sit inside a name', () => {
    const db = project();
    add(db, 'src/cjk.ts', [['function', '读取配置'], ['function', '加载配置文件'], ['variable', 'id']]);
    assert.deepEqual(names(searchSymbols(db, '配置')), ['读取配置', '加载配置文件']);
    assert.deepEqual(names(searchSymbols(db, '配置 文件')), ['加载配置文件']);
    assert.deepEqual(names(searchSymbols(db, 'id')), ['id']);
  });

  test('a short word is whole at every kind of word boundary the segmenter knows', () => {
    const db = project();
    const whole = ['_id', 'user_id', 'USER_ID', 'userId', 'xmlId', 'XMLId', 'a1Id', 'order-id', 'order.id', 'id'];
    // sessionIdX does hold the whole word Id; sessionIdx does not.
    const inside = ['identity', 'userid', '视频Id', 'width', 'sessionIdx'];
    add(db, 'src/boundaries.ts', [...whole, ...inside].map((name, i) => [i % 2 ? 'function' : 'variable', name]));
    // The SQL pool and the word filter agree: every whole-word form is found, nothing else is.
    assert.deepEqual(new Set(names(searchSymbols(db, 'id', { limit: 50 }))), new Set(whole));
    assert.deepEqual(names(searchSymbols(db, 'user id')), ['userId', 'user_id', 'USER_ID']);
    // Capitals right after a lower-case letter are a word too (macOS, isIP).
    add(db, 'src/caps.ts', [['function', 'macOS'], ['function', 'notarizeMacOS'], ['function', 'isIP'], ['constant', 'GZIP_OS_OFFSET'], ['function', 'macosx'], ['function', 'those']]);
    assert.deepEqual(new Set(names(searchSymbols(db, 'os'))), new Set(['macOS', 'notarizeMacOS', 'GZIP_OS_OFFSET']));
    assert.deepEqual(names(searchSymbols(db, 'ip')), ['isIP']);
  });

  test('for a short word the SQL pool and the word filter agree on every spelling and boundary', () => {
    // Every combination of what precedes the word, how it is joined, how it is spelled and what
    // follows it. The expected answer is the segmenter's own: the word is one of the name's words.
    const heads = ['', 'user', 'User', 'USER', 'xml', 'XML', 'a1', '视频', 'video', 'my'];
    const joins = ['', '_', '-', '.', '$', ' '];
    const spells = { id: ['id', 'Id', 'ID'], x: ['x', 'X'], e2: ['e2', 'E2'] };
    const tails = ['', 'X', 'x', '2', '_'];
    const seeded = [];
    for (const seg of Object.keys(spells)) {
      for (const head of heads) {
        for (const join of joins) {
          for (const spell of spells[seg]) {
            for (const tail of tails) {
              const name = `${head}${join}${spell}${tail}`;
              if (name.trim() === '' || name.includes(' ') || seeded.includes(name)) continue;
              seeded.push(name);
            }
          }
        }
      }
    }
    assert.ok(seeded.length < 2000, 'the sample fits one pool');
    const { db } = tmpDb();
    const chunk = 400;
    for (let c = 0; c * chunk < seeded.length; c += 1) {
      add(db, `src/spell-${c}.ts`, seeded.slice(c * chunk, (c + 1) * chunk).map((name) => ['variable', name]));
    }
    for (const seg of Object.keys(spells)) {
      const expected = seeded.filter((name) => identifierSegments(name).includes(seg)).sort();
      assert.ok(expected.length >= 8 && expected.length < seeded.length, `${seg}: the sample has both hits and misses (${expected.length} of ${seeded.length})`);
      assert.deepEqual([...new Set(names(searchSymbols(db, seg, { limit: 5000 })))].sort(), expected, seg);
    }
  });

  test('rows the word filter removes do not use up the limit, however many there are', () => {
    const db = project();
    add(db, 'src/ids.ts', [['function', 'identity'], ['function', 'idleState'], ['function', 'idempotencyKey'], ['function', 'userId'], ['function', 'sessionId']]);
    // identity / idleState / idempotencyKey fill the FTS prefix tier and are all dropped.
    assert.deepEqual(names(searchSymbols(db, 'id', { limit: 2 })), ['userId', 'sessionId']);
    assert.deepEqual(names(searchSymbols(db, 'id')), ['userId', 'sessionId']);
    // More noise than the whole pool could hold: it never enters the pool, so it cannot push
    // the whole-word hit out.
    const crowd = project();
    add(crowd, 'src/crowd.ts', [...Array.from({ length: 2500 }, (_, i) => ['variable', `video${i}`]), ['function', 'sessionId']]);
    assert.deepEqual(names(searchSymbols(crowd, 'id')), ['sessionId']);
  });

  test('inside one match tier source files come before tests', () => {
    const db = project();
    assert.deepEqual(order(searchSymbols(db, 'resolveComposer')), ['resolveComposer@src/auth.ts', 'resolveComposer@tests/auth.test.ts']);
    // Exact and prefix tiers still win over the file kind.
    assert.deepEqual(names(searchSymbols(db, 'resolveComposer')).slice(0, 1), ['resolveComposer']);
  });

  test('every entry of the test-file list recognises a path, root-level directories included; look-alikes stay source', () => {
    // One path per entry, written the way the convention looks in a repository. The list feeds
    // the SQL ORDER BY and "in source" as well as this predicate, and a mistyped entry matches
    // nothing without a word (`/e2e:` once replaced `/e2e/` and no test noticed).
    const examples = {
      '/__tests__/': '__tests__/a.ts',
      '/tests/': 'tests/a.ts',
      '/test/': 'test/a.ts',
      '/__mocks__/': 'src/__mocks__/a.ts',
      '/__fixtures__/': 'src/__fixtures__/a.json',
      '/fixtures/': 'fixtures/a.json',
      '/spec/': 'spec/a.rb',
      '/specs/': 'specs/a.rb',
      '/e2e/': 'e2e/flow.ts',
      '/scripts/': 'scripts/build.mjs',
      '/examples/': 'examples/demo.ts',
      '/benchmarks/': 'benchmarks/run.ts',
      '/bench/': 'bench/run.ts',
      '/node_modules/': 'node_modules/pkg/index.js',
      '/vendor/': 'vendor/lib.go',
      '.test.': 'src/a.test.ts',
      '.spec.': 'src/a.spec.ts',
      '.stories.': 'src/a.stories.tsx',
      '_test.go': 'pkg/auth_test.go',
      '/testdata/': 'cmd/testdata/input.json',
      '/tests.py': 'app/tests.py',
      '/test_': 'app/test_views.py',
      '/__snapshots__/': 'src/__snapshots__/a.ts.snap',
      'tests.cs': 'src/NodeTests.cs',
    };
    assert.deepEqual(Object.keys(examples).sort(), [...SECONDARY_PATH_PARTS].sort(), 'the list and its examples have the same entries');
    for (const [part, path] of Object.entries(examples)) {
      assert.equal(isSecondaryPath(path), true, part);
      if (part.startsWith('/')) assert.equal(isSecondaryPath(`apps/web/${path}`), true, `${part} one level down`);
    }
    for (const path of [
      'src/latest_metrics.ts', 'src/greatest_hits.ts', 'src/units.py', 'src/attest.go',
      // A file or directory that merely ends in those letters is not the convention.
      'e2e.ts', 'src/e2e.ts', 'pkg/a_e2e/b.ts', 'app/latest/a.py', 'app/mytests/a.py', 'src/a.ts',
      // No path is no match.
      null, '',
    ]) {
      assert.equal(isSecondaryPath(path), false, String(path));
    }
    // Case does not matter, on either side of the list.
    for (const path of ['SRC/A.TEST.TS', 'Scripts/Build.MJS', 'E2E/flow.ts', 'src/NodeTESTS.CS']) {
      assert.equal(isSecondaryPath(path), true, path);
    }
  });

  test('inside one match tier source files come before test and script files, wherever they sit', () => {
    const db = project();
    // Each pair defines one name twice: in a source file and in a test or script file. The
    // first three are directories at the project root, the most common layout.
    const pairs = [
      ['src/flow.ts', 'e2e/flow.ts'],
      ['src/build.ts', 'scripts/build.ts'],
      ['src/lib/a.ts', 'tests/lib/a.ts'],
      ['pkg/auth.go', 'pkg/auth_test.go'],
      ['app/models.py', 'app/tests.py'],
      ['app/views.py', 'app/test_views.py'],
      ['src/Node.cs', 'src/NodeTests.cs'],
      ['src/render.ts', 'src/__snapshots__/render.ts'],
      ['cmd/tool.go', 'cmd/testdata/tool.go'],
    ];
    pairs.forEach(([source, testFile], i) => {
      const name = `widget${i}`;
      add(db, testFile, [['function', name]]);
      add(db, source, [['function', name]]);
    });
    for (const [i, [source, testFile]] of pairs.entries()) {
      const name = `widget${i}`;
      assert.deepEqual(order(searchSymbols(db, name)), [`${name}@${source}`, `${name}@${testFile}`], testFile);
    }
    // The cut happens in SQL (the same flag orders the rows before the JS sort), so it has to
    // hold there too: behind a crowd of same-named script rows, a limit of one still returns
    // the source definition. The source file is written last on purpose: should the SQL flag
    // break, all 81 rows tie and SQLite keeps tied rows in rowid order, so the source row is
    // the one the cut removes.
    for (let i = 0; i < 80; i += 1) add(db, `scripts/crowd${i}.ts`, [['function', 'helperCrowd']]);
    add(db, 'src/crowd.ts', [['function', 'helperCrowd']]);
    assert.deepEqual(order(searchSymbols(db, 'helperCrowd', { limit: 1 })), ['helperCrowd@src/crowd.ts']);
    // "test_" and "test.go" inside a longer name are not the test-file conventions.
    const lookAlikes = ['src/latest_metrics.ts', 'src/greatest_hits.ts', 'src/units.py', 'src/attest.go'];
    lookAlikes.forEach((path, i) => {
      add(db, `tests/plain${i}.test.ts`, [['function', `plain${i}`]]);
      add(db, path, [['function', `plain${i}`]]);
    });
    for (const [i, path] of lookAlikes.entries()) {
      assert.deepEqual(order(searchSymbols(db, `plain${i}`)), [`plain${i}@${path}`, `plain${i}@tests/plain${i}.test.ts`], path);
    }
  });

  test('an exact name comes first wherever it is defined; the rest: source before tests, starts-with before looser', () => {
    const db = project();
    add(db, 'src/jar.ts', [['function', 'cookieJar']]);
    add(db, 'tests/http.test.ts', [['variable', 'cookie']]);
    // cookie is the exact name (a test file here) and is never pushed past the limit by the
    // source prefix match cookieJar or by the source names that only contain the word.
    assert.deepEqual(order(searchSymbols(db, 'cookie')), [
      'cookie@tests/http.test.ts',
      'cookieJar@src/jar.ts',
      'parseCookie@src/auth.ts',
      'setAuthCookie@src/auth.ts',
    ]);
    assert.deepEqual(order(searchSymbols(db, 'cookie', { limit: 2 })), ['cookie@tests/http.test.ts', 'cookieJar@src/jar.ts']);
    // The other way round: an exact name in a source file beats a test file's prefix match at any limit.
    add(db, 'tests/jar.test.ts', [['function', 'cookieJar']]);
    add(db, 'src/http.ts', [['variable', 'cookie']]);
    assert.deepEqual(order(searchSymbols(db, 'cookie', { limit: 1 })), ['cookie@src/http.ts']);
    assert.deepEqual(order(searchSymbols(db, 'cookie', { limit: 3 })), ['cookie@src/http.ts', 'cookie@tests/http.test.ts', 'cookieJar@src/jar.ts']);
  });

  test('a good row behind a crowd of rows the word filter removes is still found, at its own tier', () => {
    const db = project();
    // 45 short names start with "id" without the word; id_text has it and is the longest.
    add(db, 'src/ids.ts', [...Array.from({ length: 45 }, (_, i) => ['variable', `idx${i}`]), ['function', 'id_text']]);
    assert.deepEqual(names(searchSymbols(db, 'id', { limit: 1 })), ['id_text']);
    assert.deepEqual(names(searchSymbols(db, 'id_text', { limit: 1 })), ['id_text'], 'exact tier survives the crowd');
  });

  test('the kind filter applies to the FTS tiers too, so exact-first ordering survives it', () => {
    const { db } = tmpDb();
    seed(db);
    const functions = names(searchSymbols(db, 'parseConfig', { kind: 'function' }));
    assert.equal(functions[0], 'parseConfig');
    assert.ok(functions.indexOf('parse_config') < functions.indexOf('parse2config'), 'FTS hits still rank above LIKE-only hits');
    assert.equal(functions.length, 5);
    // Relaxation obeys the kind filter too: no variable holds both words, "parse" alone does.
    assert.deepEqual(names(searchSymbols(db, 'parseConfig', { kind: 'variable' })), ['parse']);
    assert.deepEqual(searchSymbolsDetailed(db, 'parseConfig', { kind: 'variable' }).dropped, ['config']);
    assert.deepEqual(names(searchSymbols(db, 'parse', { kind: 'class' })), []);
    assert.deepEqual(names(searchSymbols(db, 'config parse', { kind: 'class' })), ['Config']);
  });
});

// A name that is used but not defined here (CONTRACTS.md §7 searchRefs): the T20 sessions went
// to grep for `membershipKind`.
describe('searchRefs', () => {
  const NOTHING = { rows: [], uses: 0, files: 0, fileIds: [], names: [], capped: false };
  const totals = (out) => ({ uses: out.uses, files: out.files, names: out.names, capped: out.capped });
  // file ids are the store's: everything else is the contract.
  const places = (out) => out.rows.map(({ file_id, ...row }) => row);
  // src/a.ts         loadConfig reads maxIdleDays (line 11) and calls fs.readFile twice; helper
  //                  reads it (21); the module level reads it (1).
  // tests/a.test.ts  configTest reads it three times.
  // src/b.ts         longer names that hold the words: maxIdleDaysValue, sessionId, identity.
  const project = () => {
    const { db } = tmpDb();
    const add = (path, symbols, refs) => {
      const id = upsertFile(db, { path, lang: 'ts', hash: path, mtimeMs: 1, size: 1, parseOk: true, errorNodes: 0, indexedAt: 1 });
      replaceAllForFile(db, id, {
        symbols: symbols.map(([kind, name], i) => ({ kind, name, qual: name, startLine: (i + 1) * 10, endLine: (i + 1) * 10 + 3, startCol: 0, parent: null })),
        refs,
      });
    };
    const read = (line, symbol, startCol = 3) => ({ name: 'maxIdleDays', kind: 'ref', startLine: line, startCol, endLine: line, symbol });
    add('src/a.ts', [['function', 'loadConfig'], ['function', 'helper']], [
      read(1, null, 6),
      read(11, 0),
      { name: 'readFile', kind: 'call', startLine: 12, startCol: 2, endLine: 12, symbol: 0, receiver: 'fs' },
      { name: 'readFile', kind: 'call', startLine: 13, startCol: 2, endLine: 13, symbol: 0, receiver: 'fs' },
      read(21, 1),
    ]);
    add('tests/a.test.ts', [['function', 'configTest']], [read(3, 0), read(4, 0), read(5, 0)]);
    add('src/b.ts', [], [
      { name: 'maxIdleDaysValue', kind: 'ref', startLine: 2, startCol: 4, endLine: 2, symbol: null },
      { name: 'sessionId', kind: 'ref', startLine: 3, startCol: 4, endLine: 3, symbol: null },
      { name: 'identity', kind: 'ref', startLine: 4, startCol: 4, endLine: 4, symbol: null },
    ]);
    return db;
  };

  test('a name that is only used: one row per file and containing symbol, the module level by itself, source before tests', () => {
    assert.deepEqual(places(searchRefs(project(), 'maxIdleDays')), [
      { name: 'maxIdleDays', kind: 'ref', receiver: null, count: 1, start_line: 1, path: 'src/a.ts', owner: null, owner_qual: null, owner_kind: null },
      { name: 'maxIdleDays', kind: 'ref', receiver: null, count: 1, start_line: 11, path: 'src/a.ts', owner: 'loadConfig', owner_qual: 'loadConfig', owner_kind: 'function' },
      { name: 'maxIdleDays', kind: 'ref', receiver: null, count: 1, start_line: 21, path: 'src/a.ts', owner: 'helper', owner_qual: 'helper', owner_kind: 'function' },
      { name: 'maxIdleDays', kind: 'ref', receiver: null, count: 3, start_line: 3, path: 'tests/a.test.ts', owner: 'configTest', owner_qual: 'configTest', owner_kind: 'function' },
    ]);
    assert.deepEqual(totals(searchRefs(project(), 'maxIdleDays')), { uses: 6, files: 2, names: ['maxIdleDays'], capped: false });
  });

  test('the name as written is the whole answer: calls keep their receiver, longer names that hold its words are left out', () => {
    const db = project();
    assert.deepEqual(places(searchRefs(db, 'readFile')), [
      { name: 'readFile', kind: 'call', receiver: 'fs', count: 2, start_line: 12, path: 'src/a.ts', owner: 'loadConfig', owner_qual: 'loadConfig', owner_kind: 'function' },
    ]);
    assert.deepEqual(searchRefs(db, 'maxIdleDays').names, ['maxIdleDays'], 'maxIdleDaysValue is not listed');
    // Separators are not a name, so this is a scan by words: the name that holds them comes first.
    assert.deepEqual(searchRefs(db, 'max-idle-days').names, ['maxIdleDays', 'maxIdleDaysValue']);
    assert.deepEqual(places(searchRefs(db, 'max-idle-days', { limit: 3 })).map((row) => row.path), ['src/a.ts', 'src/a.ts', 'src/a.ts']);
  });

  test('any other spelling scans: words in any order, another case, and a short word only whole', () => {
    const db = project();
    assert.deepEqual(searchRefs(db, 'days idle').names, ['maxIdleDays', 'maxIdleDaysValue'], 'the name equal to the query comes first');
    assert.deepEqual(searchRefs(db, 'days idle max').names, ['maxIdleDays', 'maxIdleDaysValue']);
    assert.deepEqual(searchRefs(db, 'MaxIdleDays').names, ['maxIdleDays', 'maxIdleDaysValue'], 'another case finds the name and lists it first');
    assert.deepEqual(searchRefs(db, 'idle').names, ['maxIdleDays', 'maxIdleDaysValue'], 'a long word may sit inside a name');
    assert.deepEqual(searchRefs(db, 'id').names, ['sessionId'], '"id" is whole in sessionId and not in identity');
    assert.deepEqual(searchRefs(db, 'session id').names, ['sessionId']);
    assert.deepEqual(searchRefs(db, 'session').names, ['sessionId']);
  });

  test('test files come after source files even when their path sorts first', () => {
    const db = project();
    const id = upsertFile(db, { path: 'a.spec.ts', lang: 'ts', hash: 'spec', mtimeMs: 1, size: 1, parseOk: true, errorNodes: 0, indexedAt: 1 });
    replaceAllForFile(db, id, { symbols: [], refs: [{ name: 'readFile', kind: 'call', startLine: 1, startCol: 2, endLine: 1, symbol: null }] });
    assert.deepEqual(searchRefs(db, 'readFile').rows.map((row) => row.path), ['src/a.ts', 'a.spec.ts']);
  });

  test('limit keeps the first rows; the totals still describe every place', () => {
    const db = project();
    const out = searchRefs(db, 'maxIdleDays', { limit: 2 });
    assert.equal(out.rows.length, 2);
    assert.deepEqual(totals(out), { uses: 6, files: 2, names: ['maxIdleDays'], capped: false });
    assert.equal(searchRefs(db, 'maxIdleDays', { limit: 500 }).rows.length, 4);
  });

  test('the files are counted over every place, cut or not: one id per file that has one', () => {
    const db = project();
    const pathOf = (id) => db.prepare('SELECT path FROM files WHERE id = ?').get(id).path;
    assert.deepEqual(searchRefs(db, 'maxIdleDays').fileIds.map(pathOf), ['src/a.ts', 'tests/a.test.ts']);
    assert.deepEqual(searchRefs(db, 'maxIdleDays', { limit: 2 }).fileIds.map(pathOf), ['src/a.ts', 'tests/a.test.ts'], 'a file whose rows the limit dropped still counts');
    assert.deepEqual(searchRefs(db, 'zzqNothing').fileIds, []);
  });

  test('past a cut the totals are lower bounds and stop at the cut: many places of one name, and one place used very often', () => {
    const { db } = tmpDb();
    const id = upsertFile(db, { path: 'src/many.ts', lang: 'ts', hash: 'many', mtimeMs: 1, size: 1, parseOk: true, errorNodes: 0, indexedAt: 1 });
    const def = (i) => ({ kind: 'function', name: `reader${i}`, qual: `reader${i}`, startLine: 1, endLine: 1, startCol: 0, parent: null });
    const used = (symbol) => ({ name: 'zzqCap', kind: 'ref', startLine: 1, startCol: 2, endLine: 1, symbol });
    const write = (symbols, refs) => replaceAllForFile(db, id, { symbols, refs });
    const readers = (n) => Array.from({ length: n }, (_, i) => def(i));

    // Twice the cut: what is counted stops one past it, whichever way the references are cut.
    write(readers(REF_GROUPS_MAX * 2), Array.from({ length: REF_GROUPS_MAX * 2 }, (_, i) => used(i)));
    assert.deepEqual(totals(searchRefs(db, 'zzqCap')), { uses: REF_GROUPS_MAX + 1, files: 1, names: ['zzqCap'], capped: true });
    write(readers(REF_GROUPS_MAX), Array.from({ length: REF_GROUPS_MAX }, (_, i) => used(i)));
    assert.equal(searchRefs(db, 'zzqCap').capped, false, 'exactly at the cut everything was counted');

    write([def(0)], Array.from({ length: REF_ROWS_MAX * 2 }, (_, i) => ({ ...used(0), startLine: i + 1, endLine: i + 1 })));
    assert.deepEqual(totals(searchRefs(db, 'zzqCap')), { uses: REF_ROWS_MAX + 1, files: 1, names: ['zzqCap'], capped: true });
    write([def(0)], Array.from({ length: REF_ROWS_MAX }, (_, i) => ({ ...used(0), startLine: i + 1, endLine: i + 1 })));
    assert.equal(searchRefs(db, 'zzqCap').capped, false);
  });

  test('the cut on references is decided before the word filter: rows the filter drops were read all the same', () => {
    const { db } = tmpDb();
    const add = (path, refs) => {
      const id = upsertFile(db, { path, lang: 'ts', hash: path, mtimeMs: 1, size: 1, parseOk: true, errorNodes: 0, indexedAt: 1 });
      replaceAllForFile(db, id, { symbols: [{ kind: 'function', name: 'handler', qual: 'handler', startLine: 1, endLine: 1, startCol: 0, parent: null }], refs });
    };
    const at = (name, line) => ({ name, kind: 'ref', startLine: line, startCol: 2, endLine: line, symbol: 0 });
    // Indexed first, so it is read first: "id" reaches identity (which the word filter drops).
    add('src/a-first.ts', [at('identity', 1), at('identity', 2)]);
    add('src/b-second.ts', Array.from({ length: REF_ROWS_MAX }, (_, i) => at('userId', i + 1)));
    // 2 + 20,000 references are more than are read; what is left after the filter is 19,999,
    // fewer than the cut, and yet the table holds 20,000 places.
    const out = searchRefs(db, 'Id');
    assert.deepEqual(totals(out), { uses: REF_ROWS_MAX - 1, files: 1, names: ['userId'], capped: true });
  });

  test('a receiver tells rows apart, and a name used in more than one way says so', () => {
    const { db } = tmpDb();
    const id = upsertFile(db, { path: 'src/c.ts', lang: 'ts', hash: 'c', mtimeMs: 1, size: 1, parseOk: true, errorNodes: 0, indexedAt: 1 });
    replaceAllForFile(db, id, {
      symbols: [{ kind: 'function', name: 'handle', qual: 'handle', startLine: 1, endLine: 9, startCol: 0, parent: null }],
      refs: [
        { name: 'get', kind: 'call', startLine: 2, startCol: 2, endLine: 2, symbol: 0, receiver: 'req' },
        { name: 'get', kind: 'call', startLine: 4, startCol: 2, endLine: 4, symbol: 0, receiver: 'res' },
        { name: 'get', kind: 'call', startLine: 5, startCol: 2, endLine: 5, symbol: 0, receiver: 'res' },
        { name: 'get', kind: 'call', startLine: 6, startCol: 2, endLine: 6, symbol: 0, receiver: 'req' },
        { name: 'get', kind: 'ref', startLine: 7, startCol: 2, endLine: 7, symbol: 0 },
        { name: 'validate', kind: 'call', startLine: 3, startCol: 2, endLine: 3, symbol: 0 },
        { name: 'validate', kind: 'ref', startLine: 8, startCol: 2, endLine: 8, symbol: 0 },
      ],
    });
    assert.deepEqual(places(searchRefs(db, 'get')), [
      { name: 'get', kind: 'call', receiver: 'req', count: 2, start_line: 2, path: 'src/c.ts', owner: 'handle', owner_qual: 'handle', owner_kind: 'function' },
      { name: 'get', kind: 'call', receiver: 'res', count: 2, start_line: 4, path: 'src/c.ts', owner: 'handle', owner_qual: 'handle', owner_kind: 'function' },
      { name: 'get', kind: 'ref', receiver: null, count: 1, start_line: 7, path: 'src/c.ts', owner: 'handle', owner_qual: 'handle', owner_kind: 'function' },
    ]);
    assert.deepEqual(totals(searchRefs(db, 'get')), { uses: 5, files: 1, names: ['get'], capped: false });
    assert.deepEqual(places(searchRefs(db, 'validate')), [
      { name: 'validate', kind: 'use', receiver: null, count: 2, start_line: 3, path: 'src/c.ts', owner: 'handle', owner_qual: 'handle', owner_kind: 'function' },
    ]);
  });

  test('the order of the words in the query does not change the places', () => {
    const db = project();
    assert.deepEqual(places(searchRefs(db, 'session id')), places(searchRefs(db, 'id session')));
    assert.deepEqual(places(searchRefs(db, 'days idle max')), places(searchRefs(db, 'max idle days')));
  });

  test('nothing to find and bad arguments', () => {
    const db = project();
    assert.deepEqual(searchRefs(db, 'zzz'), NOTHING);
    assert.deepEqual(searchRefs(db, ''), NOTHING);
    assert.deepEqual(searchRefs(db, '   '), NOTHING);
    assert.deepEqual(searchRefs(db, '!!!'), NOTHING);
    assert.throws(() => searchRefs(null, 'x'), /searchRefs: "db" must be a DatabaseSync/);
    assert.throws(() => searchRefs(db, 42), /searchRefs: "query" must be a string/);
    assert.throws(() => searchRefs(db, 'x', { limit: 0 }), /searchRefs: "limit" must be an integer >= 1/);
    assert.throws(() => searchRefs(db, 'x', { limit: 2.5 }), /searchRefs: "limit" must be an integer/);
    assert.throws(() => searchRefs(db, 'x', null), /searchRefs: "options" must be an object/);
  });
});

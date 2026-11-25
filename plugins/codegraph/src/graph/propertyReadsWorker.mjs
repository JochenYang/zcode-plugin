// Property-read scan worker (CONTRACTS.md §8 "property reads"). The main thread never parses
// (§9): it sends
//   { type: 'scan', id, root, name, files: [{ id, path, lang, size, mtimeMs }], limits, sentAt }
// and gets back
//   { type: 'scan', id,
//     files: [{ id, path, hits: [{ receiver, line, column }],
//              keys: [{ kind: 'key' | 'field', line, column }] }],
//     stopped: null | 'bytes' | 'uses', unreadable: number, unseen: number,
//     hubs: { reads: boolean, keys: boolean } }
// and it may send { type: 'prime', id, root, files, limits, sentAt } to have the same files
// remembered before the first scan asks; the answer is { type: 'prime', id, unseen }, `unseen`
// being how many files that round's budget left: the caller asks again until there are none.
// `sentAt` is when the caller sent the request (wall clock): the time budget is counted from
// there.
// Four things are looked for, each in the files that may hold it: a property read (`obj.name`,
// `hits`); the name as the key of an object (`{ name: 1 }`, `{ name }`, `const { name } = x`), as
// the attribute of a JSX element (`<Input name={…} />`) or as a member of a type (`interface T
// { name: string }`) — the last three in `keys`.
// `hubs` says which of the two lookups (the read, the keys) met the name in more files than it
// lists; such a lookup gives no rows and the other is not affected by it. `unreadable` counts the
// files the index knows that could not be read (outside the project, a link, a permission): the
// answer is short of them. `unseen` counts those the read budget — in bytes or in time — left
// for another round, and the candidates not read again for want of time: the answer is short of
// them too.
// Reading and tree-sitter happen here, so a pathologically slow file stalls one request, not
// the server: the caller times out and replaces this worker. `stopped` names the limit that
// ended the scan; rows collected before it are still returned (the caller marks them as a
// lower bound). What is not a read — a call, a construction, a decorator, the target of a
// plain assignment — is left out here, where the tree is; so are a class field and a method of
// an object literal, which are symbols in the index already. Everything that runs when the worker
// starts comes before the 'ready' message: the caller takes that as "this worker answers scans".
import fs from 'node:fs';
import path from 'node:path';
import { parentPort } from 'worker_threads';
import { initTreeSitter, parserFor } from '../../grammars/loader.mjs';
import { isInside } from '../paths.mjs';
import { bareName, dottedName, dottedNameTight, propertyReadNeedle } from './prefilter.mjs';

// Entries of `files.lang` whose property reads are not in the index and whose grammar has
// `member_expression`. Python records attribute reads in the index; Go's field selectors are
// covered by neither yet.
const LANGS = ['typescript', 'tsx', 'javascript'];
const PROPERTY_QUERY = '(member_expression property: (property_identifier) @property)';
// The name as the key of an object: set in a literal (`{ name: 1 }`, `{ name }`, `{ name: () => 1 }`)
// or read by destructuring (`const { name } = x`, `const { name: alias } = x`, `const { name = 1 }
// = x`), at any depth. Node names as the grammars give them (checked with `bin/ast.mjs`). Not a
// method of an object literal (`{ name() {} }`): the index has it as a symbol, like a class field.
const KEY_QUERY = [
  '(pair key: (property_identifier) @key)',
  '(object (shorthand_property_identifier) @key)',
  '(pair_pattern key: (property_identifier) @key)',
  '(object_pattern (shorthand_property_identifier_pattern) @key)',
  '((object_assignment_pattern left: (shorthand_property_identifier_pattern) @key))',
];
// The name as the attribute of a JSX element (`<Input onChange={…} />`): where a component is
// given a prop, as `{ onChange }` gives it to an object. TSX and JavaScript have the node; the
// TypeScript grammar has no JSX, and a query naming it does not compile there. A namespaced
// attribute (`xlink:href`) is not an identifier and is never captured; one with a hyphen
// (`data-id`) is captured as one name, and is never asked for, since a query is an identifier.
const JSX_QUERY = '(jsx_attribute (property_identifier) @key)';
// The name as a member of an interface or of a type literal: a property (`name: T`, also
// `readonly` or optional) or a method (`name(): void`). The JavaScript grammar has no such
// nodes (a query naming them does not compile), so they are asked of TypeScript and TSX only.
const FIELD_QUERY = [
  '(property_signature name: (property_identifier) @field)',
  '(method_signature name: (property_identifier) @field)',
];
// A receiver is cut where a call's name is cut in the index.
const MAX_RECEIVER = 80;

await initTreeSitter();
const { Query } = await initTreeSitter();
const parsers = new Map();
const readQueries = new Map();
const keyQueries = new Map();
for (const lang of LANGS) {
  const parser = await parserFor(lang);
  parsers.set(lang, parser);
  readQueries.set(lang, new Query(parser.language, PROPERTY_QUERY));
  keyQueries.set(lang, new Query(parser.language, [
    ...KEY_QUERY,
    ...(lang === 'typescript' ? [] : [JSX_QUERY]),
    ...(lang === 'javascript' ? [] : FIELD_QUERY),
  ].join('\n')));
}

// What each file holds, as far as its text can tell: the names behind a dot in it that are not
// called right there (`names`), and the names that stand on their own in it (`bare`). Read once
// per worker; read again only when the index reports another size or mtime for the file, so the
// scan is exactly as fresh as the index and a search costs the files that have the name, not
// the project. (Without this, every such search read every JS/TS file: 1 s on a repository of
// 17,000 of them, and past a budget of bytes read it gave up altogether — 2026-11-25.) Only
// what was read, and what is gone, is remembered: whether a file is too big depends on the
// limit a request brings, and a file that could not be read just now may be readable at the
// next search.
const held = new Map(); // path -> { size, mtimeMs, state: 'ok' | 'gone', names, bare }
let rememberedRoot; // what is remembered belongs to one project
const intern = new Map(); // name -> id
const NO_NAMES = new Uint32Array(0);
const idOf = (name) => {
  let id = intern.get(name);
  if (id === undefined) intern.set(name, (id = intern.size));
  return id;
};
const hasName = (names, id) => {
  for (let lo = 0, hi = names.length - 1; lo <= hi;) {
    const mid = (lo + hi) >>> 1;
    const at = names[mid];
    if (at === id) return true;
    if (at < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
};
const sorted = (ids) => Uint32Array.from([...ids].sort((a, b) => a - b));

parentPort.postMessage({ type: 'ready' });
parentPort.on('message', (msg) => {
  if (msg?.type === 'prime') {
    const { unknown } = refresh(msg);
    parentPort.postMessage({ type: 'prime', id: msg.id, unseen: unknown.length });
    return;
  }
  if (msg?.type !== 'scan') return;
  parentPort.postMessage({ type: 'scan', id: msg.id, ...scan(msg) });
});

// The text of one file, or why there is none. `gone` is not news (the next sync drops it from
// the index); anything else that keeps a file from being read leaves a hole in the answer.
function readText(root, file, limits) {
  try {
    const abs = path.resolve(root, file.path);
    // The index is not to be trusted with paths, and a link is not followed: only a regular
    // file inside the project is read.
    if (!isInside(root, abs)) return { state: 'unreadable' };
    const stat = fs.lstatSync(abs);
    if (!stat.isFile()) return { state: 'unreadable' };
    if (stat.size > limits.maxFileBytes) return { state: 'oversized' };
    return { state: 'ok', text: fs.readFileSync(abs, 'utf8') };
  } catch (err) {
    return { state: err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? 'gone' : 'unreadable' };
  }
}

// The time by which a request must have stopped reading files: `readDeadlineMs` after the caller
// sent it. Time, not only bytes: the caller gives up on a request after its own timeout and
// replaces this worker, which would throw away what was read; stopping before that keeps it. The
// time is counted from when the caller sent the request, not from when this worker gets to it:
// one queued behind another would otherwise spend that one's budget and then its own.
function readingDeadline(sentAt, limits) {
  return (Number.isFinite(sentAt) ? sentAt : Date.now()) + limits.readDeadlineMs;
}

// Bring what is remembered of each file up to what the index says of it now. A file costs its
// bytes once. Those the budget — in bytes, or in time — does not cover this round are returned,
// to be taken first next time; so are those that could not be read. Files the index no longer
// lists are forgotten.
function refresh({ root, files, limits, sentAt }) {
  if (root !== rememberedRoot) {
    held.clear();
    rememberedRoot = root;
  }
  const unknown = [];
  const unreadable = [];
  let read = 0;
  const deadline = readingDeadline(sentAt, limits);
  for (const file of files) {
    const known = held.get(file.path);
    if (known && known.size === file.size && known.mtimeMs === file.mtimeMs) continue;
    if (file.size > limits.maxFileBytes) continue; // as the indexer skips it; asked again, the limit is the caller's
    if (read + file.size > limits.maxReadBytes || Date.now() > deadline) {
      unknown.push(file);
      continue;
    }
    const got = readText(root, file, limits);
    if (got.state === 'ok') {
      read += got.text.length;
      held.set(file.path, { size: file.size, mtimeMs: file.mtimeMs, state: 'ok', names: sorted(namesBehindDots(got.text)), bare: sorted(namesOnTheirOwn(got.text)) });
    } else if (got.state === 'gone') {
      held.set(file.path, { size: file.size, mtimeMs: file.mtimeMs, state: 'gone', names: NO_NAMES, bare: NO_NAMES });
    } else {
      unreadable.push(file.path);
    }
  }
  // A file that was renamed leaves an entry behind as long as another was added; forgetting is
  // one pass over the names, so it is not left to a change in their number.
  const listed = new Set(files.map((file) => file.path));
  for (const gone of held.keys()) if (!listed.has(gone)) held.delete(gone);
  return { unknown, unreadable };
}

// What may be read behind a dot in a text: every name that is not called right where it stands
// (`obj.name(` is in the index already), as ids. Both patterns are read: with a gap allowed, a
// match can run on through a `//` that is inside a string and cover the reads after it on that
// line; without one, no match can cover a dot.
function namesBehindDots(text) {
  const ids = new Set();
  for (const pattern of [dottedName, dottedNameTight]) {
    for (const match of text.matchAll(pattern)) {
      if (text.charCodeAt(match.index + match[0].length) === 40 /* ( */) continue;
      ids.add(idOf(match[1]));
    }
  }
  return ids;
}

// Every name that stands on its own in a text, as ids: a superset of the keys of objects in
// it, and of much else (declarations, parameters, imports), which the parse sorts out. This
// pass meets every identifier of the project once, so it is the dearest part of reading the
// files (2.5 s of the 4 s a repository of 193 MB of JS/TS takes; the names behind dots take
// 0.9 s) — `match` with the global pattern hands every name over at once, which is 18% less
// than `matchAll` and its match object per name (2026-11-25).
function namesOnTheirOwn(text) {
  const ids = new Set();
  for (const name of text.match(bareName) ?? []) ids.add(idOf(name));
  return ids;
}

// Not a read: a call (`obj.name()`), a construction (`new obj.name()`), a decorator
// (`@obj.name`) and the target of a plain assignment (`obj.name = 1`), also inside a
// destructuring (`[obj.name] = list`) or the head of a `for…of`: each names the property without
// using its value. A compound assignment (`obj.name += 1`), an update (`obj.name++`) and a
// `delete` use it, so they stay.
function notARead(member) {
  const parent = member.parent;
  if (!parent) return false;
  if (parent.type === 'call_expression' || parent.type === 'new_expression') {
    return parent.childForFieldName('function')?.id === member.id || parent.childForFieldName('constructor')?.id === member.id;
  }
  if (parent.type === 'decorator') return true;
  let inner = member;
  let outer = parent;
  while (outer && WRAPS_A_TARGET.has(outer.type)) {
    // The default value of a destructuring is a read, also when the destructuring is an assignment.
    if (outer.type === 'assignment_pattern' && outer.childForFieldName('right')?.id === inner.id) return false;
    inner = outer;
    outer = outer.parent;
  }
  return outer !== null && (outer.type === 'assignment_expression' || outer.type === 'for_in_statement') && outer.childForFieldName('left')?.id === inner.id;
}

// What the target of an assignment is wrapped in (node names as the grammars give them, checked
// with `bin/ast.mjs`): a destructuring pattern, a pair of an object pattern, a default value, a
// rest, parentheses.
const WRAPS_A_TARGET = new Set(['array_pattern', 'object_pattern', 'pair_pattern', 'object_assignment_pattern', 'assignment_pattern', 'rest_pattern', 'parenthesized_expression']);

function scan({ root, name, files, limits, sentAt }) {
  const { unknown, unreadable } = refresh({ root, files, limits, sentAt });
  const notRead = new Set(unreadable);
  let unreadableCount = unreadable.length;
  const needle = propertyReadNeedle(name);
  const id = intern.get(name);
  // Which files may hold the name behind a dot, and which may hold it as a key: the two
  // lookups are kept apart, so that a name that is everywhere on its own (an import, a
  // variable) does not make the few files that read it as a property a hub.
  const withReads = [];
  const withKeys = [];
  for (const file of files) {
    const known = held.get(file.path);
    // Not got to this round, or could not be read: both are counted above. Too big is asked
    // here, since the limit is the request's.
    if (!known || file.size > limits.maxFileBytes) continue;
    if (id === undefined || known.state !== 'ok') continue;
    const reads = hasName(known.names, id);
    const keys = hasName(known.bare, id);
    if (reads) withReads.push({ file, keys });
    else if (keys) withKeys.push(file);
  }
  // The two cuts are not the same size. A file that reads the name has the name where it is
  // read; a file that has the name on its own may hold it as a variable, a parameter, an import
  // or a word in a comment, so that count runs high for names whose keys are in few files
  // (`title`, `sessionId` — 2026-11-25, a repository of 916 JS/TS files: one name in six lost
  // its keys at the cut of reads, one in twenty-five at the cut of keys).
  const hubReads = withReads.length > limits.maxFiles;
  const hubKeys = withReads.filter((entry) => entry.keys).length + withKeys.length > limits.maxKeyFiles;
  const hubs = { reads: hubReads, keys: hubKeys };
  // `unreadableCount` says what the answer is short of, `unknown` what was not even looked at,
  // and `left` what was a candidate but was not read again for want of time.
  let left = 0;
  const done = (found, stopped) => ({ files: found, stopped, unreadable: unreadableCount, unseen: unknown.length + left, hubs });

  // More files than the cut with the name in one lookup: it is everywhere in that lookup
  // (`.length`, `.id`; `id` as a key), which says nothing about where to look — so that lookup
  // gives nothing, and the other keeps its files.
  const candidates = [];
  for (const entry of withReads) {
    const keys = entry.keys && !hubKeys;
    if (!hubReads) candidates.push({ file: entry.file, reads: true, keys });
    else if (keys) candidates.push({ file: entry.file, reads: false, keys: true });
  }
  // A file that has the name only on its own is asked for by the key lookup alone.
  if (!hubKeys) for (const file of withKeys) candidates.push({ file, reads: false, keys: true });
  if (candidates.length === 0) return done([], null);

  let hits = 0;
  const withText = [];
  // Reading the candidates again stops at the deadline of the first read: the name's files are
  // then read over a few requests, and what was not read is said to be unseen. Without this a
  // slow disk could spend the caller's whole patience here, and the worker it replaces would
  // forget what it remembers of the project.
  const deadline = readingDeadline(sentAt, limits);
  for (const [i, { file, reads, keys }] of candidates.entries()) {
    if (Date.now() > deadline) {
      left = candidates.length - i;
      break;
    }
    // Read again: the text is not what is kept between searches.
    const got = readText(root, file, limits);
    if (got.state !== 'ok') {
      if (got.state === 'unreadable' && !notRead.has(file.path)) {
        notRead.add(file.path);
        unreadableCount += 1;
      }
      continue;
    }
    if (!got.text.includes(name)) continue;
    let readsHere = false;
    if (reads) {
      let found = 0;
      for (const _ of got.text.matchAll(needle)) found += 1;
      if (found > 0) {
        // More hits than any search would put in front of a symbol: parsing them is wasted.
        hits += found;
        if (hits > limits.maxHits) return done([], 'uses');
        readsHere = true;
      }
    }
    if (readsHere || keys) withText.push({ file, text: got.text, reads: readsHere, keys });
  }

  // Smallest first: when the budget runs out, what is left out are the few biggest files (a
  // generated bundle parses at a fifth of the speed of written code), not the many small ones.
  withText.sort((a, b) => a.text.length - b.text.length);
  const out = [];
  let parsedBytes = 0;
  for (const { file, text, reads, keys } of withText) {
    // Asked before the file that would cross the budget, so the budget bounds what one scan parses.
    if (parsedBytes + text.length > limits.maxParseBytes) return done(out, 'bytes');
    parsedBytes += text.length;
    let tree;
    try {
      tree = parsers.get(file.lang).parse(text);
    } catch {
      continue;
    }
    try {
      const hitsHere = [];
      const keysHere = [];
      if (reads) {
        for (const { node } of readQueries.get(file.lang).captures(tree.rootNode)) {
          if (node.text !== name) continue;
          const member = node.parent;
          if (member?.type !== 'member_expression' || notARead(member)) continue;
          // The object as written (`a.b.c` is read on `a.b`), on one line as the index records a
          // call's receiver, so that both spellings of one receiver make one row.
          const object = member.childForFieldName('object');
          hitsHere.push({ receiver: object ? object.text.replace(/\s+/g, ' ').trim().slice(0, MAX_RECEIVER) : '', line: node.startPosition.row + 1, column: node.startPosition.column });
        }
      }
      if (keys) {
        for (const { node, name: capture } of keyQueries.get(file.lang).captures(tree.rootNode)) {
          if (node.text !== name) continue;
          keysHere.push({ kind: capture === 'field' ? 'field' : 'key', line: node.startPosition.row + 1, column: node.startPosition.column });
        }
      }
      if (hitsHere.length > 0 || keysHere.length > 0) out.push({ id: file.id, path: file.path, hits: hitsHere, keys: keysHere });
    } finally {
      tree.delete();
    }
  }
  return done(out, null);
}

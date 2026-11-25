// Property-read scan worker (CONTRACTS.md §8 "property reads"). The main thread never parses
// (§9): it sends { type: 'scan', id, root, name, files: [{ id, path, lang }], limits } and
// gets back
//   { type: 'scan', id, files: [{ id, path, hits: [{ receiver, line, column }] }],
//     stopped: null | 'files' | 'bytes' | 'uses', unreadable: number }
// `unreadable` counts the files the index knows that could not be read (outside the project, a
// link, a permission): the answer is short of them.
// Reading and tree-sitter happen here, so a pathologically slow file stalls one request, not
// the server: the caller times out and replaces this worker. `stopped` names the limit that
// ended the scan; rows collected before it are still returned (the caller marks them as a
// lower bound). What is not a read — a call, a construction, a decorator, the target of a
// plain assignment — is left out here, where the tree is. Everything that runs when the worker
// starts comes before the 'ready' message: the caller takes that as "this worker answers scans".
import fs from 'node:fs';
import path from 'node:path';
import { parentPort } from 'worker_threads';
import { initTreeSitter, parserFor } from '../../grammars/loader.mjs';
import { isInside } from '../paths.mjs';
import { propertyReadNeedle } from './prefilter.mjs';

// Entries of `files.lang` whose property reads are not in the index and whose grammar has
// `member_expression`. Python records attribute reads in the index; Go's field selectors are
// covered by neither yet.
const LANGS = ['typescript', 'tsx', 'javascript'];
const PROPERTY_QUERY = '(member_expression property: (property_identifier) @property)';
// A receiver is cut where a call's name is cut in the index.
const MAX_RECEIVER = 80;

await initTreeSitter();
const { Query } = await initTreeSitter();
const parsers = new Map();
const queries = new Map();
for (const lang of LANGS) {
  const parser = await parserFor(lang);
  parsers.set(lang, parser);
  queries.set(lang, new Query(parser.language, PROPERTY_QUERY));
}
parentPort.postMessage({ type: 'ready' });
parentPort.on('message', (msg) => {
  if (msg?.type !== 'scan') return;
  parentPort.postMessage({ type: 'scan', id: msg.id, ...scan(msg) });
});

// What the target of an assignment is wrapped in (node names as the grammars give them, checked
// with `bin/ast.mjs`): a destructuring pattern, a pair of an object pattern, a default value, a
// rest, parentheses.
const WRAPS_A_TARGET = new Set(['array_pattern', 'object_pattern', 'pair_pattern', 'object_assignment_pattern', 'assignment_pattern', 'rest_pattern', 'parenthesized_expression']);

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

function scan({ root, name, files, limits }) {
  const needle = propertyReadNeedle(name);
  const candidates = [];
  let readBytes = 0;
  let hits = 0;
  // Files the index knows and the scan could not read: the answer is short of them.
  let unreadable = 0;
  const done = (found, stopped) => ({ files: found, stopped, unreadable });
  for (const file of files) {
    let text;
    try {
      const abs = path.resolve(root, file.path);
      // The index is not to be trusted with paths, and a link is not followed: only a regular
      // file inside the project is read.
      if (!isInside(root, abs)) { unreadable += 1; continue; }
      const stat = fs.lstatSync(abs);
      if (!stat.isFile()) { unreadable += 1; continue; }
      if (stat.size > limits.maxFileBytes) continue;
      text = fs.readFileSync(abs, 'utf8');
    } catch (err) {
      // Gone is not news (the next sync drops it from the index); anything else leaves a hole.
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') unreadable += 1;
      continue;
    }
    readBytes += text.length;
    if (readBytes > limits.maxReadBytes) return done([], 'bytes');
    // Almost no file has the name at all: looked for plainly before the pattern is.
    if (!text.includes(name)) continue;
    let found = 0;
    for (const _ of text.matchAll(needle)) found += 1;
    if (found === 0) continue;
    // More hits than any search would put in front of a symbol: parsing them is wasted.
    hits += found;
    if (hits > limits.maxHits) return done([], 'uses');
    candidates.push({ ...file, text });
    // More files than the cut with a hit: the name is read everywhere (`.length`, `.id`), which
    // says nothing about where to look. The cut is by the order the files come in (path order).
    if (candidates.length > limits.maxFiles) return done([], 'files');
  }

  // Smallest first: when the budget runs out, what is left out are the few biggest files (a
  // generated bundle parses at a fifth of the speed of written code), not the many small ones.
  candidates.sort((a, b) => a.text.length - b.text.length);
  const out = [];
  let parsedBytes = 0;
  for (const file of candidates) {
    // Asked before the file that would cross the budget, so the budget bounds what one scan parses.
    if (parsedBytes + file.text.length > limits.maxParseBytes) return done(out, 'bytes');
    parsedBytes += file.text.length;
    let tree;
    try {
      tree = parsers.get(file.lang).parse(file.text);
    } catch {
      continue;
    }
    try {
      const found = [];
      for (const { node } of queries.get(file.lang).captures(tree.rootNode)) {
        if (node.text !== name) continue;
        const member = node.parent;
        if (member?.type !== 'member_expression' || notARead(member)) continue;
        // The object as written (`a.b.c` is read on `a.b`), on one line as the index records a
        // call's receiver, so that both spellings of one receiver make one row.
        const object = member.childForFieldName('object');
        found.push({ receiver: object ? object.text.replace(/\s+/g, ' ').trim().slice(0, MAX_RECEIVER) : '', line: node.startPosition.row + 1, column: node.startPosition.column });
      }
      if (found.length > 0) out.push({ id: file.id, path: file.path, hits: found });
    } finally {
      tree.delete();
    }
  }
  return done(out, null);
}

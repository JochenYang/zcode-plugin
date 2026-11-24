#!/usr/bin/env node
// Dev tool: print the named-children tree-sitter AST of a file, with field names.
//   node bin/ast.mjs <languageId> <file> [--depth N] [--all]
// --all also prints anonymous tokens (keywords, punctuation) — noisy but sometimes needed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureLiftoffOnly } from '../src/bootstrap.mjs';

const args = process.argv.slice(2);
if (args.length < 2) {
  process.stderr.write('usage: node bin/ast.mjs <languageId> <file> [--depth N] [--all]\n');
  process.exit(2);
}
const [id, file, ...rest] = args;
const depthArg = rest.indexOf('--depth');
const maxDepth = depthArg >= 0 ? Number(rest[depthArg + 1]) : 6;
const showAll = rest.includes('--all');
if (!(await ensureLiftoffOnly(fileURLToPath(import.meta.url)))) process.exit(0);

const { initEngine, loadSpecs } = await import('../src/extract/engine.mjs');
const { parserFor } = await import('../grammars/loader.mjs');

await initEngine();
const spec = (await loadSpecs()).find((s) => s.id === id);
if (!spec) {
  process.stderr.write(`unknown language pack "${id}"\n`);
  process.exit(2);
}
if (!spec.grammar) {
  process.stderr.write(`"${id}" has no grammar (support: ${spec.support})\n`);
  process.exit(2);
}
const source = fs.readFileSync(file, 'utf8');
const parser = await parserFor(spec.grammar);
const tree = parser.parse(source);
const out = [];
function dump(n, depth) {
  const s = n.startPosition;
  const e = n.endPosition;
  const fields = [];
  for (let i = 0; i < n.childCount; i++) {
    // web-tree-sitter 0.25 exposes fieldNameForChild (singular); newer builds use the plural form.
    const names = typeof n.fieldNameForChild === 'function'
      ? [n.fieldNameForChild(i)]
      : typeof n.fieldNamesForChild === 'function'
        ? n.fieldNamesForChild(i)
        : [];
    for (const name of names) if (name) fields.push(`${name}=${n.child(i).type}`);
  }
  out.push(`${'  '.repeat(depth)}${n.type} [${s.row + 1}:${s.column}-${e.row + 1}:${e.column}]${fields.length ? ' ' + fields.join(' ') : ''}`);
  if (depth < maxDepth) for (const c of showAll ? n.children : n.namedChildren) dump(c, depth + 1);
}
dump(tree.rootNode, 0);
process.stdout.write(`${out.join('\n')}\n`);
process.stdout.write(`# errors: ${tree.rootNode.hasError ? 'yes' : 'no'} (${out.length} nodes printed)\n`);

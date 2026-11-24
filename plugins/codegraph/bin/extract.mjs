#!/usr/bin/env node
// Dev tool: run the extraction engine on files and print what a pack sees.
//   node bin/extract.mjs <file>... [--spec <languageId>] [--refs]
// The language is picked by extension unless --spec forces one. Use it to hand-verify
// expected.json: every line printed must match the source you read.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureLiftoffOnly } from '../src/bootstrap.mjs';

const args = process.argv.slice(2);
const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--spec');
const forced = args.includes('--spec') ? args[args.indexOf('--spec') + 1] : null;
const showRefs = args.includes('--refs');
if (!files.length) {
  process.stderr.write('usage: node bin/extract.mjs <file>... [--spec <languageId>] [--refs]\n');
  process.exit(2);
}
if (!(await ensureLiftoffOnly(fileURLToPath(import.meta.url)))) process.exit(0);

const { initEngine, extractFile, loadSpecs, specForPath } = await import('../src/extract/engine.mjs');

await initEngine();
const specs = await loadSpecs();
for (const file of files) {
  const rel = path.basename(file);
  const spec = forced ? specs.find((s) => s.id === forced) : specForPath(rel, specs);
  if (!spec) {
    process.stdout.write(`## ${file}: no language pack for this extension\n`);
    continue;
  }
  const t0 = performance.now();
  const out = await extractFile({ path: rel, source: fs.readFileSync(file, 'utf8'), spec });
  const ms = Math.round(performance.now() - t0);
  process.stdout.write(`## ${file} · ${spec.id} · ${ms}ms · parseOk=${out.parseOk} errors=${out.errorNodes} refs=${out.refs.length}\n`);
  for (const s of out.symbols) {
    process.stdout.write(`SYM  ${s.kind.padEnd(9)} ${s.name}  ${s.startLine}-${s.endLine}  qual=${s.qual} exported=${s.exported} doc=${JSON.stringify(s.doc)} sig=${JSON.stringify(s.signature)}${s.block !== null ? ` block=${s.block}` : ''}\n`);
  }
  for (const i of out.imports) process.stdout.write(`IMP  ${i.kind} ${i.spec} @${i.startLine} names=${JSON.stringify(i.names)}\n`);
  for (const r of out.refs.filter((r) => r.kind === 'call')) process.stdout.write(`CALL ${r.name}  recv=${r.receiver} @${r.startLine}  in=${r.symbol ?? '-'}\n`);
  if (showRefs) for (const r of out.refs.filter((r) => r.kind !== 'call')) process.stdout.write(`REF  ${r.kind} ${r.name} @${r.startLine}:${r.startCol} in=${r.symbol ?? '-'}${r.scope ? ' scope=' + r.scope : ''}\n`);
}

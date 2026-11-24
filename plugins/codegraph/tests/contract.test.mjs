// One assertion suite for every language pack (CONTRACTS.md §13).
// A pack ships tests/fixtures/langs/<id>/{sample.<ext>, expected.json, broken.<ext>}.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initEngine, extractFile, loadSpecs } from '../src/extract/engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'langs');

// expected.json uses `line`; extracted symbols use `startLine`.
const symbolKey = (s) => `${s.kind}:${s.name}:${s.line ?? s.startLine}-${s.endLine}`;
const importKey = (i) => `${i.spec}@${i.line ?? i.startLine}`;
const callKey = (r) => `${r.name}@${r.line ?? r.startLine}`;

// Multiset difference so duplicate keys (same call twice on one line) still balance.
function compare(expectedKeys, actualKeys, label) {
  const counts = new Map();
  for (const k of expectedKeys) counts.set(k, (counts.get(k) ?? 0) + 1);
  const missing = [];
  for (const k of actualKeys) counts.set(k, (counts.get(k) ?? 0) - 1);
  for (const [k, n] of counts) {
    for (let i = 0; i < n; i++) missing.push(k);
    for (let i = 0; i < -n; i++) missing.push(`(unexpected) ${k}`);
  }
  return { ok: missing.length === 0, message: `${label} mismatch: ${JSON.stringify(missing)}` };
}

let specs;
try {
  await initEngine({ strict: true });
  specs = await loadSpecs();
} catch (err) {
  // Surface load failures as a failing test instead of an unhandled rejection.
  test('language packs load', () => {
    throw err;
  });
  specs = [];
}
// Parallel authors work on one lane at a time: CODEGRAPH_CONTRACT_LANGS=python,ruby limits the run.
const only = (process.env.CODEGRAPH_CONTRACT_LANGS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (only.length) specs = specs.filter((s) => only.includes(s.id));

test('extension ownership is unambiguous', () => {
  const owners = new Map();
  for (const spec of specs) {
    for (const ext of spec.extensions) {
      const e = ext.toLowerCase();
      const prev = owners.get(e);
      assert.ok(!prev || prev === spec.id, `extension ${e} claimed by both ${prev} and ${spec.id}`);
      owners.set(e, spec.id);
    }
  }
});

for (const spec of specs) {
  test(spec.id, async (t) => {
    const dir = path.join(FIXTURES, spec.id);
    const rel = (p) => path.relative(HERE, p).split(path.sep).join('/');
    assert.ok(fs.existsSync(dir), `missing fixture dir ${rel(dir)}/`);
    const ext = spec.extensions[0];
    const samplePath = path.join(dir, `sample${ext}`);
    const brokenPath = path.join(dir, `broken${ext}`);
    const expectedPath = path.join(dir, 'expected.json');
    for (const p of [samplePath, brokenPath, expectedPath]) assert.ok(fs.existsSync(p), `missing ${rel(p)}`);

    const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
    const out = await extractFile({ path: `sample${ext}`, source: fs.readFileSync(samplePath, 'utf8'), spec });

    const parsesScript = spec.support !== 'file-level' && (spec.embeddings.length === 0 || spec.grammar);
    if (parsesScript) assert.equal(out.parseOk, true, `sample${ext} has ${out.errorNodes} ERROR nodes; the fixture must parse cleanly`);

    const symbols = compare((expected.symbols ?? []).map(symbolKey), out.symbols.map(symbolKey), 'symbols');
    assert.ok(symbols.ok, symbols.message);
    // Optional per-symbol fields: qual (qualified name), doc, exported.
    const byKey = new Map(out.symbols.map((s) => [symbolKey(s), s]));
    for (const want of expected.symbols ?? []) {
      const got = byKey.get(symbolKey(want));
      if (!got) continue; // already reported by the multiset comparison
      for (const field of ['qual', 'doc']) {
        if (want[field] !== undefined) assert.equal(got[field], want[field], `symbol ${want.name}: ${field} mismatch`);
      }
      if (want.exported !== undefined) assert.equal(got.exported, want.exported, `symbol ${want.name}: exported mismatch`);
    }
    const imports = compare((expected.imports ?? []).map(importKey), out.imports.map(importKey), 'imports');
    assert.ok(imports.ok, imports.message);
    const calls = compare((expected.calls ?? []).map(callKey), out.refs.filter((r) => r.kind === 'call').map(callKey), 'calls');
    assert.ok(calls.ok, calls.message);
    // Refs are noisy, so `refs` is a required subset: each listed occurrence must exist with that enclosing symbol.
    const symName = (i) => (i === null || i === undefined ? null : out.symbols[i]?.name ?? null);
    const refKeys = new Set(out.refs.map((r) => `${r.kind === 'call' ? 'call' : 'ref'}:${r.name}@${r.startLine}->${symName(r.symbol)}`));
    for (const want of expected.refs ?? []) {
      const key = `${want.kind ?? 'call'}:${want.name}@${want.line}->${want.symbol ?? null}`;
      assert.ok(refKeys.has(key), `ref ${key} not found; have: ${[...refKeys].filter((k) => k.includes(`${want.name}@`)).join(', ')}`);
    }

    await t.test('broken input never throws', async () => {
      const broken = await extractFile({ path: `broken${ext}`, source: fs.readFileSync(brokenPath, 'utf8'), spec });
      assert.equal(typeof broken.parseOk, 'boolean');
      if (parsesScript) {
        assert.ok(broken.errorNodes > 0, 'broken fixture must actually produce ERROR nodes to prove error tolerance');
      }
    });
  });
}

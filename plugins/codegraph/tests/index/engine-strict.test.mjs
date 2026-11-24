// initEngine({ strict: true }) compiles every language pack's discovery query at
// load time (contract tests run this way so a bad pack fails fast); the bundled
// packs must compile cleanly, and a pattern the compiler rejects must surface
// here rather than as an exception for every file of that language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initEngine, compileSpecQueries, loadSpecs, specForPath } from '../../src/extract/engine.mjs';

test('strict init compiles every bundled pack query and succeeds', { timeout: 120000 }, async () => {
  await initEngine({ strict: true });
  const specs = await loadSpecs();
  assert.ok(specs.length > 1);
  assert.ok(specs.every((s) => !s.grammar || typeof s.grammar === 'string'));
});

test('a pattern the query compiler rejects fails the strict precompile', async () => {
  const ts = specForPath('a.ts', await loadSpecs());
  assert.ok(ts);
  // Unknown node type nested inside a pattern: the root-type filter in specQuery
  // does not apply, so this used to throw for every file instead of at load time.
  const nested = { ...ts, id: 'ts-test-bad-nested', skipPatterns: ['(required_parameter pattern: (no_such_node_type) @skip)'] };
  await assert.rejects(compileSpecQueries([nested]), /no_such_node_type/);
  // A syntax error in a pattern: same story.
  const syntax = { ...ts, id: 'ts-test-bad-syntax', skipPatterns: ['(required_parameter pattern: (identifier) @skip'] };
  await assert.rejects(compileSpecQueries([syntax]), /Bad syntax/);
  // An unknown node type at a pattern ROOT is dropped with a warning (CONTRACTS.md §6), not an error.
  const root = { ...ts, id: 'ts-test-bad-root', definitions: { ...ts.definitions, no_such_node_type: { kind: 'function', name: 'name' } } };
  await compileSpecQueries([root]);
});

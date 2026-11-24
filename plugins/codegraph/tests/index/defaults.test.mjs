import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, applyDefaults } from '../../src/index/defaults.mjs';

describe('applyDefaults', () => {
  test('fills every §12 field with the documented default', () => {
    const cfg = applyDefaults({});
    assert.deepEqual(cfg, {
      autoIndex: true,
      minFilesToAutoIndex: 30,
      maxFiles: 30000,
      exclude: [],
      languages: null,
      defaultBudgetTokens: { lookup: 1500, map: 1200 },
      frontload: false,
      maxFileBytes: 4194304,
    });
    assert.deepEqual(applyDefaults(undefined), cfg);
    assert.deepEqual(applyDefaults(null), cfg);
    assert.equal(DEFAULT_CONFIG.maxFileBytes, 4194304);
  });

  test('keeps provided values, merges the token budget per key and ignores unknown keys', () => {
    const cfg = applyDefaults({
      autoIndex: false,
      maxFiles: 10,
      exclude: ['dist', 'src/generated'],
      languages: ['typescript'],
      defaultBudgetTokens: { map: 900 },
      frontload: true,
      maxFileBytes: 4096,
      somethingElse: 1,
    });
    assert.equal(cfg.autoIndex, false);
    assert.equal(cfg.maxFiles, 10);
    assert.equal(cfg.minFilesToAutoIndex, 30);
    assert.deepEqual(cfg.exclude, ['dist', 'src/generated']);
    assert.deepEqual(cfg.languages, ['typescript']);
    assert.deepEqual(cfg.defaultBudgetTokens, { lookup: 1500, map: 900 });
    assert.equal(cfg.frontload, true);
    assert.equal(cfg.maxFileBytes, 4096);
    assert.equal('somethingElse' in cfg, false);
  });

  test('returns fresh arrays so the shared defaults can never be mutated', () => {
    const a = applyDefaults({ exclude: ['x'] });
    a.exclude.push('y');
    a.defaultBudgetTokens.lookup = 1;
    const b = applyDefaults({});
    assert.deepEqual(b.exclude, []);
    assert.equal(b.defaultBudgetTokens.lookup, 1500);
  });

  test('rejects values of the wrong type with the field name', () => {
    assert.throws(() => applyDefaults([]), /applyDefaults: "config" must be an object/);
    assert.throws(() => applyDefaults({ autoIndex: 'true' }), /"autoIndex" must be a boolean \(got string\)/);
    assert.throws(() => applyDefaults({ maxFiles: '10' }), /"maxFiles" must be an integer >= 1 \(got string\)/);
    assert.throws(() => applyDefaults({ maxFiles: 0 }), /"maxFiles" must be an integer >= 1/);
    assert.throws(() => applyDefaults({ minFilesToAutoIndex: 1.5 }), /"minFilesToAutoIndex" must be an integer/);
    assert.throws(() => applyDefaults({ exclude: 'dist' }), /"exclude" must be an array of strings \(got string\)/);
    assert.throws(() => applyDefaults({ exclude: [1] }), /"exclude\[0\]" must be a non-empty string/);
    assert.throws(() => applyDefaults({ exclude: ['  '] }), /"exclude\[0\]" must be a non-empty string/);
    assert.throws(() => applyDefaults({ languages: 'typescript' }), /"languages" must be an array of strings/);
    assert.throws(() => applyDefaults({ defaultBudgetTokens: [] }), /"defaultBudgetTokens" must be an object/);
    assert.throws(() => applyDefaults({ defaultBudgetTokens: { lookup: 0 } }), /"defaultBudgetTokens.lookup" must be an integer >= 1/);
    assert.throws(() => applyDefaults({ maxFileBytes: -1 }), /"maxFileBytes" must be an integer >= 1/);
  });
});

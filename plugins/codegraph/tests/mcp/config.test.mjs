// Configuration loading (CONTRACTS.md §12): defaults <- codegraph.json <- env.
// The env shapes below are the ones the host renders from plugin.json userConfig
// (booleans "true"/"false", empty strings for unset numbers / exclude).
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, loadConfig } from '../../src/config.mjs';
import { configPath } from '../../src/paths.mjs';

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function tmpFile(name = 'codegraph.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-config-'));
  dirs.push(dir);
  return path.join(dir, name);
}

function capture() {
  const lines = [];
  return { stderr: { write: (s) => lines.push(String(s)) }, lines };
}

function load(text, env = {}, file = tmpFile()) {
  if (text !== null) fs.writeFileSync(file, text);
  const out = capture();
  const config = loadConfig({ file, env, stderr: out.stderr });
  return { config, lines: out.lines };
}

const CONTRACT_DEFAULTS = {
  autoIndex: true,
  minFilesToAutoIndex: 30,
  maxFiles: 30000,
  exclude: [],
  languages: null,
  defaultBudgetTokens: { lookup: 1500, map: 1200 },
  frontload: false,
};

describe('DEFAULT_CONFIG', () => {
  test('matches the §12 fields and defaults; liftoffOnly is the §0 safety switch', () => {
    const { liftoffOnly, ...rest } = DEFAULT_CONFIG;
    assert.deepEqual({ ...rest }, CONTRACT_DEFAULTS);
    assert.equal(liftoffOnly, false);
    assert.equal(Object.isFrozen(DEFAULT_CONFIG), true);
    assert.equal(Object.isFrozen(DEFAULT_CONFIG.defaultBudgetTokens), true);
  });
});

describe('loadConfig', () => {
  test('missing file: defaults, one stderr line, fresh mutable copies', () => {
    const file = tmpFile('absent.json');
    const out = capture();
    const config = loadConfig({ file, env: {}, stderr: out.stderr });
    assert.deepEqual(config, { ...CONTRACT_DEFAULTS, liftoffOnly: false });
    assert.equal(out.lines.length, 1);
    assert.match(out.lines[0], new RegExp(`^codegraph: no config file at .*absent\\.json; using defaults\\n$`));
    assert.notEqual(config, DEFAULT_CONFIG);
    assert.notEqual(config.exclude, DEFAULT_CONFIG.exclude);
    assert.notEqual(config.defaultBudgetTokens, DEFAULT_CONFIG.defaultBudgetTokens);
    config.exclude.push('x');
    config.defaultBudgetTokens.lookup = 1;
    assert.deepEqual(DEFAULT_CONFIG.exclude, []);
    assert.equal(DEFAULT_CONFIG.defaultBudgetTokens.lookup, 1500);
  });

  test('file fields merge over defaults, nested budgets merge per key', () => {
    const { config, lines } = load(
      JSON.stringify({ autoIndex: false, maxFiles: 5000, exclude: ['dist', 'generated/**'], defaultBudgetTokens: { lookup: 900 }, languages: ['typescript'] }),
    );
    assert.deepEqual(lines, []);
    assert.deepEqual(config, {
      autoIndex: false,
      minFilesToAutoIndex: 30,
      maxFiles: 5000,
      exclude: ['dist', 'generated/**'],
      languages: ['typescript'],
      defaultBudgetTokens: { lookup: 900, map: 1200 },
      frontload: false,
      liftoffOnly: false,
    });
  });

  test('file wins over the environment; the environment only fills unset fields', () => {
    const { config, lines } = load(JSON.stringify({ autoIndex: true, maxFiles: 500 }), {
      CODEGRAPH_AUTO_INDEX: 'false',
      CODEGRAPH_MAX_FILES: '9000',
      CODEGRAPH_MIN_FILES: '5',
      CODEGRAPH_EXCLUDE: 'a,b',
      CODEGRAPH_LIFTOFF_ONLY: 'true',
    });
    assert.deepEqual(lines, []);
    assert.equal(config.autoIndex, true, 'file value kept');
    assert.equal(config.maxFiles, 500, 'file value kept');
    assert.equal(config.minFilesToAutoIndex, 5, 'env fills the unset field');
    assert.deepEqual(config.exclude, ['a', 'b']);
    assert.equal(config.liftoffOnly, true);
  });

  test('booleans accept the userConfig shapes: "true"/"false", "1"/"0", "yes"/"no", "" = false', () => {
    const cases = [
      ['true', true], ['TRUE', true], ['1', true], ['yes', true], ['on', true], [' true ', true],
      ['false', false], ['0', false], ['no', false], ['off', false], ['', false], ['  ', false],
    ];
    for (const [raw, expected] of cases) {
      const { config, lines } = load("{}", { CODEGRAPH_AUTO_INDEX: raw, CODEGRAPH_LIFTOFF_ONLY: raw });
      assert.deepEqual(lines, [], `raw ${JSON.stringify(raw)}`);
      assert.equal(config.autoIndex, expected, `autoIndex for ${JSON.stringify(raw)}`);
      assert.equal(config.liftoffOnly, expected, `liftoffOnly for ${JSON.stringify(raw)}`);
    }
    const unset = load("{}", {}).config;
    assert.equal(unset.autoIndex, true, 'absent variable leaves the default');
    assert.equal(unset.liftoffOnly, false);
  });

  test('numbers: valid strings parse, empty string means not set, garbage is ignored with a warning', () => {
    const ok = load("{}", { CODEGRAPH_MAX_FILES: '12000', CODEGRAPH_MIN_FILES: ' 0 ' });
    assert.deepEqual(ok.lines, []);
    assert.equal(ok.config.maxFiles, 12000);
    assert.equal(ok.config.minFilesToAutoIndex, 0);
    const empty = load("{}", { CODEGRAPH_MAX_FILES: '', CODEGRAPH_MIN_FILES: '' });
    assert.deepEqual(empty.lines, []);
    assert.equal(empty.config.maxFiles, 30000, '"" falls back to the default');
    assert.equal(empty.config.minFilesToAutoIndex, 30);
    const bad = load("{}", { CODEGRAPH_MAX_FILES: 'abc', CODEGRAPH_MIN_FILES: '-3' });
    assert.equal(bad.config.maxFiles, 30000);
    assert.equal(bad.config.minFilesToAutoIndex, 30);
    assert.equal(bad.lines.length, 2);
    assert.match(bad.lines[0], /ignoring CODEGRAPH_MIN_FILES="-3": must be an integer >= 0/);
    assert.match(bad.lines[1], /ignoring CODEGRAPH_MAX_FILES="abc": must be an integer >= 1/);
  });

  test('exclude: comma separated, trimmed, blanks dropped; "" is not set', () => {
    const { config, lines } = load("{}", { CODEGRAPH_EXCLUDE: ' dist, generated/** ,,vendor ' });
    assert.deepEqual(lines, []);
    assert.deepEqual(config.exclude, ['dist', 'generated/**', 'vendor']);
    const empty = load("{}", { CODEGRAPH_EXCLUDE: '' });
    assert.deepEqual(empty.lines, []);
    assert.deepEqual(empty.config.exclude, []);
    const invalid = load("{}", { CODEGRAPH_AUTO_INDEX: 'maybe' });
    assert.equal(invalid.config.autoIndex, true);
    assert.match(invalid.lines[0], /ignoring CODEGRAPH_AUTO_INDEX="maybe": must be a boolean/);
  });

  test('corrupted or non-object file: defaults and one stderr line', () => {
    const broken = load('{ "autoIndex": false, ');
    assert.deepEqual(broken.config, { ...CONTRACT_DEFAULTS, liftoffOnly: false });
    assert.equal(broken.lines.length, 1);
    assert.match(broken.lines[0], /is not valid JSON \(.*\); using defaults/);
    const array = load('[1, 2]');
    assert.equal(array.config.autoIndex, true);
    assert.match(array.lines[0], /must contain a JSON object; using defaults/);
  });

  test('wrong field types fall back to the default for that field only, naming the field', () => {
    const { config, lines } = load(
      JSON.stringify({ autoIndex: 'no', maxFiles: 2.5, minFilesToAutoIndex: -1, exclude: 'dist', languages: 'ts', defaultBudgetTokens: { lookup: 10 }, frontload: 1 }),
    );
    assert.equal(config.autoIndex, true);
    assert.equal(config.maxFiles, 30000);
    assert.equal(config.minFilesToAutoIndex, 30);
    assert.deepEqual(config.exclude, []);
    assert.equal(config.languages, null);
    assert.deepEqual(config.defaultBudgetTokens, { lookup: 1500, map: 1200 });
    assert.equal(config.frontload, false);
    assert.equal(lines.length, 7);
    for (const field of ['autoIndex', 'maxFiles', 'minFilesToAutoIndex', 'exclude', 'languages', 'defaultBudgetTokens', 'frontload']) {
      assert.ok(lines.some((l) => l.includes(`"${field}"`)), `warning names ${field}`);
    }
    assert.match(lines[5], /"defaultBudgetTokens" in .*: "lookup" must be an integer between 200 and 4000 \(got object\)/);
  });

  test('a valid field survives next to an invalid one; a BOM is tolerated', () => {
    const { config, lines } = load('\uFEFF{"maxFiles": 777, "autoIndex": "nope"}');
    assert.equal(config.maxFiles, 777);
    assert.equal(config.autoIndex, true);
    assert.equal(lines.length, 1);
  });

  test('without arguments it reads configPath() under ZCODE_PLUGIN_DATA', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-configdata-'));
    dirs.push(dir);
    const previous = process.env.ZCODE_PLUGIN_DATA;
    process.env.ZCODE_PLUGIN_DATA = dir;
    try {
      fs.writeFileSync(configPath(), JSON.stringify({ maxFiles: 321 }));
      const out = capture();
      const config = loadConfig({ stderr: out.stderr });
      assert.equal(config.maxFiles, 321);
      assert.deepEqual(out.lines, []);
      assert.equal(path.basename(configPath()), 'codegraph.json');
    } finally {
      if (previous === undefined) delete process.env.ZCODE_PLUGIN_DATA;
      else process.env.ZCODE_PLUGIN_DATA = previous;
    }
  });

  test('every call returns an independent object', () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ exclude: ['a'] }));
    const first = loadConfig({ file, env: {}, stderr: capture().stderr });
    const second = loadConfig({ file, env: {}, stderr: capture().stderr });
    assert.deepEqual(first, second);
    assert.notEqual(first, second);
    assert.notEqual(first.exclude, second.exclude);
  });
});

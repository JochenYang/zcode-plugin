// Import specifier resolution (CONTRACTS.md §8): pure candidate generation per
// ecosystem and matching against indexed files.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFileIndex, detectEcosystem, resolveImport, resolveSpec } from '../../src/resolve/imports.mjs';

const node = (spec, fromPath, extra = {}) => resolveSpec(spec, { ecosystem: 'node', fromPath, ...extra });

describe('node', () => {
  test('relative specifiers expand to source extensions, then index files, relative to the importing file', () => {
    assert.deepEqual(node('./util', 'src/config/parse.ts'), [
      'src/config/util.ts', 'src/config/util.tsx', 'src/config/util.d.ts', 'src/config/util.js', 'src/config/util.jsx',
      'src/config/util.mjs', 'src/config/util.cjs', 'src/config/util.mts', 'src/config/util.cts',
      'src/config/util/index.ts', 'src/config/util/index.tsx', 'src/config/util/index.d.ts', 'src/config/util/index.js',
      'src/config/util/index.jsx', 'src/config/util/index.mjs', 'src/config/util/index.cjs', 'src/config/util/index.mts', 'src/config/util/index.cts',
    ]);
    assert.deepEqual(node('../shared/x', 'src/config/parse.ts').slice(0, 3), ['src/shared/x.ts', 'src/shared/x.tsx', 'src/shared/x.d.ts']);
    assert.deepEqual(node('../../escape', 'src/config/parse.ts').slice(0, 2), ['escape.ts', 'escape.tsx'], 'two levels up from src/config is the project root');
    assert.deepEqual(node('../../../escape', 'src/config/parse.ts'), [], 'never climbs out of the project');
    assert.equal(node('./x.js', 'a/b.ts')[0], 'a/x.ts', 'a .js specifier prefers the .ts source');
    assert.ok(node('./x.js', 'a/b.ts').includes('a/x.js'));
    assert.deepEqual(node('./style.css', 'a/b.ts'), ['a/style.css'], 'assets stay verbatim');
    assert.deepEqual(node('./x?raw', 'a/b.ts').slice(0, 2), ['a/x.ts', 'a/x.tsx'], 'query strings are stripped');
    assert.deepEqual(node('.\\windows\\path', 'a/b.ts').slice(0, 1), ['a/windows/path.ts']);
  });

  test('packages, node: prefixes, subpath imports and absolute paths are never project files', () => {
    for (const spec of ['react', 'react-dom/client', 'node:fs', '#internal/x', '/abs/x', '']) {
      assert.deepEqual(node(spec, 'src/a.ts'), [], spec);
    }
    assert.equal(detectEcosystem('react'), 'none');
    assert.equal(detectEcosystem('node:fs'), 'none');
    assert.equal(detectEcosystem('./util'), 'node');
  });

  test('matching prefers the first existing candidate in TypeScript order', () => {
    const index = buildFileIndex(['src/config/util.js', 'src/config/util.d.ts', 'src/shared/x.js', 'src/shared/x.ts', 'src/idx/index.tsx']);
    assert.equal(resolveImport('./util', { ecosystem: 'node', fromPath: 'src/config/parse.ts', index }).path, 'src/config/util.d.ts');
    assert.equal(resolveImport('./x', { ecosystem: 'node', fromPath: 'src/shared/parse.ts', index }).path, 'src/shared/x.ts');
    assert.equal(resolveImport('./idx', { ecosystem: 'node', fromPath: 'src/parse.ts', index }).path, 'src/idx/index.tsx');
    const miss = resolveImport('./nope', { ecosystem: 'node', fromPath: 'src/parse.ts', index });
    assert.equal(miss.path, null);
    assert.equal(miss.ambiguous, false);
    assert.ok(miss.candidates.length > 0);
  });

  test('listFiles turns candidates into the paths that exist', () => {
    const listFiles = () => ['src/config/util.js'];
    assert.deepEqual(resolveSpec('./util', { ecosystem: 'node', fromPath: 'src/config/parse.ts', listFiles }), ['src/config/util.js']);
    assert.deepEqual(resolveSpec('./nope', { ecosystem: 'node', fromPath: 'src/config/parse.ts', listFiles: new Set(['a.ts']) }), []);
  });
});

describe('python', () => {
  test('dotted modules map to module.py and package __init__.py; relative dots walk up from the importing file', () => {
    assert.deepEqual(resolveSpec('a.b', { ecosystem: 'python', fromPath: 'pkg/mod.py' }), ['a/b.py', 'a/b/__init__.py']);
    assert.deepEqual(resolveSpec('.a.b', { ecosystem: 'python', fromPath: 'pkg/mod.py' }), ['pkg/a/b.py', 'pkg/a/b/__init__.py']);
    assert.deepEqual(resolveSpec('..a.b', { ecosystem: 'python', fromPath: 'pkg/sub/mod.py' }), ['pkg/a/b.py', 'pkg/a/b/__init__.py']);
    assert.deepEqual(resolveSpec('.', { ecosystem: 'python', fromPath: 'pkg/sub/mod.py' }), ['pkg/sub/__init__.py']);
    assert.deepEqual(resolveSpec('..', { ecosystem: 'python', fromPath: 'pkg/sub/mod.py' }), ['pkg/__init__.py']);
    assert.deepEqual(resolveSpec('....', { ecosystem: 'python', fromPath: 'pkg/sub/mod.py' }), [], 'never above the project root');
    assert.equal(detectEcosystem('a.b'), 'python');
    assert.equal(detectEcosystem('.a.b'), 'python');
  });

  test('matching picks module.py before the package', () => {
    const index = buildFileIndex(['pkg/a/b.py', 'pkg/a/b/__init__.py', 'pkg/c/__init__.py']);
    assert.equal(resolveImport('.a.b', { ecosystem: 'python', fromPath: 'pkg/mod.py', index }).path, 'pkg/a/b.py');
    assert.equal(resolveImport('pkg.c', { ecosystem: 'python', fromPath: 'x.py', index }).path, 'pkg/c/__init__.py');
    assert.equal(resolveImport('pkg.missing', { ecosystem: 'python', fromPath: 'x.py', index }).path, null);
  });
});

describe('go', () => {
  test('with the module path: module root, in-module package directories, external -> vendor', () => {
    const options = { ecosystem: 'go', module: 'example.com/x/y' };
    assert.deepEqual(resolveSpec('example.com/x/y', options), ['./']);
    assert.deepEqual(resolveSpec('example.com/x/y/pkg/sub', options), ['pkg/sub/']);
    assert.deepEqual(resolveSpec('github.com/other/lib', options), ['vendor/github.com/other/lib/']);
    assert.deepEqual(resolveSpec('fmt', options), ['vendor/fmt/'], 'stdlib only matches when vendored and indexed');
    assert.equal(resolveImport('fmt', { ...options, index: buildFileIndex(['cmd/main.go']) }).path, null);
    assert.equal(detectEcosystem('github.com/x/y/z'), 'go');
    assert.equal(detectEcosystem('fmt'), 'none');
  });

  test('without go.mod the longest in-project directory tail wins', () => {
    assert.deepEqual(resolveSpec('example.com/x/internal/util', { ecosystem: 'go' }), ['x/internal/util/', 'internal/util/', 'util/']);
    const index = buildFileIndex(['cmd/server/main.go', 'internal/util/util.go', 'internal/util/helper.go']);
    const hit = resolveImport('example.com/x/internal/util', { ecosystem: 'go', index });
    assert.equal(hit.path, 'internal/util/helper.go', 'a directory candidate resolves to its first indexed file');
    assert.equal(resolveImport('example.com/x/cmd/server', { ecosystem: 'go', index }).path, 'cmd/server/main.go');
    assert.equal(resolveImport('example.com/x/missing', { ecosystem: 'go', index }).path, null);
  });

  test('root reads go.mod once and prefers the declared module', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-go-'));
    try {
      fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/x/y\n\ngo 1.22\n');
      assert.deepEqual(resolveSpec('example.com/x/y/pkg/sub', { ecosystem: 'go', root: dir }), ['pkg/sub/']);
      assert.deepEqual(resolveSpec('example.com/x/pkg', { ecosystem: 'go', root: dir }), ['vendor/example.com/x/pkg/']);
      fs.writeFileSync(path.join(dir, 'go.mod'), 'module other\n');
      // Cached per root: a second call keeps the first module (one process, one index).
      assert.deepEqual(resolveSpec('example.com/x/y/pkg/sub', { ecosystem: 'go', root: dir }), ['pkg/sub/']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('jvm', () => {
  test('a.b.C -> a/b/C.{java,kt,scala}, nested types fall back to the outer type, wildcards name a package directory', () => {
    assert.deepEqual(resolveSpec('a.b.C', { ecosystem: 'jvm' }), ['a/b/C.java', 'a/b/C.kt', 'a/b/C.scala', 'a/b.java', 'a/b.kt', 'a/b.scala']);
    assert.deepEqual(resolveSpec('a.b.C.D', { ecosystem: 'jvm' }).slice(3), ['a/b/C.java', 'a/b/C.kt', 'a/b/C.scala']);
    assert.deepEqual(resolveSpec('a.b.*', { ecosystem: 'jvm' }), ['a/b/']);
    assert.equal(detectEcosystem('a.b.C'), 'jvm');
  });

  test('matching finds the type under a source root and refuses ambiguous tails', () => {
    const index = buildFileIndex(['src/main/java/com/x/A.java', 'src/main/kotlin/com/x/B.kt', 'src/test/java/org/x/A.java', 'lib/com/x/A.kt']);
    assert.equal(resolveImport('com.x.A', { ecosystem: 'jvm', index }).path, 'src/main/java/com/x/A.java');
    assert.equal(resolveImport('com.x.B', { ecosystem: 'jvm', index }).path, 'src/main/kotlin/com/x/B.kt');
    const ambiguous = resolveImport('x.A', { ecosystem: 'jvm', index });
    assert.equal(ambiguous.path, null);
    assert.equal(ambiguous.ambiguous, true, 'x/A.java exists under two packages');
  });
});

describe('dotnet', () => {
  test('a type maps to its file: namespace path first, then the bare file name', () => {
    assert.deepEqual(resolveSpec('A.B.C', { ecosystem: 'dotnet' }), ['A/B/C.cs', 'C.cs']);
    assert.equal(detectEcosystem('C'), 'none', 'a bare name needs the language to pick the ecosystem');
  });

  test('matching by namespace folder, then unique file name; several same-named files are ambiguous', () => {
    const index = buildFileIndex(['src/Program.cs', 'src/Services/Foo.cs', 'src/Other/Foo.cs']);
    assert.equal(resolveImport('Program', { ecosystem: 'dotnet', index }).path, 'src/Program.cs');
    assert.equal(resolveImport('Services.Foo', { ecosystem: 'dotnet', index }).path, 'src/Services/Foo.cs');
    const ambiguous = resolveImport('Foo', { ecosystem: 'dotnet', index });
    assert.equal(ambiguous.path, null);
    assert.equal(ambiguous.ambiguous, true);
  });
});

describe('none', () => {
  test('languages without an import model resolve nothing', () => {
    assert.deepEqual(resolveSpec('whatever', { ecosystem: 'none' }), []);
    assert.deepEqual(resolveSpec('foo::bar', { ecosystem: 'none' }), []);
  });
});

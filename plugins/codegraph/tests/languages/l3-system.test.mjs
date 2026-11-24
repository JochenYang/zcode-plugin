// Lane L3 (Go, Rust, C, C++, Objective-C, Metal, CUDA): behaviour the shared contract suite
// does not pin down — export rules, declarator name paths, selector building, the CUDA/Metal
// preprocessing shim, and "no node types absent from grammar" warnings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initEngine, extractFile, loadSpecs, specForPath } from '../../src/extract/engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures', 'langs');
const L3 = ['go', 'rust', 'c', 'cpp', 'objc', 'metal', 'cuda'];

await initEngine();
const specs = await loadSpecs();
const byId = Object.fromEntries(specs.map((s) => [s.id, s]));

// The engine warns on stderr when a pack lists node types the grammar lacks; none may.
const warnings = [];
const origWrite = process.stderr.write;
process.stderr.write = (chunk, ...rest) => {
  const text = String(chunk);
  if (text.includes('node types absent')) warnings.push(text);
  return origWrite.call(process.stderr, chunk, ...rest);
};

const extract = (id, source, name = `inline.${byId[id].extensions[0]}`) => extractFile({ path: name, source, spec: byId[id] });
const symbols = (out) => out.symbols.map((s) => `${s.kind} ${s.name}`);
const calls = (out) => out.refs.filter((r) => r.kind === 'call').map((r) => `${r.receiver ? `${r.receiver}.` : ''}${r.name}`);

test('extension ownership: each L3 extension resolves to its pack', () => {
  const expect = {
    'a.go': 'go', 'a.rs': 'rust', 'a.c': 'c', 'a.h': 'c', 'a.cpp': 'cpp', 'a.hpp': 'cpp', 'a.cc': 'cpp', 'a.cxx': 'cpp', 'a.hxx': 'cpp',
    'a.m': 'objc', 'a.mm': 'objc', 'a.metal': 'metal', 'a.cu': 'cuda', 'a.cuh': 'cuda', 'dir/UPPER.CU': 'cuda',
  };
  for (const [file, id] of Object.entries(expect)) assert.equal(specForPath(file, specs)?.id, id, file);
});

test('Go: exported = leading uppercase rune; package-scope const/var/type only; import aliases', async () => {
  const out = await extract('go', `package p

import (
	"fmt"
	str "strings"
	. "math"
	_ "embed"
)

// Doc for exported const.
const Exported = 1
const unexported = 2
var Version = "1"
var hidden = 0

type Ünicode struct{ X int }
type edge struct{}
type Kind int
type Iface interface{ M() }

func Public() {}
func private() {
	const local = 1
	var lv int
	type inner struct{}
	_ = local; _ = lv; _ = inner{}
}
`);
  assert.deepEqual(symbols(out), [
    'constant Exported', 'constant unexported', 'variable Version', 'variable hidden',
    'struct Ünicode', 'field X', 'struct edge', 'type Kind', 'interface Iface', 'method M',
    'function Public', 'function private',
  ]);
  const exported = Object.fromEntries(out.symbols.map((s) => [`${s.kind} ${s.name}`, s.exported]));
  assert.equal(exported['constant Exported'], true);
  assert.equal(exported['constant unexported'], false);
  assert.equal(exported['struct Ünicode'], true, 'unicode uppercase letter is exported');
  assert.equal(exported['struct edge'], false);
  assert.equal(exported['type Kind'], true);
  assert.equal(exported['function Public'], true);
  assert.equal(exported['function private'], false);
  assert.equal(exported['variable Version'], true);
  assert.equal(exported['variable hidden'], false);
  assert.equal(out.symbols.find((s) => s.name === 'Exported').doc, 'Doc for exported const.');
  assert.deepEqual(out.imports.map((i) => [i.spec, i.names]), [
    ['fmt', null],
    ['strings', [{ imported: '*', alias: 'str' }]],
    ['math', [{ imported: '*', alias: '.' }]],
    ['embed', null],
  ]);
});

test('Go: methods carry the receiver in the signature; selector fields are not duplicate refs', async () => {
  const out = await extract('go', `package p
type T struct{ F int }
func (t *T) Get() int { return t.F }
func use(t *T) int { return t.Get() }
`);
  const get = out.symbols.find((s) => s.name === 'Get' && s.kind === 'method');
  assert.equal(get.signature, '(t *T) () int');
  assert.deepEqual(calls(out), ['t.Get']);
  assert.ok(!out.refs.some((r) => r.kind !== 'call' && r.name === 'Get'), 'method name must not be both call and ref');
  assert.ok(!out.refs.some((r) => r.kind !== 'call' && r.name === 't' && r.startCol === 6), 'the receiver name is not a ref');
  assert.ok(!out.refs.some((r) => r.kind !== 'call' && r.name === 'F'), 'selector fields are not duplicate refs');
});

test('Rust: pub / pub(crate) are exported, impl methods are methods of the impl symbol', async () => {
  const out = await extract('rust', `//! crate doc
use std::collections::HashMap as Map;
use a::b::{self, C as D};
use a::b::*;

pub const MAX: usize = 1;
const HIDDEN: usize = 2;
pub(crate) fn crate_only() {}
fn private() {}
pub struct S { pub a: u32, b: u32 }
impl S {
    /// Multi-line doc
    /// second line.
    #[inline]
    pub fn new() -> Self { S { a: 0, b: 0 } }
    fn hidden(&self) {}
}
pub trait T { fn m(&self); }
pub type Alias = Map<String, u32>;
pub mod inner { pub fn helper() {} }
macro_rules! mac { () => {} }
`);
  const exported = Object.fromEntries(out.symbols.map((s) => [`${s.kind} ${s.name}`, s.exported]));
  assert.equal(exported['constant MAX'], true);
  assert.equal(exported['constant HIDDEN'], false);
  assert.equal(exported['function crate_only'], true);
  assert.equal(exported['function private'], false);
  assert.equal(exported['field a'], true);
  assert.equal(exported['field b'], false);
  assert.equal(exported['method new'], true);
  assert.equal(exported['method hidden'], false);
  assert.equal(exported['type impl S'], null, 'an impl block is neither exported nor private');
  assert.equal(exported['trait T'], true);
  assert.equal(exported['type Alias'], true);
  assert.equal(exported['namespace inner'], true);
  assert.equal(exported['macro mac'], false);

  const newFn = out.symbols.find((s) => s.name === 'new');
  assert.equal(newFn.kind, 'method');
  assert.equal(newFn.qual, 'impl S.new');
  assert.equal(newFn.doc, 'Multi-line doc second line.', '/// lines merge and attributes between doc and item are skipped');
  const traitM = out.symbols.find((s) => s.name === 'm');
  assert.equal(traitM.kind, 'method');
  assert.equal(traitM.qual, 'T.m');
  // `use ... as ...` keeps the whole clause as the spec; names carry the local alias.
  assert.deepEqual(out.imports.map((i) => [i.spec, i.names]), [
    ['std::collections::HashMap as Map', [{ imported: 'HashMap', alias: 'Map' }]],
    ['a::b::{self, C as D}', [{ imported: 'self', alias: 'self' }, { imported: 'C', alias: 'D' }]],
    ['a::b::*', null],
  ]);
});

test('Rust: generic calls split into receiver and name; macro arguments are token trees', async () => {
  const out = await extract('rust', `fn f(xs: &[u8]) -> Vec<u8> {
    println!("{:?}", xs.len());
    xs.iter().map(|b| *b).collect::<Vec<_>>()
}
`);
  // `xs.len()` sits inside `println!(...)`: the macro body is a raw token_tree, not expressions.
  // Chained calls share a start position, so the outermost call comes first.
  const callNames = out.refs.filter((r) => r.kind === 'call').map((r) => r.name);
  assert.deepEqual(callNames, ['println', 'collect', 'map', 'iter']);
  assert.equal(out.refs.find((r) => r.kind === 'call' && r.name === 'collect').receiver, 'xs.iter().map(|b| *b)');
  assert.equal(out.refs.find((r) => r.kind === 'call' && r.name === 'map').receiver, 'xs.iter()');
});

test('C: function names come from declarator.declarator (also behind pointer declarators)', async () => {
  const out = await extract('c', `#include <stdio.h>
#include "local.h"
#define LIMIT 3
#define SQUARE(x) ((x) * (x))
typedef struct { int id; } Node;
typedef char *string_ref;
typedef int (*cmp_fn)(const void *, const void *);
struct Point { double x, y; };
enum Color { RED, GREEN };
union U { int i; float f; };
static int helper(int id) { return id; }
char *label(void) { return "x"; }
int use(struct Point p, char *name) { return helper(p.x) + LIMIT; }
`);
  assert.deepEqual(symbols(out), [
    'macro LIMIT', 'macro SQUARE', 'type Node', 'field id', 'type string_ref', 'type cmp_fn', 'struct Point', 'field x', 'enum Color',
    'struct U', 'field i', 'field f', 'function helper', 'function label', 'function use',
  ]);
  const exported = Object.fromEntries(out.symbols.map((s) => [s.name, s.exported]));
  assert.equal(exported.helper, false, 'static functions are not exported');
  assert.equal(exported.label, true);
  assert.equal(exported.use, true);
  assert.equal(exported.Point, true);
  const label = out.symbols.find((s) => s.name === 'label');
  assert.equal(label.signature, '(void)', 'parameters are read through the pointer declarator');
  assert.deepEqual(out.imports.map((i) => [i.kind, i.spec]), [['include', 'stdio.h'], ['include', 'local.h']]);
  assert.ok(!out.symbols.some((s) => s.name === 'Point' && s.startLine === 18), 'struct Point as a parameter type is a reference, not a definition');
  assert.ok(!out.refs.some((r) => r.kind !== 'call' && ['name', 'RED', 'GREEN', 'i', 'f', 'x'].includes(r.name)), 'parameter, enumerator and member names are not refs');
});

test('C++: class members follow access specifiers, namespace/template/alias symbols, casts are not calls', async () => {
  const out = await extract('cpp', `#include <memory>
namespace geo {
class Shape {
public:
    static int count() { return 0; }
    int area() const;
    /// Perimeter doc.
    int perimeter() const { return 0; }
protected:
    int prot();
private:
    int hidden_;
    static int hidden_static() { return 1; }
};
struct Open { int field; };
void Shape::area() const {}
template <typename T>
T first(const T *xs) { return xs[0]; }
using Index = int;
}  // namespace geo
int run(Shape &s, int *xs) {
    int n = static_cast<int>(3.5);
    auto p = std::make_unique<Shape>();
    return s.perimeter() + first(xs) + n;
}
`);
  const exported = Object.fromEntries(out.symbols.map((s) => [`${s.kind} ${s.name}`, s.exported]));
  assert.equal(exported['method count'], true, 'static member functions are public API, not internal linkage');
  assert.equal(exported['method area'], true);
  assert.equal(exported['method perimeter'], true);
  assert.equal(exported['method prot'], false);
  assert.equal(exported['field hidden_'], false);
  assert.equal(exported['method hidden_static'], false);
  assert.equal(exported['field field'], true, 'struct members are public by default');
  assert.equal(exported['function run'], true);
  const perimeter = out.symbols.find((s) => s.name === 'perimeter');
  assert.equal(perimeter.kind, 'method');
  assert.equal(perimeter.qual, 'geo.Shape.perimeter');
  assert.equal(perimeter.doc, 'Perimeter doc.');
  const first = out.symbols.find((s) => s.name === 'first');
  assert.equal(first.qual, 'geo.first', 'template_declaration is transparent so the function is attributed to the namespace');
  assert.equal(out.symbols.find((s) => s.name === 'Index').kind, 'type');
  assert.equal(out.symbols.find((s) => s.name === 'Shape').kind, 'class');
  assert.equal(out.symbols.find((s) => s.name === 'geo').kind, 'namespace');
  assert.ok(out.symbols.some((s) => s.name === 'area' && s.startLine === 16 && s.qual === 'geo.area'), 'out-of-class definition is named from the qualified declarator');
  assert.deepEqual(calls(out), ['std.make_unique', 's.perimeter', 'first'], 'static_cast<T>() is a cast; make_unique<T>() splits into std + name');
});

test('Objective-C: selectors, message calls with receivers, @import/#import, self is not a ref', async () => {
  const out = await extract('objc', `@import Foundation;
#import "Graph.h"
@interface Node : NSObject <Copying>
@property (nonatomic, strong) NSString *name;
- (instancetype)initWithName:(NSString *)name;
+ (Node *)node;
- (void)link:(Node *)other then:(Node *)another;
@end
@implementation Node
- (instancetype)initWithName:(NSString *)name {
    if (self = [super init]) { _name = [name copy]; }
    return self;
}
- (void)link:(Node *)other then:(Node *)another {
    [[NSNotificationCenter defaultCenter] postNotificationName:@"k" object:other];
}
@end
`);
  const exported = Object.fromEntries(out.symbols.map((s) => [`${s.kind} ${s.name}`, s.exported]));
  assert.equal(exported['class Node'], true);
  assert.equal(exported['property name'], true);
  assert.equal(exported['method link:then:'], true);
  const decl = out.symbols.find((s) => s.name === 'initWithName:' && s.startLine === 5);
  assert.equal(decl.qual, 'Node.initWithName:');
  assert.equal(decl.signature, '(instancetype) initWithName:(NSString *)name');
  assert.equal(out.symbols.find((s) => s.name === 'node').signature, '(Node *) node');
  assert.deepEqual(out.imports.map((i) => [i.kind, i.spec]), [['import', 'Foundation'], ['include', 'Graph.h']]);
  assert.deepEqual(calls(out), ['super.init', 'name.copy', 'NSNotificationCenter.defaultCenter.postNotificationName:object:', 'NSNotificationCenter.defaultCenter']);
  const post = out.refs.find((r) => r.name === 'postNotificationName:object:');
  assert.equal(post.receiver, 'NSNotificationCenter.defaultCenter', 'nested message receivers read as a dotted chain');
  assert.ok(!out.refs.some((r) => r.kind !== 'call' && ['self', 'super'].includes(r.name)));
  assert.ok(!out.refs.some((r) => r.kind !== 'call' && ['nonatomic', 'strong', 'initWithName', 'link', 'then'].includes(r.name)), 'attributes and selector parts are not refs');
});

test('Metal: kernel/vertex/fragment qualifiers and address spaces parse with 0 ERROR via the shim', async () => {
  const sample = fs.readFileSync(path.join(FIXTURES, 'metal', 'sample.metal'), 'utf8');
  const out = await extract('metal', sample, 'sample.metal');
  assert.equal(out.errorNodes, 0);
  assert.equal(out.parseOk, true);
  assert.deepEqual(symbols(out).filter((s) => s.startsWith('function')), ['function vertex_main', 'function fragment_main', 'function add_arrays']);
  assert.ok(out.symbols.filter((s) => s.kind === 'function').every((s) => s.exported === true), 'entry points are exported');
  assert.ok(out.symbols.some((s) => s.kind === 'field' && s.name === 'position' && s.qual === 'VertexIn.position'), '[[attribute]] fields are found');
  assert.deepEqual(calls(out), ['float4', 'float4']);
  // Line/column fidelity: the shim must not shift positions.
  const add = out.symbols.find((s) => s.name === 'add_arrays');
  assert.equal(add.startLine, 29);
  assert.equal(add.endLine, 33);
});

test('CUDA: __global__ kernels and <<<>>> launches parse with 0 ERROR; launches become calls', async () => {
  const sample = fs.readFileSync(path.join(FIXTURES, 'cuda', 'sample.cu'), 'utf8');
  const out = await extract('cuda', sample, 'sample.cu');
  assert.equal(out.errorNodes, 0);
  assert.equal(out.parseOk, true);
  assert.deepEqual(calls(out), ['saxpy', 'fill']);
  const byName = Object.fromEntries(out.symbols.map((s) => [s.name, s]));
  assert.equal(byName.saxpy.exported, true, '__global__ kernels are entry points');
  assert.equal(byName.dot.exported, false, '__device__ helpers are internal');
  assert.equal(byName.saxpy.signature, '(int n, float a, const float *x, float *y)');
  assert.equal(byName.saxpy.startLine, 14);
  const launch = out.refs.find((r) => r.kind === 'call' && r.name === 'saxpy');
  assert.equal(launch.startLine, 26, 'launch call keeps its line');
  const header = await extract('cuda', `#pragma once
__global__ void k(float *x, int n) { x[threadIdx.x] = n; }
__device__ __forceinline__ float helper(float v) { return v * 2.0f; }
struct alignas(16) V { float x, y; };
`, 'k.cuh');
  assert.equal(header.errorNodes, 0);
  assert.deepEqual(symbols(header), ['function k', 'function helper', 'struct V', 'field x']);
  assert.equal(header.symbols.find((s) => s.name === 'helper').exported, false);
});

test('broken fixtures produce ERROR nodes without throwing, for every L3 pack', async () => {
  for (const id of L3) {
    const ext = byId[id].extensions[0];
    const broken = await extract(id, fs.readFileSync(path.join(FIXTURES, id, `broken${ext}`), 'utf8'), `broken${ext}`);
    assert.equal(typeof broken.parseOk, 'boolean', id);
    assert.ok(broken.errorNodes > 0, `${id}: broken${ext} must produce ERROR nodes`);
  }
});

test('no pack lists node types absent from its grammar', () => {
  assert.deepEqual(warnings, []);
});

process.stderr.write = origWrite;

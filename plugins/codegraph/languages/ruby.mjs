// Ruby pack (CONTRACTS.md §5). Node names and fields verified against the bundled
// tree-sitter-ruby wasm with bin/ast.mjs: every call form (with or without parens,
// with or without receiver) is a `call` node; `command`/`command_call` do not exist
// in this grammar build.
const field = (n, f) => n.childForFieldName(f);
const REQUIRES = new Set(['require', 'require_relative']);

// `obj.m`, `obj&.m`, `Foo::m`, `m`, `puts "x"`: the method node is the callee,
// the receiver is kept for display. `proc.()` has no method node (dynamic callee).
function callTarget(node, ctx) {
  const method = field(node, 'method');
  if (!method) return null;
  const receiver = field(node, 'receiver');
  // `def x=(v)` is a setter named `x=`; strip the punctuation so refs match `x`.
  return { name: ctx.text(method).replace(/=$/, ''), receiver: receiver ? ctx.text(receiver) : '' };
}

const isRequire = (node, ctx) => {
  const method = field(node, 'method');
  return !!method && !field(node, 'receiver') && REQUIRES.has(ctx.text(method));
};
// Calls are evaluated before imports by the engine, so require-like calls must opt out.
const isPlainCall = (node, ctx) => !isRequire(node, ctx);

// Only a string literal is a module spec; `require File.join(..)` stays a plain call.
function requireSpec(node, ctx) {
  const first = field(node, 'arguments')?.namedChildren?.[0];
  return first?.type === 'string' ? ctx.text(first).replace(/^["']|["']$/g, '') || null : null;
}

function parameterSignature(node, ctx) {
  const params = field(node, 'parameters');
  return params ? ctx.text(params) : null;
}

// `def x=(v)` and `def [](i)` are stored as `setter`/`operator` nodes; keep `x` as the
// name so references to `x` resolve, while `[]` keeps its punctuation. Rule names
// given as functions are not consumed by the engine, so the name node is consumed here.
function methodName(node, ctx) {
  const name = field(node, 'name');
  if (!name) return null;
  ctx.consume(name);
  return ctx.text(name).replace(/=$/, '') || null;
}

// `class Item` / `class Cart::Item` / `module Cart`: the name is a `constant` or
// `scope_resolution` node that must not double as a reference.
function containerName(node, ctx) {
  const name = field(node, 'name');
  if (!name) return null;
  consumeAll(name, ctx);
  return ctx.text(name) || null;
}

function consumeAll(node, ctx) {
  ctx.consume(node);
  for (const c of node.namedChildren) consumeAll(c, ctx);
}

// Each comment line is its own node; the engine default would keep only the last
// line of a multi-line doc, so collect the whole contiguous block above the owner.
function commentBlock(node, ctx) {
  const lines = [];
  let prev = node.previousNamedSibling;
  let row = node.startPosition.row;
  while (prev && prev.type === 'comment' && row - prev.endPosition.row <= 1) {
    const text = ctx.text(prev).replace(/^#\s?/, '').replace(/^=(?:begin|end)\b/, '').trim();
    if (text) lines.unshift(text);
    row = prev.startPosition.row;
    prev = prev.previousNamedSibling;
  }
  return lines;
}

function docAbove(node, ctx) {
  const lines = commentBlock(node, ctx);
  return lines.length ? lines.join(' ') : null;
}

const documented = (rule) => ({ ...rule, doc: { from: docAbove } });

const spec = {
  id: 'ruby',
  label: 'Ruby',
  extensions: ['.rb'],
  grammar: 'ruby',
  support: 'full',
  scope: 'locals',
  commentTypes: ['comment'],
  definitions: {
    method: documented({ kind: 'method', name: methodName, signature: parameterSignature }),
    singleton_method: documented({ kind: 'method', name: methodName, signature: parameterSignature }),
    class: documented({ kind: 'class', name: containerName }),
    module: documented({ kind: 'module', name: containerName }),
    // `MAX_ITEMS = 10` is module/class-level API; local variables are not indexed.
    assignment: { kind: 'constant', name: 'left', when: (n) => field(n, 'left')?.type === 'constant' },
  },
  calls: [{ node: 'call', fn: callTarget, when: isPlainCall }],
  imports: [{ node: 'call', kind: 'require', when: isRequire, spec: requireSpec }],
  references: [{ node: 'identifier' }, { node: 'constant' }],
  isExported: null,
  hooks: {
    // `_` is the discard variable, never a reference.
    postProcess(out) {
      out.refs = out.refs.filter((r) => !(r.kind === 'ref' && r.name === '_'));
    },
  },
};

export default spec;

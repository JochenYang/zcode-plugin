// PHP pack (CONTRACTS.md §5). Node names and fields verified against the bundled
// tree-sitter-php wasm with bin/ast.mjs.
const field = (n, f) => n.childForFieldName(f);
const text = (n, ctx) => (n ? ctx.text(n) : '');
const stripQuotes = (s) => String(s ?? '').trim().replace(/^["']|["']$/g, '');

// `\App\Foo` / `App\Foo` -> name `Foo`, receiver `App`. The leading backslash is the
// global-namespace marker, not a namespace.
function splitQualified(raw) {
  const parts = String(raw).split('\\').filter(Boolean);
  const name = parts.pop() ?? '';
  return { name, receiver: parts.join('\\') };
}

// `$x` -> `x` (`variable_name` wraps a `name` child); `\ns\Foo` -> `ns\Foo`.
function displayText(node, ctx) {
  if (node.type === 'variable_name') return text(node.namedChildren.find((c) => c.type === 'name'), ctx);
  if (node.type === 'qualified_name') return ctx.text(node).replace(/^\\/, '');
  return ctx.text(node);
}

// Callee of `f()`, `\ns\f()`, `$f()`; null for dynamic callees such as `(expr)()`.
// A bare `name` callee is consumed via `node`; a `qualified_name` must stay a ref so postProcess
// can register the chain and drop its segment refs, after which the chain ref itself is removed
// because it sits at the same position as the call.
function calleeTarget(node, ctx) {
  if (!node) return null;
  if (node.type === 'qualified_name') return splitQualified(ctx.text(node));
  if (node.type === 'name' || node.type === 'variable_name') {
    return { name: displayText(node, ctx), receiver: '', node: node.namedChildren.find((c) => c.type === 'name') ?? node };
  }
  return null;
}

// `node` is the callee name node so the engine consumes it (otherwise `format()` would be both a call and a ref).
function memberTarget(node, ctx) {
  const name = field(node, 'name');
  const object = field(node, 'object');
  return name && object ? { name: ctx.text(name), receiver: displayText(object, ctx), node: name } : null;
}

function scopedTarget(node, ctx) {
  const name = field(node, 'name');
  const scope = field(node, 'scope');
  return name && scope ? { name: ctx.text(name), receiver: displayText(scope, ctx), node: name } : null;
}

// `new Foo(..)`, `new \ns\Foo(..)`, `new $cls(..)`; `new class {..}` has no name child.
function creationTarget(node, ctx) {
  const target = node.namedChildren.find((c) => ['name', 'qualified_name', 'variable_name'].includes(c.type));
  return target ? calleeTarget(target, ctx) : null;
}

// PHP splits `A\B\C` into `name` segments. Where the whole chain is already accounted
// for (namespace declaration, use statement) the segments must not double as refs.
function consumeNameSegments(node, ctx) {
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (n.type === 'name') ctx.consume(n);
    else for (const c of n.namedChildren) stack.push(c);
  }
}

const CLAUSE_TYPES = new Set(['name', 'qualified_name', 'namespace_name']);

// `use A\B;`, `use A\B as C;`, `use function f;`, `use A\{B, C as D};` -> one entry per target.
function useNames(node, ctx) {
  const out = [];
  const clause = (c) => {
    const target = c.namedChildren.find((t) => CLAUSE_TYPES.has(t.type));
    if (!target) return;
    const alias = c.namedChildren.find((t) => t.type === 'namespace_aliasing_clause');
    const imported = splitQualified(ctx.text(target)).name;
    out.push({ imported, alias: alias ? text(alias.namedChildren[0], ctx) : imported });
  };
  for (const c of node.namedChildren) {
    if (c.type === 'namespace_use_clause') clause(c);
    else if (c.type === 'namespace_use_group') for (const g of c.namedChildren) if (g.type === 'namespace_use_group_clause') clause(g);
  }
  consumeNameSegments(node, ctx);
  return out.length ? out : null;
}

// The full path of the first target; a group use keeps its prefix.
function useSpec(node, ctx) {
  const first = node.namedChildren.find((c) => c.type === 'namespace_use_clause' || c.type === 'namespace_name');
  if (!first) return null;
  if (first.type === 'namespace_name') return ctx.text(first) || null;
  const target = first.namedChildren.find((t) => CLAUSE_TYPES.has(t.type));
  return target ? ctx.text(target).replace(/^\\/, '') || null : null;
}

// `require __DIR__ . '/boot.php'`: the first string literal is the best textual spec.
function firstString(node, ctx) {
  const stack = [node];
  while (stack.length) {
    const n = stack.shift();
    if (n.type === 'string') return stripQuotes(ctx.text(n)) || null;
    for (const c of n.namedChildren) stack.push(c);
  }
  return null;
}

function namespaceName(node, ctx) {
  const name = field(node, 'name');
  if (!name) return null;
  consumeNameSegments(name, ctx);
  return ctx.text(name) || null;
}

function propertyName(node, ctx) {
  const variable = node.namedChildren.find((c) => c.type === 'variable_name');
  const name = variable?.namedChildren.find((c) => c.type === 'name');
  if (!name) return null;
  ctx.consume(name);
  return ctx.text(name) || null;
}

// `(Invoice $invoice): float` — the return type is a separate field without its colon.
function signatureOf(node, ctx) {
  const params = text(field(node, 'parameters'), ctx);
  const ret = text(field(node, 'return_type'), ctx);
  return [params, ret ? `: ${ret}` : ''].join('');
}

// `const A = 1, B = 2;`: each element is one constant; `name` is an unlabelled child.
// Rule names given as functions are not consumed by the engine, so do it here.
const constElementName = (node, ctx) => {
  const name = node.namedChildren.find((c) => c.type === 'name');
  if (!name) return null;
  ctx.consume(name);
  return ctx.text(name) || null;
};

const posKey = (line, col) => line * 1e6 + col;

const spec = {
  id: 'php',
  label: 'PHP',
  extensions: ['.php'],
  grammar: 'php',
  support: 'full',
  commentTypes: ['comment'],
  definitions: {
    function_definition: { kind: 'function', name: 'name', signature: signatureOf },
    method_declaration: { kind: 'method', name: 'name', signature: signatureOf },
    class_declaration: { kind: 'class', name: 'name' },
    interface_declaration: { kind: 'interface', name: 'name' },
    trait_declaration: { kind: 'trait', name: 'name' },
    enum_declaration: { kind: 'enum', name: 'name' },
    const_element: { kind: 'constant', name: constElementName },
    property_element: { kind: 'field', name: propertyName },
    namespace_definition: { kind: 'namespace', name: namespaceName },
  },
  calls: [
    { node: 'function_call_expression', fn: (n, ctx) => calleeTarget(field(n, 'function'), ctx) },
    { node: 'member_call_expression', fn: memberTarget },
    { node: 'nullsafe_member_call_expression', fn: memberTarget },
    { node: 'scoped_call_expression', fn: scopedTarget },
    { node: 'object_creation_expression', fn: creationTarget },
  ],
  imports: [
    { node: 'namespace_use_declaration', kind: 'use', spec: useSpec, names: useNames },
    { node: 'require_expression', kind: 'require', spec: firstString },
    { node: 'require_once_expression', kind: 'require_once', spec: firstString },
    { node: 'include_expression', kind: 'include', spec: firstString },
    { node: 'include_once_expression', kind: 'include_once', spec: firstString },
  ],
  // `name` covers plain identifiers (incl. `$var` inner names); `qualified_name` is the
  // backslash chain, which postProcess rewrites to last segment + receiver.
  references: [{ node: 'qualified_name' }, { node: 'name' }],
  isExported: null,
  hooks: {
    postProcess(out) {
      const chains = new Set();
      const spans = [];
      for (const r of out.refs) {
        if (r.kind !== 'ref' || !r.name.includes('\\')) continue;
        // refs carry no endCol; a qualified name never spans lines, so its length is the span.
        const end = posKey(r.startLine, r.startCol + r.name.length);
        const { name, receiver } = splitQualified(r.name);
        r.name = name;
        r.receiver = receiver;
        chains.add(r);
        spans.push([posKey(r.startLine, r.startCol), end]);
      }
      // `$this` is never a symbol; segment `name`s inside a qualified chain are not refs either.
      // A chain ref that is itself the callee (`\App\money()`) duplicates the call row; a chain that is
      // only the receiver (`\App\Foo::bar()`) stays, so match on position AND name.
      const callKeys = new Set(out.refs.filter((r) => r.kind === 'call').map((r) => `${posKey(r.startLine, r.startCol)}:${r.name}`));
      out.refs = out.refs.filter((r) => {
        if (chains.has(r)) return !callKeys.has(`${posKey(r.startLine, r.startCol)}:${r.name}`);
        if (r.kind === 'ref' && r.name === 'this' && r.receiver === '') return false;
        if (!spans.length || r.kind === 'call') return true;
        // The first segment starts where the chain starts, hence the inclusive bound.
        const p = posKey(r.startLine, r.startCol);
        return !spans.some(([s, e]) => p >= s && p < e);
      });
    },
  },
};

export default spec;

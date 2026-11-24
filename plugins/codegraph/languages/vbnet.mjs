// Language pack id must equal the file name (registry.mjs). See CONTRACTS.md §5.
//
// tree-sitter-vbnet notes (checked with bin/ast.mjs):
// - Field names exist: `name`, `parameters`, `namespace`, `alias`, `function`, `object`, `member`, `type`.
// - The last `Imports` statement swallows a trailing comment, so the first `''' <summary>` doc in a file
//   hides inside `imports_statement`; `vbDoc` below looks there as well as at the previous sibling.
// - Docs are `''' <summary>...</summary>` comments: the engine's generic stripper leaves the quotes and
//   XML tags, so `stripDoc` normalises them instead of using the default `prevSiblingComment` rule.
// - `x = New Foo(1)` is parsed as `array_creation_expression` (bounds) instead of an object creation;
//   without a `{ ... }` initializer and with a non-predefined type it is treated as a constructor call.

const consumeAll = (node, ctx, types) => {
  if (!node) return;
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (types.includes(n.type)) ctx.consume(n);
    for (const c of n.namedChildren) stack.push(c);
  }
};

const modifiersOf = (node) => (node?.namedChildren ?? []).filter((c) => c.type === 'member_modifier').map((c) => c.text);
const hasModifier = (node, word) => modifiersOf(node).includes(word);

// `Public`, `Friend` (assembly-wide) or `Protected` members are visible outside the type, unless `Private`.
function isExported(node) {
  if (node.type === 'enum_member_declaration') {
    const owner = node.parent?.type === 'enum_declaration' ? node.parent : node.parent?.parent;
    return owner ? isExported(owner) : false;
  }
  const mods = modifiersOf(node);
  if (mods.includes('Private')) return false;
  return mods.some((m) => m === 'Public' || m === 'Friend' || m === 'Protected');
}

// Dotted / generic names: the declaration's symbol name is the head identifier; the rest must not leak as refs.
function declName(node, ctx) {
  const n = node.childForFieldName('name');
  if (!n) return null;
  if (n.type === 'simple_name' || n.type === 'generic_name' || n.type === 'qualified_name') consumeAll(n, ctx, ['identifier']);
  return n;
}

// `Dim a As Integer = 1, b` / `Public Const X As Integer = 1`: first declarator's name.
function fieldName(node, ctx) {
  const declarator = node.namedChildren.find((c) => c.type === 'variable_declarator');
  const name = declarator?.childForFieldName('name') ?? null;
  if (name) ctx.consume(name);
  return name;
}

const fieldKind = (node) => (hasModifier(node, 'Const') ? 'constant' : 'field');

// `Function f(a As T) As R` -> `(a As T) As R`; `Sub`/constructors -> parameter list only.
function signature(node, ctx) {
  const params = node.childForFieldName('parameters');
  const ret = node.namedChildren.find((c) => c.type === 'as_clause');
  const parts = [ctx.text(params), ret ? `As ${ctx.text(ret.childForFieldName('declared_type'))}` : ''];
  return parts.filter(Boolean).join(' ');
}

const stripDoc = (text) =>
  String(text ?? '')
    .replace(/^'''+/gm, '')
    .replace(/^'/gm, '')
    .replace(/<\/?(summary|para|remarks|returns|value|exception)\b[^>]*>/g, ' ')
    .trim() // a swallowed comment starts with the preceding line breaks; trim before cutting at a blank line
    .split(/\n\s*\n/)[0]
    .replace(/\s+/g, ' ')
    .trim();

// Previous-sibling comment (the engine's rule), plus two grammar quirks: a comment after the last
// `Imports` is swallowed by it, and the blank line after a comment becomes an `empty_statement` sibling.
function vbDoc(node, ctx) {
  let prev = node.previousNamedSibling ?? node.previousSibling;
  while (prev?.type === 'empty_statement') prev = prev.previousNamedSibling ?? prev.previousSibling;
  if (prev?.type === 'imports_statement') {
    const tail = prev.namedChildren[prev.namedChildren.length - 1];
    if (tail?.type === 'comment') prev = tail;
  }
  if (!prev || prev.type !== 'comment') return null;
  if (node.startPosition.row - prev.endPosition.row > 2) return null;
  return stripDoc(prev.text);
}

// `Imports A.B.C` -> spec `A.B.C` (every member in scope); `Imports A = B.C` -> alias A.
const importSpec = (node, ctx) => ctx.text(node.childForFieldName('namespace'));

function importNames(node) {
  const alias = node.childForFieldName('alias');
  return [{ imported: '*', alias: alias?.text ?? '*' }];
}

// `obj.m(...)` -> name `m`, receiver `obj`; `Me.New(...)` / `MyBase.New()` -> `this` / `super`.
function invoked(node, ctx) {
  const fn = node.childForFieldName('function');
  if (!fn) return null;
  if (fn.type === 'member_access_expression') return memberCall(fn, ctx);
  if (fn.type === 'identifier') ctx.consume(fn);
  return ctx.text(fn);
}

function memberCall(fn, ctx) {
  const member = fn.childForFieldName('member');
  const object = fn.childForFieldName('object');
  if (member) ctx.consume(member); // the call ref already represents the name
  if (member?.text === 'New') return { name: object?.type === 'mybase_expression' ? 'super' : 'this', receiver: '' };
  return { name: ctx.text(member), receiver: ctx.text(object) };
}

// A receiver spelled with a type-like (uppercase) name makes the grammar prefer array indexing over a
// method call: `Math.Round(x)`, `Console.WriteLine(y)` and `Me.New(0)` all parse as
// `array_access_expression(array: member_access_expression, indices: ...)` -> treat as calls.
const methodCallMisparse = (node) => node.childForFieldName('array')?.type === 'member_access_expression';

// `New Foo(...)` / `New Foo(Of Bar)(...)` -> `Foo`; `New Foo() { }` (array_type) is an array, not a call.
function createdType(node, ctx) {
  let type = node.childForFieldName('type');
  if (type?.type === 'generic_name') type = type.childForFieldName('name') ?? type;
  if (type?.type === 'simple_name') type = type.namedChildren[0] ?? type;
  if (!type || type.type !== 'identifier') return null;
  ctx.consume(type); // one ref per site: the call, not a duplicate type ref
  return ctx.text(type);
}

// Object creation misparsed as array bounds: no `{ }` initializer and a user-defined (non-predefined) type.
const isArrayCreation = (node) => {
  const type = node.childForFieldName('type');
  return !node.childForFieldName('initializer') && (type?.type === 'simple_name' || type?.type === 'generic_name');
};

const DOC = { from: vbDoc };

// Declaration-only names: parameters, lambda parameters, locals, loop variables.
const skipPatterns = [
  '(parameter name: (identifier) @skip)',
  '(lambda_parameter name: (identifier) @skip)',
  '(variable_declarator name: (identifier) @skip)',
  '(for_each_statement variable: (identifier) @skip)',
];

// Statements carry their line terminator, so a node that ends at column 0 really ends on the previous
// line. endCol becomes that line's length so refs on the closing line still fall inside the symbol.
function trimLineTerminators(out, ctx) {
  for (const s of out.symbols) {
    if (s.endCol !== 0 || s.endLine <= s.startLine) continue;
    s.endLine -= 1;
    s.endCol = (ctx.lines[s.endLine - 1 - ctx.lineOffset] ?? '').length;
  }
}

export default {
  id: 'vbnet',
  label: 'VB.NET',
  extensions: ['.vb'],
  grammar: 'vbnet',
  support: 'full',
  commentTypes: ['comment'],
  transparentAncestors: [],
  definitions: {
    namespace_declaration: { kind: 'namespace', name: declName, doc: DOC },
    class_declaration: { kind: 'class', name: declName, doc: DOC },
    structure_declaration: { kind: 'struct', name: declName, doc: DOC },
    interface_declaration: { kind: 'interface', name: declName, doc: DOC },
    module_declaration: { kind: 'module', name: declName, doc: DOC },
    enum_declaration: { kind: 'enum', name: declName, doc: DOC },
    enum_member_declaration: { kind: 'constant', name: declName },
    delegate_declaration: { kind: 'type', name: declName, signature, doc: DOC },
    method_declaration: { kind: 'method', name: declName, signature, doc: DOC },
    interface_method_declaration: { kind: 'method', name: declName, signature, doc: DOC },
    constructor_declaration: { kind: 'method', name: () => 'New', signature: (node, ctx) => ctx.text(node.childForFieldName('parameters')) },
    property_declaration: { kind: 'property', name: declName, doc: DOC },
    event_declaration: { kind: 'field', name: declName, doc: DOC },
    field_declaration: { kind: fieldKind, name: fieldName, doc: DOC },
  },
  calls: [
    { node: 'invocation_expression', fn: invoked },
    { node: 'array_access_expression', when: methodCallMisparse, fn: (node, ctx) => memberCall(node.childForFieldName('array'), ctx) },
    { node: 'object_creation_expression', fn: createdType },
    { node: 'array_creation_expression', when: isArrayCreation, fn: createdType },
    { node: 'raiseevent_statement', fn: (node) => node.childForFieldName('event')?.text ?? null },
  ],
  imports: [{ node: 'imports_statement', kind: 'import', spec: importSpec, names: importNames }],
  references: [{ node: 'identifier' }],
  skipPatterns,
  isExported,
  embeddings: [],
  hooks: { postProcess: trimLineTerminators },
};

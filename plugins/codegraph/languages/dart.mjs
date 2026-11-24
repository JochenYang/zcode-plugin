// Language pack id must equal the file name (registry.mjs). See CONTRACTS.md §5.
//
// tree-sitter-dart (UserNobody14) notes (checked with bin/ast.mjs):
// - Members are `function_signature` / `getter_signature` / ... / `*_constructor_signature`, wrapped
//   in `method_signature` or `declaration`; the body is a SIBLING `function_body`, so symbol ranges are
//   extended over it in postProcess (otherwise refs inside the body belong to no symbol).
// - Method calls are flat sibling chains: `items.map(f).join(s)` = identifier, selector(.map),
//   selector(args), selector(.join), selector(args). Every `selector` with an `argument_part` is one
//   call; the callee is the sibling right before it.
// - Top-level variables are `static_final_declaration` directly under `program`; fields sit in
//   `declaration`. `mixin_declaration` has no name field (name = `mixin` keyword + identifier).
// - Docs are `documentation_comment` nodes.

const child = (node, type) => (node ? node.namedChildren.find((c) => c.type === type) ?? null : null);
const lastIdentifier = (node) => node.namedChildren.filter((c) => c.type === 'identifier').pop() ?? null;

// Name functions consume the name node so it is not also reported as a bare reference.
function consume(ctx, node) {
  if (node) ctx.consume(node);
  return node;
}

// `class Foo` -> `Foo` (name field); `mixin Foo` / `extension Foo on Bar` -> first identifier.
const typeName = (node, ctx) => consume(ctx, node.childForFieldName('name') ?? child(node, 'identifier'));

// `Money(...)`, `const Money(...)`, `Money.named(...)`, `factory Money.fromUnits(...)`: the last
// identifier before the parameter list is the constructor name.
function constructorName(node, ctx) {
  const params = child(node, 'formal_parameter_list');
  const before = params ? node.namedChildren.slice(0, node.namedChildren.indexOf(params)) : node.namedChildren;
  return consume(ctx, before.filter((c) => c.type === 'identifier').pop() ?? null);
}

function operatorName(node, ctx) {
  const op = child(node, 'binary_operator') ?? child(node, 'unary_operator') ?? child(node, 'unary_prefix_operator') ?? child(node, 'unary_postfix_operator');
  return op ? `operator ${op.text}` : null;
}

// Signatures and bodies are siblings: remember where the body (plus initializer/redirection clauses)
// ends so postProcess can extend the symbol range (otherwise refs inside the body belong to no symbol).
const TAIL = new Set(['function_body', 'redirection', 'initializers']);

function rememberBody(node, ctx) {
  let owner = node;
  while (owner.parent && (owner.parent.type === 'method_signature' || owner.parent.type === 'declaration')) owner = owner.parent;
  let tail = owner.nextNamedSibling;
  if (!tail || !TAIL.has(tail.type)) return;
  while (tail.nextNamedSibling && TAIL.has(tail.nextNamedSibling.type)) tail = tail.nextNamedSibling;
  const bodies = (ctx.dartBodies ??= new Map());
  bodies.set(`${node.startPosition.row}:${node.startPosition.column}`, tail.endPosition);
}

const withBody = (nameFn) => (node, ctx) => {
  rememberBody(node, ctx);
  return nameFn(node, ctx);
};

const signatureName = withBody((node, ctx) => consume(ctx, node.childForFieldName('name') ?? lastIdentifier(node)));
const ctorName = withBody(constructorName);
const opName = withBody(operatorName);

// `const`/`final`/`var` + type precede the declaration list; the keyword decides constant vs variable.
function variableKind(node, ctx) {
  const list = node.parent;
  const owner = list?.parent;
  let keyword = null;
  if (owner?.type === 'declaration') {
    keyword = owner.namedChildren.find((c) => c.type === 'const_builtin' || c.type === 'final_builtin')?.type;
  } else if (list && owner) {
    let s = list.previousNamedSibling;
    for (let i = 0; s && i < 3; i++, s = s.previousNamedSibling) {
      if (s.type === 'const_builtin' || s.type === 'final_builtin') { keyword = s.type; break; }
    }
  }
  return keyword === 'const_builtin' || keyword === 'final_builtin' ? 'constant' : 'variable';
}

// `const Money(0, 'USD')` -> `Money`; `new Base.create()` -> receiver `Base`, name `create`.
function constructorCall(node, ctx) {
  const type = child(node, 'type_identifier');
  if (type) ctx.consume(type); // one ref per site: the call, not a duplicate type ref
  const named = child(node, 'identifier');
  if (named) ctx.consume(named);
  if (node.type === 'new_expression' && named) return { name: named.text, receiver: ctx.text(type) };
  return ctx.text(type) || ctx.text(named);
}

const CHAIN = new Set(['identifier', 'selector', 'parenthesized_expression', 'const_object_expression', 'new_expression']);

// `obj.name(args)` -> `{ name, receiver }`; callee is the sibling before the `argument_part` selector.
function selectorCall(node, ctx) {
  const prev = node.previousNamedSibling;
  if (!prev) return null;
  let name;
  let nameNode = null;
  let anchor = prev;
  if (prev.type === 'identifier') {
    name = prev.text;
    nameNode = prev;
  } else if (prev.type === 'selector') {
    const target = prev.namedChildren.find((c) => c.type === 'unconditional_assignable_selector' || c.type === 'conditional_assignable_selector');
    nameNode = child(target, 'identifier');
    if (!nameNode) return null; // `f(1)(2)`: calling the result of a call; no static name
    name = nameNode.text;
  } else {
    return null;
  }
  ctx.consume(nameNode); // the call ref already represents the name
  const parts = [];
  // Walk back over the receiver chain, but never past the variable being initialised (`x = a.b()`).
  for (let s = anchor.previousNamedSibling; s && CHAIN.has(s.type) && s.id !== s.parent?.childForFieldName('name')?.id; s = s.previousNamedSibling) parts.unshift(s.text);
  return { name, receiver: parts.join('') };
}

const hasArgumentPart = (node) => node.namedChildren.some((c) => c.type === 'argument_part');

// `Foo() : this.named()` / `Sub() : super()` in initializer lists.
function redirection(node, ctx) {
  const target = node.namedChildren.find((c) => c.type === 'this' || c.type === 'super');
  const name = child(node, 'identifier');
  if (name) ctx.consume(name);
  if (!target) return null;
  return name ? { name: name.text, receiver: target.type === 'super' ? 'super' : 'this' } : { name: target.type === 'super' ? 'super' : 'this', receiver: '' };
}

const uriText = (node, ctx) => {
  const uri = node.namedChildren.find((c) => c.type === 'configurable_uri') ?? node.namedChildren.find((c) => c.type === 'uri');
  return ctx.text(child(child(uri, 'uri'), 'string_literal') ?? child(uri, 'string_literal')).replace(/^['"]|['"]$/g, '');
};

// `import 'uri' as a show x hide y;` -> spec = uri; alias / `show` list become the imported names,
// a `hide` combinator keeps the wildcard (everything but the hidden names).
function importNames(node) {
  const alias = child(node, 'identifier')?.text ?? null;
  const combinators = node.namedChildren.filter((c) => c.type === 'combinator');
  const shown = combinators.filter((c) => c.children[0]?.type === 'show').flatMap((c) => c.namedChildren.filter((s) => s.type === 'identifier'));
  if (shown.length) return shown.map((s) => ({ imported: s.text, alias: s.text }));
  if (alias || combinators.length) return [{ imported: '*', alias: alias ?? '*' }];
  return null;
}

// Declaration-only names: parameters, lambda parameters, locals, loop/catch/pattern variables, type params.
const skipPatterns = [
  '(formal_parameter (identifier) @skip)',
  '(constructor_param (identifier) @skip)',
  '(super_formal_parameter (identifier) @skip)',
  '(initialized_variable_definition name: (identifier) @skip)',
  '(static_final_declaration (identifier) @skip)',
  '(initialized_identifier (identifier) @skip)',
  '(type_parameter (type_identifier) @skip)',
  '(typed_identifier (identifier) @skip)',
  '(catch_parameters (identifier) @skip)',
  '(for_loop_parts name: (identifier) @skip)',
  '(variable_pattern (identifier) @skip)',
  '(named_argument (label (identifier) @skip))',
  '(representation_declaration name: (identifier) @skip)',
];

const SIGNATURE = ['formal_parameter_list'];

export default {
  id: 'dart',
  label: 'Dart',
  extensions: ['.dart'],
  grammar: 'dart',
  support: 'full',
  commentTypes: ['comment', 'line_comment', 'block_comment', 'documentation_comment'],
  // Doc comments sit next to the wrapper (`declaration` / `method_signature`), not the signature itself.
  transparentAncestors: ['method_signature', 'declaration'],
  definitions: {
    class_definition: { kind: 'class', name: typeName },
    extension_declaration: { kind: 'trait', name: typeName },
    mixin_declaration: { kind: 'trait', name: typeName },
    enum_declaration: { kind: 'enum', name: typeName },
    enum_constant: { kind: 'constant', name: typeName },
    type_alias: { kind: 'type', name: (node, ctx) => consume(ctx, child(node, 'type_identifier')) },
    function_signature: { kind: 'function', name: signatureName, signature: SIGNATURE, when: (node) => node.parent?.type !== 'lambda_expression' },
    getter_signature: { kind: 'method', name: signatureName },
    setter_signature: { kind: 'method', name: signatureName, signature: SIGNATURE },
    operator_signature: { kind: 'method', name: opName, signature: SIGNATURE },
    constructor_signature: { kind: 'method', name: ctorName, signature: SIGNATURE },
    constant_constructor_signature: { kind: 'method', name: ctorName, signature: SIGNATURE },
    factory_constructor_signature: { kind: 'method', name: ctorName, signature: SIGNATURE },
    redirecting_factory_constructor_signature: { kind: 'method', name: ctorName, signature: SIGNATURE },
    static_final_declaration: { kind: variableKind, name: (node, ctx) => consume(ctx, child(node, 'identifier')) },
    initialized_identifier: { kind: 'field', name: (node, ctx) => consume(ctx, child(node, 'identifier')) },
  },
  calls: [
    { node: 'selector', when: hasArgumentPart, fn: selectorCall },
    { node: 'const_object_expression', fn: constructorCall },
    { node: 'new_expression', fn: constructorCall },
    { node: 'constructor_invocation', fn: (node) => node.namedChildren.find((c) => c.type === 'super' || c === node.childForFieldName('constructor'))?.text ?? null },
    { node: 'redirection', fn: redirection },
  ],
  imports: [
    { node: 'import_specification', kind: 'import', spec: uriText, names: importNames },
    { node: 'library_export', kind: 'reexport', spec: uriText },
  ],
  references: [{ node: 'identifier' }, { node: 'type_identifier', kind: 'type' }, { node: 'identifier_dollar_escaped' }],
  skipPatterns,
  isExported: (node, sym) => !sym.name.startsWith('_'), // Dart privacy: a leading underscore is library-private
  embeddings: [],
  hooks: { postProcess },
};

// Signatures and bodies are siblings: extend each function symbol over its body so containment works.
// `///` docs are stripped by the engine as `//` (leaving a stray `/`), so trim that here.
function postProcess(out, ctx) {
  for (const s of out.symbols) {
    if (typeof s.doc === 'string') s.doc = s.doc.replace(/^\/\s*/, '').trim() || null;
    const end = ctx.dartBodies?.get(`${s.startLine - ctx.lineOffset - 1}:${s.startCol}`);
    if (!end) continue;
    s.endLine = (end.column > 0 ? end.row + 1 : end.row) + ctx.lineOffset;
    s.endCol = end.column;
  }
}

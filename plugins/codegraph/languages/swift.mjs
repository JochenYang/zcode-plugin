// Language pack id must equal the file name (registry.mjs). See CONTRACTS.md §5.
//
// tree-sitter-swift (codegraph build) notes (checked with bin/ast.mjs):
// - `class`, `struct`, `enum`, `actor` and `extension` are all `class_declaration`; `declaration_kind`
//   says which. Protocol members are `protocol_function_declaration` / `protocol_property_declaration`.
// - Function parameters are direct `parameter` children (no `value_parameters` wrapper) and the return
//   type is a bare type node after them; `function_declaration` has two `name` fields (function name
//   first, then the return type) so the field path `name` yields the function name.
// - `a.b()`: `call_expression` > callee + `call_suffix`; the callee is `simple_identifier` or
//   `navigation_expression(target, navigation_suffix(suffix: simple_identifier))`.
// - Bound names (`let x`, `for i in`, `catch let e`, `if let y`) all use `pattern bound_identifier: ...`.

const child = (node, type) => (node ? node.namedChildren.find((c) => c.type === type) ?? null : null);
const consume = (ctx, node) => {
  if (node) ctx.consume(node);
  return node;
};

const modifiersOf = (node) => child(node, 'modifiers')?.namedChildren ?? [];

// `public` / `open` are the only modifiers that cross the module boundary (internal is the default).
function isExported(node) {
  if (node.type === 'enum_entry') return isExported(node.parent?.parent ?? node);
  return modifiersOf(node).some((m) => m.type === 'visibility_modifier' && /^(public|open)\b/.test(m.text));
}

const declarationKinds = { class: 'class', struct: 'struct', enum: 'enum', actor: 'class', extension: 'trait', protocol: 'interface' };

const typeKind = (node) => declarationKinds[node.childForFieldName('declaration_kind')?.text] ?? 'class';

// `case a, b` yields one enum_entry with several `name` fields; the first is the symbol. Operators
// (`func <`) name the operator token, which is anonymous, so only named nodes are consumed.
function typeName(node, ctx) {
  const n = node.childForFieldName('name');
  if (!n) return null;
  if (!n.isNamed) return n.text;
  ctx.consume(n);
  return n;
}

// `let x: T` / `var x: T` keep the name in `pattern` > `bound_identifier`.
const bindingName = (node, ctx) => consume(ctx, node.childForFieldName('name')?.childForFieldName('bound_identifier'));

// Declaration-level `let`/`var`: top level -> constant/variable, inside a type -> property; locals are skipped.
const TYPE_BODIES = new Set(['class_body', 'enum_class_body', 'protocol_body']);

function propertyRule(node) {
  if (node.parent?.type === 'source_file') return true;
  return TYPE_BODIES.has(node.parent?.type);
}

function propertyKind(node) {
  if (node.parent?.type !== 'source_file') return 'property';
  return child(node, 'value_binding_pattern')?.childForFieldName('mutability')?.text === 'let' ? 'constant' : 'variable';
}

// `function_declaration` kind: a member of a type is a method, a free function stays a function.
const memberKinds = new Set(['class_body', 'enum_class_body', 'protocol_body', 'extension_body']);
const functionKind = (node) => (memberKinds.has(node.parent?.type) ? 'method' : 'function');

const TYPE_NODES = new Set(['user_type', 'array_type', 'dictionary_type', 'tuple_type', 'optional_type', 'function_type', 'metatype', 'opaque_type', 'existential_type', 'protocol_composition_type', 'bracket_qualified_type']);

// `(a: Int, b: String) -> Bool`: parameter nodes are direct children, the return type is the type node
// that follows them (default values are bare siblings, hence the type check).
function signature(node, ctx) {
  const children = node.namedChildren;
  const lastParam = children.map((c) => c.type).lastIndexOf('parameter');
  const params = children.filter((c) => c.type === 'parameter').map((p) => ctx.text(p));
  const ret = children.slice(lastParam + 1).find((c) => TYPE_NODES.has(c.type));
  return `(${params.join(', ')})${ret ? ` -> ${ctx.text(ret)}` : ''}`;
}

// Callee -> `{ name, receiver }`. Subscripts (`jobs[i]`) share the `call_expression` node with a `[`
// call_suffix and are not calls; `a * Double(x)` parses as `(a * Double)(x)`, so a non-identifier
// callee contributes its last identifier (`Double`) instead of the whole expression text.
function callee(node, ctx) {
  const suffix = node.namedChildren.find((c) => c.type === 'call_suffix');
  if (suffix?.text.startsWith('[')) return null;
  const target = node.namedChildren.find((c) => c.type !== 'call_suffix');
  if (!target) return null;
  if (target.type === 'simple_identifier') {
    consume(ctx, target); // the call ref already represents the name
    return { name: target.text, receiver: '' };
  }
  if (target.type === 'navigation_expression') {
    const name = child(child(target, 'navigation_suffix'), 'simple_identifier');
    if (name) ctx.consume(name);
    const receiver = ctx.text(target.childForFieldName('target'));
    return { name: ctx.text(name), receiver: receiver.replace(/\?+$/, '') };
  }
  const last = lastIdentifier(target);
  if (!last) return null;
  ctx.consume(last);
  return { name: last.text, receiver: '' };
}

function lastIdentifier(node) {
  for (let i = node.namedChildren.length - 1; i >= 0; i--) {
    const c = node.namedChildren[i];
    if (c.type === 'simple_identifier') return c;
    const inner = lastIdentifier(c);
    if (inner) return inner;
  }
  return null;
}

// `import Foundation` -> the whole module; `import class Foundation.NSString` -> one member.
const importPath = (node) => node.namedChildren.find((c) => c.type === 'identifier')?.text ?? '';

function importNames(node) {
  const specifier = node.namedChildren.find((c) => c.type === 'import_specifier');
  if (!specifier) return [{ imported: '*', alias: '*' }];
  const last = importPath(node).split('.').pop();
  return last ? [{ imported: last, alias: last }] : null;
}

// Bound and declared names are not uses: parameters, argument labels, closures, type parameters,
// `let`/`for`/`catch`/`if let` patterns, and the extra names of `case a, b`.
const skipPatterns = [
  '(parameter name: (simple_identifier) @skip)',
  '(parameter external_name: (simple_identifier) @skip)',
  '(value_argument name: (value_argument_label (simple_identifier) @skip))',
  '(lambda_parameter name: (simple_identifier) @skip)',
  '(type_parameter name: (user_type (type_identifier) @skip))',
  '(pattern bound_identifier: (simple_identifier) @skip)',
  '(enum_entry name: (simple_identifier) @skip)',
  '(associatedtype_declaration name: (type_identifier) @skip)',
];

export default {
  id: 'swift',
  label: 'Swift',
  extensions: ['.swift'],
  grammar: 'swift',
  support: 'full',
  commentTypes: ['comment', 'multiline_comment'],
  transparentAncestors: [],
  definitions: {
    class_declaration: { kind: typeKind, name: typeName },
    protocol_declaration: { kind: 'interface', name: typeName },
    typealias_declaration: { kind: 'type', name: typeName },
    associatedtype_declaration: { kind: 'type', name: typeName },
    function_declaration: { kind: functionKind, name: typeName, signature },
    protocol_function_declaration: { kind: 'method', name: typeName, signature },
    init_declaration: { kind: 'method', name: () => 'init', signature },
    deinit_declaration: { kind: 'method', name: () => 'deinit' },
    subscript_declaration: { kind: 'method', name: () => 'subscript' },
    enum_entry: { kind: 'constant', name: typeName },
    property_declaration: { kind: propertyKind, name: bindingName, when: propertyRule },
    protocol_property_declaration: { kind: 'property', name: bindingName },
  },
  calls: [{ node: 'call_expression', fn: callee }],
  imports: [{ node: 'import_declaration', kind: 'import', spec: importPath, names: importNames }],
  references: [{ node: 'simple_identifier' }, { node: 'type_identifier', kind: 'type' }],
  skipPatterns,
  isExported,
  embeddings: [],
  // `///` docs are stripped by the engine as `//` (leaving a stray `/`); trim that once per symbol.
  hooks: { postProcess: (out) => {
    for (const s of out.symbols) if (typeof s.doc === 'string') s.doc = s.doc.replace(/^\/\s*/, '').trim() || null;
  } },
};

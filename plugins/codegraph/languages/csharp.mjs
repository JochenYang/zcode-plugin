// Language pack id must equal the file name (registry.mjs). See CONTRACTS.md §5.
//
// tree-sitter-c-sharp 0.20 notes (checked with bin/ast.mjs):
// - Plain names are `identifier` (no `identifier_name` node in this grammar version); types with
//   arguments are `generic_name` > `identifier`. Type names in declarations sit in the `name` field.
// - `field_declaration` / `event_field_declaration` have no declarator field: the name is
//   `variable_declaration > variable_declarator > identifier` (first declarator only).
// - `a.b()`: `invocation_expression` > `function: member_access_expression(expression, name)`;
//   `a?.b()`: `function: conditional_access_expression` > `member_binding_expression(name)`.
// - `using X;`, `using static X;` and `using A = X.Y;` are all `using_directive` (text tells them apart).

const consumeAll = (node, ctx, types) => {
  if (!node) return;
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (types.includes(n.type)) ctx.consume(n);
    for (const c of n.namedChildren) stack.push(c);
  }
};

const modifiersOf = (node) => node.namedChildren.filter((c) => c.type === 'modifier').map((c) => c.text);
const hasModifier = (node, words) => modifiersOf(node).some((m) => words.includes(m));

// Members visible outside the type: `public`, `internal` (assembly-wide) or `protected`.
function isExported(node) {
  if (node.type === 'enum_member_declaration') return isExported(node.parent?.parent ?? node);
  return hasModifier(node, ['public', 'internal', 'protected']);
}

const baseName = (node) => (node?.type === 'generic_name' ? node.namedChildren[0] : node);

// Names may be dotted (`namespace A.B`) or generic (`List<int>`); only the head is the symbol name.
function declName(node, ctx) {
  const n = node.childForFieldName('name');
  if (!n) return null;
  consumeAll(n, ctx, ['identifier']);
  return n.type === 'qualified_name' || n.type === 'alias_qualified_name' ? n : baseName(n);
}

// `int a = 1, b;` -> first declarator's identifier.
function fieldName(node, ctx) {
  const decl = node.namedChildren.find((c) => c.type === 'variable_declaration');
  const declarator = decl?.namedChildren.find((c) => c.type === 'variable_declarator');
  const name = declarator?.namedChildren.find((c) => c.type === 'identifier') ?? null;
  if (name) ctx.consume(name);
  return name;
}

// `const` fields are constants; everything else is a field.
function fieldKind(node) {
  return hasModifier(node, ['const']) ? 'constant' : 'field';
}

// `using X.Y;` -> spec `X.Y`; `using static X;` -> wildcard; `using A = X.Y;` -> alias A.
function usingSpec(node) {
  const text = node.text.replace(/^using\s+/, '').replace(/;\s*$/, '').trim();
  const alias = /^(\w+)\s*=\s*(.+)$/.exec(text);
  if (alias) return alias[2];
  return text.replace(/^static\s+/, '');
}

function usingNames(node) {
  const text = node.text.replace(/^using\s+/, '').replace(/;\s*$/, '').trim();
  const alias = /^(\w+)\s*=\s*(.+)$/.exec(text);
  if (alias) return [{ imported: '*', alias: alias[1] }];
  // A namespace (or `using static`) brings every type/member of the target into scope.
  return [{ imported: '*', alias: '*' }];
}

// `/// <summary>Text</summary>` docs: the engine's generic stripper leaves the third slash behind and
// knows nothing about XML tags, so clean the already-collapsed text once for every symbol.
function cleanDocs(out) {
  for (const s of out.symbols) {
    if (typeof s.doc !== 'string') continue;
    const text = s.doc.replace(/^\/\s*/, '').replace(/<\/?(summary|para|remarks|returns|value|exception)\b[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    s.doc = text || null;
  }
}

// Callee -> `{ name, receiver }`.
function invoked(node, ctx) {
  const fn = node.childForFieldName('function');
  if (!fn) return null;
  const simple = (target) => {
    const name = baseName(target);
    if (name) ctx.consume(target);
    return name?.text ?? '';
  };
  if (fn.type === 'member_access_expression') {
    const name = fn.childForFieldName('name');
    return { name: simple(name), receiver: ctx.text(fn.childForFieldName('expression')) };
  }
  if (fn.type === 'conditional_access_expression' || fn.type === 'member_binding_expression') {
    const binding = fn.type === 'member_binding_expression' ? fn : fn.namedChildren.find((c) => c.type === 'member_binding_expression');
    const name = binding?.childForFieldName('name');
    return { name: simple(name), receiver: ctx.text(fn.childForFieldName('condition')) };
  }
  return simple(fn) || ctx.text(fn);
}

// `new Foo(...)` / `new Foo<Bar>(...)` -> `Foo`.
function createdType(node, ctx) {
  const type = node.childForFieldName('type');
  if (!type) return null;
  const name = baseName(type);
  if (name) ctx.consume(name); // one ref per site: the call, not a duplicate type ref
  return ctx.text(name);
}

const initializerTarget = (node) => node.children.find((c) => c.type === 'this' || c.type === 'base')?.text ?? null;

// Declaration-only names: parameters, lambda parameters, locals, loop/pattern/range variables.
const skipPatterns = [
  '(parameter name: (identifier) @skip)',
  '(variable_declarator (identifier) @skip)',
  '(for_each_statement left: (identifier) @skip)',
  '(tuple_pattern (identifier) @skip)',
  '(from_clause (identifier) @skip)',
  '(declaration_expression (identifier) @skip)',
  '(type_parameter (identifier) @skip)',
  '(lambda_expression (identifier) @skip . "=>")',
];

const SIGNATURE = ['parameters', 'type'];

export default {
  id: 'csharp',
  label: 'C#',
  extensions: ['.cs'],
  grammar: 'c_sharp',
  support: 'full',
  commentTypes: ['comment'],
  transparentAncestors: [],
  definitions: {
    namespace_declaration: { kind: 'namespace', name: declName },
    file_scoped_namespace_declaration: { kind: 'namespace', name: declName },
    class_declaration: { kind: 'class', name: declName },
    struct_declaration: { kind: 'struct', name: declName },
    interface_declaration: { kind: 'interface', name: declName },
    record_declaration: { kind: 'record', name: declName, signature: ['parameters'] },
    record_struct_declaration: { kind: 'record', name: declName, signature: ['parameters'] },
    enum_declaration: { kind: 'enum', name: declName },
    enum_member_declaration: { kind: 'constant', name: declName },
    delegate_declaration: { kind: 'type', name: declName, signature: ['parameters', 'type'] },
    method_declaration: { kind: 'method', name: declName, signature: SIGNATURE },
    constructor_declaration: { kind: 'method', name: declName, signature: ['parameters'] },
    field_declaration: { kind: fieldKind, name: fieldName },
    event_field_declaration: { kind: 'field', name: fieldName },
    event_declaration: { kind: 'field', name: declName },
    property_declaration: { kind: 'property', name: declName },
  },
  calls: [
    { node: 'invocation_expression', fn: invoked },
    { node: 'object_creation_expression', fn: createdType },
    { node: 'constructor_initializer', fn: initializerTarget },
  ],
  imports: [{ node: 'using_directive', kind: 'import', spec: usingSpec, names: usingNames }],
  references: [{ node: 'identifier' }],
  skipPatterns,
  isExported,
  embeddings: [],
  hooks: { postProcess: cleanDocs },
};

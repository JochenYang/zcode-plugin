// Language pack id must equal the file name (registry.mjs). See CONTRACTS.md §5.
//
// tree-sitter-java notes (checked with bin/ast.mjs):
// - `import_declaration` has no field names: the module path is its text without `import [static]`.
// - `field_declaration` / `constant_declaration` expose `declarator` (a `variable_declarator`), so the
//   name path is `declarator.name`; the engine consumes that node so it never becomes a reference.
// - `this` / `super` are named nodes (`this`, `super`), not identifiers.
// - Consuming a node does not consume its children: dotted paths (imports, package) are consumed leaf by leaf.
//
// skipPatterns: the engine appends `@skip` to the outer node of the pattern, so the inner `@skip` is what
// actually marks the identifier; without it only the parent is marked and the identifier still leaks as a ref.

const consumeIdentifiers = (node, ctx) => {
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (n.type === 'identifier' || n.type === 'type_identifier') ctx.consume(n);
    for (const c of n.namedChildren) stack.push(c);
  }
};

const hasModifier = (node, word) => {
  if (!node) return false;
  const mods = node.namedChildren.find((c) => c.type === 'modifiers');
  return !!mods && mods.children.some((c) => c.type === word);
};

// `public` is the only modifier that makes a member visible outside its package. Enum constants carry
// no modifiers of their own, so they inherit the visibility of the enclosing enum.
function isExported(node) {
  if (node.type === 'enum_constant') {
    const owner = node.parent?.type === 'enum_body' ? node.parent.parent : node.parent;
    return hasModifier(owner, 'public');
  }
  return hasModifier(node, 'public');
}

// `package a.b;` is a namespace symbol; its dotted path must not leak as three bare references.
function packageName(node, ctx) {
  const path = node.namedChildren.find((c) => c.type === 'scoped_identifier' || c.type === 'identifier');
  if (path) consumeIdentifiers(path, ctx);
  return path;
}

// `import a.b.C;` -> spec `a.b.C`; `import a.b.*;` -> spec `a.b` + wildcard name;
// `import static a.b.C.m;` -> spec `a.b.C` + imported `m`.
function parseImport(node) {
  const text = node.text.replace(/^import\s+/, '').replace(/;\s*$/, '').trim();
  const isStatic = /^static\s+/.test(text);
  const path = (isStatic ? text.replace(/^static\s+/, '') : text).trim();
  return { isStatic, path };
}

// The engine consumes the whole import statement (descendants included), so no per-node consuming here.
const importSpec = (node) => {
  const { isStatic, path } = parseImport(node);
  if (path.endsWith('.*')) return path.slice(0, -2);
  return isStatic ? path.split('.').slice(0, -1).join('.') : path;
};

const importNames = (node) => {
  const { path } = parseImport(node);
  if (path.endsWith('.*')) return [{ imported: '*', alias: '*' }];
  const last = path.split('.').pop();
  return last ? [{ imported: last, alias: last }] : null;
};

// `new ArrayList<>()` -> `ArrayList`; `new java.util.List<>()` -> receiver `java.util` + name `List`
// (the engine splits dotted names on the returned string).
const createdType = (node, ctx) => {
  let type = node.childForFieldName('type');
  if (type?.type === 'generic_type') type = type.namedChildren[0] ?? type;
  if (type) ctx.consume(type); // one ref per site: the call, not a duplicate type ref
  return ctx.text(type);
};

const invoked = (node, ctx) => {
  const name = node.childForFieldName('name');
  if (name) ctx.consume(name); // the call ref already represents the method name
  return { name: ctx.text(name), receiver: ctx.text(node.childForFieldName('object')) };
};

// Parameter, loop, catch, lambda and local-variable names are declarations, not uses; left alone they
// would be reported as refs and could link to an unrelated same-named symbol by bare-name fallback.
const skipPatterns = [
  '(formal_parameter name: (identifier) @skip)',
  '(spread_parameter (variable_declarator (identifier) @skip))',
  '(variable_declarator name: (identifier) @skip)',
  '(enhanced_for_statement name: (identifier) @skip)',
  '(catch_formal_parameter name: (identifier) @skip)',
  '(lambda_expression parameters: (identifier) @skip)',
  '(inferred_parameters (identifier) @skip)',
  '(type_parameter (type_identifier) @skip)',
  '(element_value_pair key: (identifier) @skip)',
];

export default {
  id: 'java',
  label: 'Java',
  extensions: ['.java'],
  grammar: 'java',
  support: 'full',
  commentTypes: ['line_comment', 'block_comment'],
  transparentAncestors: [],
  definitions: {
    package_declaration: { kind: 'namespace', name: packageName },
    method_declaration: { kind: 'method', name: 'name', signature: ['parameters', 'type'] },
    constructor_declaration: { kind: 'method', name: 'name', signature: ['parameters'] },
    class_declaration: { kind: 'class', name: 'name' },
    interface_declaration: { kind: 'interface', name: 'name' },
    enum_declaration: { kind: 'enum', name: 'name' },
    record_declaration: { kind: 'record', name: 'name', signature: ['parameters'] },
    field_declaration: { kind: 'field', name: 'declarator.name' },
    constant_declaration: { kind: 'constant', name: 'declarator.name' },
    enum_constant: { kind: 'constant', name: 'name' },
  },
  calls: [
    { node: 'method_invocation', fn: invoked },
    { node: 'object_creation_expression', fn: createdType },
    { node: 'explicit_constructor_invocation', fn: (node) => node.childForFieldName('constructor')?.text ?? null },
  ],
  imports: [{ node: 'import_declaration', kind: 'import', spec: importSpec, names: importNames }],
  references: [{ node: 'identifier' }, { node: 'type_identifier', kind: 'type' }],
  skipPatterns,
  isExported,
  embeddings: [],
  hooks: {},
};

// Language pack id must equal the file name (registry.mjs). See CONTRACTS.md §5.
//
// tree-sitter-kotlin wasm notes (checked with bin/ast.mjs; manifest: fieldCount=0):
// - No field names at all: every name/signature is taken by child type and position.
// - `data class Money(val cents: Long)` -> `class_declaration` > `type_identifier` + `primary_constructor`
//   > `class_parameter`; interfaces and enums are also `class_declaration` (see classKind).
// - `a.b.c()` -> `call_expression` > `navigation_expression`(receiver, `navigation_suffix` > `simple_identifier`).
//   `f(x) { ... }` (trailing lambda) nests a second `call_expression` around the real call; only the inner one counts.
// - The last `import_header` swallows any comment that follows the imports, so the engine's
//   `prevSiblingComment` lookup misses the first KDoc in a file; `kdoc` below handles that case.
// - Comments: `line_comment`, `multiline_comment`.

const child = (node, type) => (node ? node.namedChildren.find((c) => c.type === type) ?? null : null);

const consumeAll = (node, ctx, types) => {
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (types.includes(n.type)) ctx.consume(n);
    for (const c of n.namedChildren) stack.push(c);
  }
};

// Name functions consume the name node so it is not also reported as a bare reference.
const firstName = (node, ctx) => {
  const n = child(node, 'simple_identifier');
  if (n) ctx.consume(n);
  return n;
};

// `class Foo` / `object Foo` carry the name as a `type_identifier`; `companion object` may be unnamed.
function typeName(node, ctx) {
  const n = child(node, 'type_identifier') ?? child(node, 'simple_identifier');
  if (n) ctx?.consume(n);
  return n ?? (node?.type === 'companion_object' ? 'Companion' : null);
}

// `val x: T = v` / `var x ...`: the name lives in `variable_declaration`; destructuring has none.
const propertyName = (node, ctx) => firstName(child(node, 'variable_declaration'), ctx);

// `interface Foo` / `enum class Foo` are `class_declaration` nodes; the keyword itself is an anonymous child.
function classKind(node) {
  const words = node.children.map((c) => c.type);
  if (words.includes('interface')) return 'interface';
  if (words.includes('enum') || child(node, 'enum_class_body')) return 'enum';
  return 'class';
}

// `const val` / `val` / `var` at declaration level: constant / constant / variable.
function propertyKind(node) {
  const mods = child(node, 'modifiers');
  if (mods?.namedChildren.some((c) => c.type === 'property_modifier' && c.text === 'const')) return 'constant';
  return child(node, 'binding_pattern_kind')?.text === 'var' ? 'variable' : 'constant';
}

// Kotlin is public by default; only `private` members are file/class-local. Enum entries inherit the
// visibility of their enum (they carry no modifiers of their own).
function isExported(node) {
  if (node.type === 'enum_entry') return isExported(node.parent?.parent ?? false);
  const mods = child(node, 'modifiers');
  return !mods?.namedChildren.some((c) => c.type === 'visibility_modifier' && c.text === 'private');
}

// Signature: parameters text plus the return type when present.
function signature(node, ctx) {
  const params = child(node, 'function_value_parameters');
  const ret = child(node, 'user_type') ?? child(node, 'nullable_type') ?? child(node, 'function_type');
  return [ctx.text(params), ctx.text(ret)].filter(Boolean).join(' ');
}

const stripComment = (text) =>
  String(text ?? '')
    .replace(/^\/\*\*?|\/\//, '')
    .replace(/\*\/$/, '')
    .replace(/^\s*\*\s?/gm, '')
    .trim()
    .split(/\n\s*\n/)[0]
    .replace(/\s+/g, ' ')
    .trim();

// Mirrors the engine's prevSiblingComment rule, plus the import_header quirk above.
function kdoc(node, ctx) {
  const commentTypes = ctx.spec.commentTypes;
  let prev = node.previousNamedSibling ?? node.previousSibling;
  if (prev?.type === 'import_list') {
    const last = prev.namedChildren[prev.namedChildren.length - 1];
    const tail = last?.namedChildren[last.namedChildren.length - 1];
    if (tail && commentTypes.includes(tail.type)) prev = tail;
  }
  if (!prev || !commentTypes.includes(prev.type)) return null;
  if (node.startPosition.row - prev.endPosition.row > 2) return null;
  return stripComment(prev.text);
}

function packageName(node, ctx) {
  const path = child(node, 'identifier');
  if (path) consumeAll(path, ctx, ['simple_identifier']);
  return path;
}

// `import a.b.C as D` -> spec `a.b.C`, imported `C`, alias `D`; `import a.b.*` -> spec `a.b` + wildcard.
const importPath = (node) => child(node, 'identifier')?.text ?? '';
const importSpec = (node) => importPath(node);

function importNames(node) {
  const alias = child(node, 'import_alias');
  const aliasName = alias ? alias.text.replace(/^as\s+/, '').trim() : null;
  if (child(node, 'wildcard_import')) return [{ imported: '*', alias: aliasName ?? '*' }];
  const last = importPath(node).split('.').pop();
  return last ? [{ imported: last, alias: aliasName ?? last }] : null;
}

// Callee -> `{ name, receiver }`; null for the trailing-lambda wrapper (its child is the real call).
function callee(node, ctx) {
  const target = node.namedChildren.find((c) => c.type !== 'call_suffix');
  if (!target || target.type === 'call_expression' || target.type === 'call_suffix') return null;
  if (target.type === 'simple_identifier') {
    ctx.consume(target); // the call ref already represents the name
    return { name: target.text, receiver: '' };
  }
  if (target.type === 'navigation_expression') {
    const parts = target.namedChildren;
    const suffix = parts[parts.length - 1]?.type === 'navigation_suffix' ? parts[parts.length - 1] : null;
    const name = child(suffix, 'simple_identifier') ?? suffix;
    if (name) ctx.consume(name);
    const receiver = suffix ? parts.slice(0, -1) : parts;
    return { name: ctx.text(name), receiver: receiver.map((n) => n.text).join('') };
  }
  return target.text; // rare (parenthesized/indexing callee): the engine splits on the last `.`
}

const skipPatterns = [
  '(parameter (simple_identifier) @skip)',
  '(class_parameter (simple_identifier) @skip)',
  '(variable_declaration (simple_identifier) @skip)',
  '(type_parameter (type_identifier) @skip)',
  '(enum_entry (simple_identifier) @skip)',
  '(type_alias (type_identifier) @skip)',
];

const DOC = { from: kdoc };
const MEMBER = new Set(['source_file', 'class_body']);

export default {
  id: 'kotlin',
  label: 'Kotlin',
  extensions: ['.kt', '.kts'],
  grammar: 'kotlin',
  support: 'full',
  commentTypes: ['line_comment', 'multiline_comment'],
  transparentAncestors: [],
  definitions: {
    package_header: { kind: 'namespace', name: packageName },
    function_declaration: { kind: 'function', name: firstName, signature, doc: DOC },
    class_declaration: { kind: classKind, name: typeName, doc: DOC },
    object_declaration: { kind: 'object', name: typeName, doc: DOC },
    companion_object: { kind: 'object', name: typeName, doc: DOC },
    enum_entry: { kind: 'constant', name: firstName },
    type_alias: { kind: 'type', name: typeName, doc: DOC },
    // Only declarations (top level or in a type body) are symbols; locals inside functions are not.
    property_declaration: { kind: propertyKind, name: propertyName, doc: DOC, when: (node) => MEMBER.has(node.parent?.type) },
    secondary_constructor: { kind: 'method', name: (node, ctx) => typeName(node.parent?.parent, ctx) },
  },
  calls: [
    { node: 'call_expression', fn: callee },
    { node: 'constructor_delegation_call', fn: (node) => (/super/.test(node.text) ? 'super' : 'this') },
  ],
  imports: [{ node: 'import_header', kind: 'import', spec: importSpec, names: importNames }],
  references: [{ node: 'simple_identifier' }, { node: 'type_identifier', kind: 'type' }],
  skipPatterns,
  isExported,
  embeddings: [],
  hooks: {},
};

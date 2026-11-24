// C LanguageSpec (CONTRACTS.md §5). C++ and Objective-C extend this pack.
// Grammar: tree-sitter-c. Names live in `identifier` (functions/macros), `field_identifier`
// (struct members) and `type_identifier` (structs/enums/typedefs).
const stripInclude = (s) => String(s ?? '').trim().replace(/^<|>$/g, '').replace(/^"|"$/g, '');

// Walk the declarator chain to the declared name. The name may hide behind pointer/array/
// parenthesized declarators (`char *f(void)` -> pointer_declarator > function_declarator >
// identifier), so a plain `declarator.declarator` path only works for simple signatures.
// Returns the name node (or a string for destructors/operators, `~Node`, `operator[]`) and
// whether the chain is a function. A function-typed `name` is not consumed by the engine, so
// the name node is consumed here or the definition's own name would also be a reference.
function declaratorInfo(node, ctx) {
  let fn = false;
  let d = ctx.field(node, 'declarator');
  while (d) {
    if (d.type === 'function_declarator') fn = true;
    if (d.type === 'destructor_name') return { name: `~${/^~\s*(\w+)/.exec(d.text)?.[1] ?? ''}`, fn: true };
    if (d.type === 'operator_name') return { name: d.text, fn: true };
    if (d.type === 'identifier' || d.type === 'field_identifier' || d.type === 'type_identifier') {
      ctx.consume(d);
      return { name: d, fn };
    }
    // qualified_identifier (`Node::connect`) carries its name in `name`, not `declarator`;
    // attributed_declarator (`float2 position [[attribute(0)]]`) has neither and lists the
    // name as a bare child.
    d = ctx.field(d, 'declarator') ?? ctx.field(d, 'name') ?? d.namedChildren.find((c) => c.type.endsWith('declarator') || c.type === 'identifier' || c.type === 'field_identifier');
  }
  return { name: null, fn };
}

const declaratorName = (node, ctx) => declaratorInfo(node, ctx).name;
const isFieldDeclaration = (node, ctx) => {
  const info = declaratorInfo(node, ctx);
  return !!info.name && !info.fn;
};

// `struct Point p` is a reference, not a definition: only specifiers with a body define a type.
const hasBody = (node, ctx) => !!ctx.field(node, 'body');

// Function parameters hang off the declarator, not off the function_definition itself.
function parametersOf(node, ctx) {
  for (let d = ctx.field(node, 'declarator'); d; d = ctx.field(d, 'declarator') ?? ctx.field(d, 'name') ?? d.namedChildren.find((c) => c.type.endsWith('declarator'))) {
    const params = ctx.field(d, 'parameters');
    if (params) return params.text;
  }
  return null;
}

// Doc comments: `/** */` blocks or `///` lines that start their own line. A trailing
// comment (`}  // namespace geo`) must not become the doc of the next declaration.
function docComment(node, ctx) {
  let owner = node;
  while (owner.parent && (ctx.spec.transparentAncestors ?? []).includes(owner.parent.type)) owner = owner.parent;
  const prev = owner.previousNamedSibling;
  if (!prev || !ctx.spec.commentTypes.includes(prev.type)) return null;
  if (owner.startPosition.row - prev.endPosition.row > 2) return null;
  const line = ctx.lines[prev.startPosition.row] ?? '';
  if (line.slice(0, prev.startPosition.column).trim()) return null;
  return prev.text
    .replace(/^\/\/[/!]*\s?/gm, '')
    .replace(/\/\*\*?|\*\//g, '')
    .replace(/^\s*\*\s?/gm, '');
}
const DOC = { from: docComment };

// Casts parse as calls with a `template_function` callee (C++ only); everything else keeps
// its callee, with template arguments stripped so `std::make_unique<T>(x)` splits into
// std + make_unique. A bare identifier callee is returned as a node so the engine consumes it.
const CASTS = new Set(['static_cast', 'const_cast', 'reinterpret_cast', 'dynamic_cast']);
function stripTemplateArgs(text) {
  let out = '';
  let depth = 0;
  for (const ch of text) {
    if (ch === '<') { depth++; continue; }
    if (ch === '>' && depth > 0) { depth--; continue; }
    if (depth === 0) out += ch;
  }
  return out.trim();
}
function calleeOf(node, ctx) {
  const f = ctx.field(node, 'function');
  if (!f) return null;
  if (!f.text.includes('<')) return CASTS.has(f.text) ? null : f;
  const name = stripTemplateArgs(f.text);
  ctx.consume(f);
  return CASTS.has(name) ? null : name || null;
}

// Visible outside the translation unit unless declared `static`; type/macro definitions
// are always visible to whoever includes the file.
const isExported = (node) =>
  node.type !== 'function_definition' || !node.namedChildren.some((c) => c.type === 'storage_class_specifier' && c.text === 'static');

// Parameter names, enumerator names, macro parameters and declared variables are
// definitions, not references. Each pattern names its own `@skip` so the identifier
// inside the construct is excluded. `extends` appends this list (C++, Objective-C).
const skipPatterns = [
  '(parameter_declaration declarator: (identifier) @skip)',
  '(parameter_declaration declarator: (pointer_declarator declarator: (identifier) @skip))',
  '(enumerator name: (identifier) @skip)',
  '(preproc_params (identifier) @skip)',
  '(preproc_ifdef name: (identifier) @skip)',
  '(declaration declarator: (identifier) @skip)',
  '(init_declarator declarator: (identifier) @skip)',
  // Extra declarators of `double x, y;` / `float x, y, z, w;` (the first is the symbol's name).
  '(field_declaration (field_identifier) @skip)',
];

const spec = {
  id: 'c',
  label: 'C',
  extensions: ['.c', '.h'],
  grammar: 'c',
  support: 'full',
  commentTypes: ['comment'],
  definitions: {
    function_definition: { kind: 'function', name: declaratorName, signature: parametersOf, doc: DOC },
    struct_specifier: { kind: 'struct', name: 'name', when: hasBody, doc: DOC },
    // A union is a struct-like record type.
    union_specifier: { kind: 'struct', name: 'name', when: hasBody, doc: DOC },
    enum_specifier: { kind: 'enum', name: 'name', when: hasBody, doc: DOC },
    type_definition: { kind: 'type', name: declaratorName, doc: DOC },
    preproc_def: { kind: 'macro', name: 'name', doc: DOC },
    preproc_function_def: { kind: 'macro', name: 'name', doc: DOC },
    field_declaration: { kind: 'field', name: declaratorName, when: isFieldDeclaration, doc: DOC },
  },
  calls: [{ node: 'call_expression', fn: calleeOf }],
  imports: [{ node: 'preproc_include', kind: 'include', spec: (n, ctx) => stripInclude(ctx.field(n, 'path')?.text) }],
  references: [{ node: 'identifier' }, { node: 'type_identifier', kind: 'type' }],
  skipPatterns,
  isExported,
};

// Shared with the packs that extend C (C++, Objective-C).
export { declaratorInfo, declaratorName, docComment, isExported };

export default spec;

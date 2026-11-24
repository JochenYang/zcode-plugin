// Rust LanguageSpec (CONTRACTS.md §5).
// Grammar: tree-sitter-rust. Items are `*_item` nodes; `impl_item` is recorded as a `type`
// symbol so its methods get a parent and a qualified name (`Node.new`), and `function_item`
// kind is resolved to `method` for members of an impl.
const lastSegment = (s) => {
  const t = String(s ?? '').trim();
  const i = t.lastIndexOf('::');
  return i >= 0 ? t.slice(i + 2) : t;
};

// `use a::b::{c as d, e};` -> one {imported, alias} per leaf; `*` imports carry no names.
function useNames(node, ctx) {
  const arg = ctx.field(node, 'argument');
  if (!arg) return null;
  const out = [];
  const add = (path, alias) => {
    const imported = lastSegment(path);
    if (imported) out.push({ imported, alias: alias || imported });
  };
  const visit = (n) => {
    if (!n || n.type === 'use_wildcard') return false;
    if (n.type === 'use_as_clause') add(ctx.field(n, 'path')?.text, ctx.field(n, 'alias')?.text);
    else if (n.type === 'scoped_use_list') {
      const prefix = ctx.field(n, 'path')?.text;
      const list = ctx.field(n, 'list');
      for (const item of list?.namedChildren ?? []) {
        if (item.type === 'use_wildcard') return false;
        if (item.type === 'use_as_clause') add(`${prefix}::${ctx.field(item, 'path')?.text}`, ctx.field(item, 'alias')?.text);
        else add(`${prefix}::${item.text}`);
      }
    } else if (n.type === 'use_list') {
      for (const item of n.namedChildren) {
        if (!visit(item)) return false;
      }
    } else add(n.text);
    return true;
  };
  return visit(arg) && out.length ? out : null;
}

const isImplMethod = (node) => node.parent?.type === 'declaration_list' && node.parent.parent?.type === 'impl_item';

const signature = (node, ctx) => {
  const typeParams = ctx.field(node, 'type_parameters')?.text;
  const params = ctx.field(node, 'parameters')?.text ?? '()';
  const ret = ctx.field(node, 'return_type');
  return `${typeParams ? `${typeParams} ` : ''}${params}${ret ? ` -> ${ret.text}` : ''}`;
};

// Doc comments are `///` line comments (one node per line) or `/** */` blocks; attributes such
// as `#[derive(..)]` may sit between the comment and the item, so measure from the attribute.
const DOC_COMMENT = new Set(['line_comment', 'block_comment']);
function docComment(node) {
  let anchor = node;
  while (anchor.previousNamedSibling?.type === 'attribute_item') anchor = anchor.previousNamedSibling;
  const prev = anchor.previousNamedSibling;
  if (!prev || !DOC_COMMENT.has(prev.type)) return null;
  if (anchor.startPosition.row - prev.endPosition.row > 2) return null;
  const lines = [prev.text];
  let cur = prev;
  while (cur.previousNamedSibling && /^\/\/[!/]/.test(cur.previousNamedSibling.text)) {
    cur = cur.previousNamedSibling;
    lines.unshift(cur.text);
  }
  return lines
    .join('\n')
    .replace(/^\/\/[/!]\s?/gm, '')
    .replace(/\/\*\*?|\*\//g, '')
    .replace(/^\s*\*\s?/gm, '');
}

// Rust exports with `pub` / `pub(crate)`; an impl block itself is never exported.
const isExported = (node) => (node.type === 'impl_item' ? null : /^\s*pub\b/.test(node.text));

const spec = {
  id: 'rust',
  label: 'Rust',
  extensions: ['.rs'],
  grammar: 'rust',
  support: 'full',
  commentTypes: ['line_comment', 'block_comment'],
  definitions: {
    function_item: { kind: (n) => (isImplMethod(n) ? 'method' : 'function'), name: 'name', signature, doc: { from: docComment } },
    // Trait method declarations without a body.
    function_signature_item: { kind: 'method', name: 'name', signature, doc: { from: docComment } },
    struct_item: { kind: 'struct', name: 'name', doc: { from: docComment } },
    // A union is a struct-like ADT (upstream tags.scm also files it under class).
    union_item: { kind: 'struct', name: 'name', doc: { from: docComment } },
    enum_item: { kind: 'enum', name: 'name', doc: { from: docComment } },
    trait_item: { kind: 'trait', name: 'name', doc: { from: docComment } },
    type_item: { kind: 'type', name: 'name', doc: { from: docComment } },
    const_item: { kind: 'constant', name: 'name', doc: { from: docComment } },
    static_item: { kind: 'variable', name: 'name', doc: { from: docComment } },
    mod_item: { kind: 'namespace', name: 'name', doc: { from: docComment } },
    macro_definition: { kind: 'macro', name: 'name', doc: { from: docComment } },
    field_declaration: { kind: 'field', name: 'name' },
    // Named `impl Node` / `impl Label for Node`: keeps the type name searchable without
    // colliding with the struct's name, which would make every `Node` type ref ambiguous.
    impl_item: {
      kind: 'type',
      name: (n, ctx) => {
        const trait = ctx.field(n, 'trait');
        const type = ctx.field(n, 'type')?.text;
        return trait ? `impl ${trait.text} for ${type}` : `impl ${type}`;
      },
    },
  },
  calls: [
    // `x.collect::<Vec<_>>()` wraps the callee in `generic_function`; unwrap it so the
    // receiver/name split sees the real callee.
    {
      node: 'call_expression',
      fn: (n, ctx) => {
        const f = ctx.field(n, 'function');
        return f?.type === 'generic_function' ? ctx.field(f, 'function') : f;
      },
    },
    { node: 'macro_invocation', fn: 'macro' },
  ],
  imports: [{ node: 'use_declaration', kind: 'import', spec: (n, ctx) => ctx.field(n, 'argument')?.text?.trim(), names: useNames }],
  references: [{ node: 'identifier' }, { node: 'type_identifier', kind: 'type' }],
  // Parameter, closure, `let` and `for` bindings are definitions, not references; so are
  // enum variant names and the identifiers inside `#[...]` attributes. Each pattern names
  // its own `@skip` so the identifier inside the construct is excluded.
  skipPatterns: [
    '(parameter pattern: (identifier) @skip)',
    '(closure_parameters (identifier) @skip)',
    '(let_declaration pattern: (identifier) @skip)',
    '(for_expression pattern: (identifier) @skip)',
    '(enum_variant name: (identifier) @skip)',
    '(type_parameters (type_identifier) @skip)',
    '(attribute (identifier) @skip)',
    '(attribute (token_tree (identifier) @skip))',
  ],
  isExported,
};

export default spec;

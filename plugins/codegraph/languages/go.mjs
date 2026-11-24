// Go LanguageSpec (CONTRACTS.md §5).
// Grammar: tree-sitter-go. Names use `identifier` (functions/vars), `field_identifier`
// (methods/fields) and `type_identifier` (types); doc comments are `//` `comment` nodes
// sitting as previous siblings of the declaration.
const quote = (s) => String(s ?? '').trim().replace(/^["'`]|["'`]$/g, '');

// Go exports by capitalisation of the first rune (unicode.IsUpper), not by keyword.
const isExported = (_node, sym) => /^\p{Lu}/u.test(sym.name);

// const/var/type specs always sit in a `*_declaration` wrapper, so the wrapper must be
// transparent for doc-comment lookup and for the "is this package scope" check: locals
// inside function bodies are not indexed.
const DECLARATION_WRAPPERS = ['const_declaration', 'var_declaration', 'type_declaration'];
const atPackageScope = (node, ctx) => ctx.isTopLevel(node);

function typeSpecKind(node, ctx) {
  const underlying = ctx.field(node, 'type');
  if (underlying?.type === 'struct_type') return 'struct';
  if (underlying?.type === 'interface_type') return 'interface';
  return 'type';
}

// `import str "strings"` binds the whole package to `str`; a blank import binds nothing.
function importNames(node, ctx) {
  const alias = ctx.field(node, 'name');
  if (!alias || alias.type === 'blank_identifier') return null;
  return [{ imported: '*', alias: alias.text }];
}

const spec = {
  id: 'go',
  label: 'Go',
  extensions: ['.go'],
  grammar: 'go',
  support: 'full',
  commentTypes: ['comment'],
  transparentAncestors: DECLARATION_WRAPPERS,
  definitions: {
    function_declaration: { kind: 'function', name: 'name', signature: ['parameters', 'result'] },
    // Methods are declared at top level; the receiver names the type, so qualify them with it
    // (`(engine *Engine)` / `(s Set[T])` / `(x *pkg.T)` -> `Engine.Run`, `Set.Push`, `T.M`).
    method_declaration: {
      kind: 'method', name: 'name', signature: ['receiver', 'parameters', 'result'],
      qual: (n, ctx) => {
        const m = /(\w+)\s*(?:\[[^\]]*\])?\s*\)\s*$/.exec(ctx.text(n.childForFieldName('receiver')) ?? '');
        return m ? `${m[1]}.${ctx.text(n.childForFieldName('name'))}` : null;
      },
    },
    // Interface method signatures (`Label() string`) mirror the abstract methods of the TS pack.
    method_spec: { kind: 'method', name: 'name', signature: ['parameters', 'result'] },
    field_declaration: { kind: 'field', name: 'name' },
    type_spec: { kind: typeSpecKind, name: 'name', when: atPackageScope },
    const_spec: { kind: 'constant', name: 'name', when: atPackageScope },
    var_spec: { kind: 'variable', name: 'name', when: atPackageScope },
  },
  calls: [{ node: 'call_expression', fn: 'function' }],
  // One entry per `import_spec`, so grouped imports get their own spec and line.
  imports: [{ node: 'import_spec', kind: 'import', spec: (n, ctx) => quote(ctx.text(ctx.field(n, 'path'))), names: importNames }],
  references: [
    { node: 'identifier' },
    { node: 'type_identifier', kind: 'type' },
    { node: 'field_identifier' },
  ],
  // Parameter/receiver names, range targets and the extra names of `var a, b = ...` are
  // definitions, not references; excluded by query pattern rather than a per-identifier `when`.
  // `x.m()` is already a call ref on `m`, so the selector's field must not also count as a ref.
  // Each pattern names its own `@skip` so the identifier inside the construct is excluded.
  skipPatterns: [
    '(parameter_declaration name: (identifier) @skip)',
    '(variadic_parameter_declaration name: (identifier) @skip)',
    '(range_clause left: (expression_list (identifier) @skip))',
    '(const_spec name: (identifier) @skip)',
    '(var_spec name: (identifier) @skip)',
    '(selector_expression field: (field_identifier) @skip)',
  ],
  isExported,
};

export default spec;

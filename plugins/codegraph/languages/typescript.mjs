// Reference LanguageSpec. Every other pack mirrors this shape (CONTRACTS.md §5).
const quote = (s) => String(s ?? '').trim().replace(/^["'`]|["'`]$/g, '');

const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'generator_function_expression']);
const pascal = (name) => /^[A-Z]/.test(name);
const STATEMENT_SCOPES = new Set(['program', 'statement_block', 'class_body', 'enum_body', 'switch_body', 'declaration', 'do_statement', 'for_statement', 'while_statement', 'if_statement']);

// Top-level const/let and function-valued declarators become symbols; locals stay out
// of the index (they would drown search results without helping navigation).
function declaratorKind(node, ctx) {
  const name = ctx.text(node.childForFieldName('name'));
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null; // destructuring patterns are not single symbols
  const value = node.childForFieldName('value');
  if (value && FUNCTION_VALUES.has(value.type)) return pascal(name) ? 'component' : 'function';
  if (value?.type === 'class') return 'class';
  const decl = node.parent; // lexical_declaration | variable_declaration | for_statement ...
  if (decl?.type !== 'lexical_declaration') return null;
  const owner = decl.parent; // program | export_statement | statement_block ...
  if (!owner || (owner.type !== 'program' && owner.type !== 'export_statement')) return null;
  return /^\s*const\b/.test(decl.text) ? 'constant' : 'variable';
}

function importNames(node) {
  const clause = node.namedChildren.find((c) => c.type === 'import_clause');
  if (!clause) return null;
  const out = [];
  for (const c of clause.namedChildren) {
    if (c.type === 'identifier') out.push({ imported: 'default', alias: c.text });
    else if (c.type === 'namespace_import') {
      const m = /as\s+([\w$]+)\s*$/.exec(c.text);
      out.push({ imported: '*', alias: m ? m[1] : c.text });
    } else if (c.type === 'named_imports') {
      for (const s of c.namedChildren) {
        if (s.type !== 'import_specifier') continue;
        const name = s.childForFieldName('name');
        const alias = s.childForFieldName('alias');
        out.push({ imported: name.text, alias: alias ? alias.text : name.text });
      }
    } else if (c.type === 'import_specifier') {
      const name = c.childForFieldName('name');
      const alias = c.childForFieldName('alias');
      out.push({ imported: name.text, alias: alias ? alias.text : name.text });
    }
  }
  return out;
}

// Only the statement itself counts: a nested helper inside an exported function is not exported.
function isExported(node) {
  let n = node;
  while (n.parent && !STATEMENT_SCOPES.has(n.parent.type)) {
    if (n.parent.type === 'export_statement') return true;
    n = n.parent;
  }
  return false;
}

// A declarator sits inside lexical_declaration/variable_declaration (optionally inside
// export_statement), so the doc comment is the wrapper's previous sibling, not the
// declarator's. Only the first declarator of a multi-declaration owns the comment.
function declaratorDoc(node, ctx) {
  const decl = node.parent;
  if (decl?.namedChildren?.[0]?.id !== node.id) return null;
  const owner = decl.parent?.type === 'export_statement' ? decl.parent : decl;
  const prev = owner?.previousNamedSibling;
  if (!prev || !ctx.spec.commentTypes.includes(prev.type) || owner.startPosition.row - prev.endPosition.row > 2) return null;
  return prev.text.replace(/^\/\*\*|\*\/$/g, '').replace(/^\s*\*\s?/gm, '').trim() || null;
}

const callsLike = (name) => (node, ctx) => ctx.text(node.childForFieldName('function')) === name;
const firstStringArg = (node) => quote(node.childForFieldName('arguments')?.namedChildren?.[0]?.text);
// Signature fields are not consumed by the engine (type references inside them must survive),
// so parameter names are excluded by query patterns instead of a JS `when` (reading `parent`
// per identifier costs ~3.5 µs, which dominated large files). The capture must sit on the
// identifier itself: the engine consumes only captured nodes, so capturing the parameter
// wrapper would leave the name as a reference.
const skipPatterns = ['(required_parameter pattern: (identifier) @skip)', '(optional_parameter pattern: (identifier) @skip)'];
const isRequireOrImport = (node, ctx) => {
  const fn = ctx.text(node.childForFieldName('function'));
  return fn !== 'require' && fn !== 'import';
};

const spec = {
  id: 'typescript',
  label: 'TypeScript',
  extensions: ['.ts', '.mts', '.cts'],
  grammar: 'typescript',
  support: 'full',
  scope: 'locals',
  commentTypes: ['comment'],
  transparentAncestors: ['export_statement'],
  definitions: {
    function_declaration: { kind: 'function', name: 'name', signature: ['parameters', 'return_type'] },
    generator_function_declaration: { kind: 'function', name: 'name', signature: ['parameters', 'return_type'] },
    class_declaration: { kind: 'class', name: 'name' },
    abstract_class_declaration: { kind: 'class', name: 'name' },
    interface_declaration: { kind: 'interface', name: 'name' },
    enum_declaration: { kind: 'enum', name: 'name' },
    type_alias_declaration: { kind: 'type', name: 'name' },
    method_definition: { kind: 'method', name: 'name', signature: ['parameters', 'return_type'] },
    abstract_method_signature: { kind: 'method', name: 'name', signature: ['parameters', 'return_type'] },
    public_field_definition: { kind: 'field', name: 'name' },
    variable_declarator: { kind: declaratorKind, name: 'name', when: (n, ctx) => declaratorKind(n, ctx) !== null, doc: { from: declaratorDoc } },
    // `namespace X {}` is parsed as `module` by tree-sitter-typescript 0.23.
    module: { kind: 'namespace', name: 'name' },
  },
  calls: [
    { node: 'call_expression', fn: 'function', when: isRequireOrImport },
    { node: 'new_expression', fn: 'constructor' },
  ],
  imports: [
    { node: 'import_statement', kind: 'import', spec: (n, ctx) => quote(ctx.text(ctx.field(n, 'source'))), names: importNames },
    { node: 'export_statement', kind: 'reexport', when: (n) => n.childForFieldName('source') !== null, spec: (n, ctx) => quote(ctx.text(ctx.field(n, 'source'))) },
    { node: 'call_expression', kind: 'require', when: callsLike('require'), spec: firstStringArg },
    { node: 'call_expression', kind: 'dynamic', when: callsLike('import'), spec: firstStringArg },
  ],
  references: [{ node: 'identifier' }, { node: 'type_identifier', kind: 'type' }],
  skipPatterns,
  // Grammar gaps (TS 5 `export type *`, `importOriginal<typeof import('x')>()`) fold following statements
  // into ERROR nodes; re-cover their top-level definitions by line-anchored regex (startLine only).
  recovery: [
    { kind: 'function', regex: '^export\\s+default\\s+(?:async\\s+)?function\\s*\\*?\\s*([A-Za-z_$][\\w$]*)' },
    { kind: 'component', regex: '^export\\s+default\\s+(?:abstract\\s+)?class\\s+([A-Z][\\w$]*)' },
    { kind: 'class', regex: '^export\\s+default\\s+(?:abstract\\s+)?class\\s+([A-Za-z_$][\\w$]*)' },
    { kind: 'function', regex: '^(?:export\\s+)?(?:async\\s+)?function\\s*\\*?\\s*([A-Za-z_$][\\w$]*)' },
    { kind: 'class', regex: '^(?:export\\s+)?(?:abstract\\s+)?class\\s+([A-Za-z_$][\\w$]*)' },
    { kind: 'interface', regex: '^export\\s+interface\\s+([A-Za-z_$][\\w$]*)' },
    { kind: 'type', regex: '^(?:export\\s+)?type\\s+([A-Za-z_$][\\w$]*)\\s*=' },
    { kind: 'enum', regex: '^(?:export\\s+)?(?:const\\s+)?enum\\s+([A-Za-z_$][\\w$]*)' },
    { kind: 'constant', regex: '^export\\s+const\\s+([A-Za-z_$][\\w$]*)\\s*=' },
  ],
  isExported,
};

export default spec;

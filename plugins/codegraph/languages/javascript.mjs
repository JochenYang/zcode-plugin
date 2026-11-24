// JavaScript LanguageSpec (CONTRACTS.md §5). Same rule shape as typescript.mjs but
// declared independently: the JS grammar has no TS node types (interface, type_alias,
// required_parameter...) and `extends: 'typescript'` would emit "absent node type"
// warnings for every one of them.
const quote = (s) => String(s ?? '').trim().replace(/^["'`]|["'`]$/g, '');

const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'generator_function']);
const pascal = (name) => /^[A-Z]/.test(name);
const STATEMENT_SCOPES = new Set(['program', 'statement_block', 'class_body', 'switch_body', 'declaration', 'do_statement', 'for_statement', 'while_statement', 'if_statement']);

// Top-level const/let/var and function-valued declarators become symbols; locals stay
// out of the index (they would drown search results without helping navigation).
function declaratorKind(node, ctx) {
  const name = ctx.text(node.childForFieldName('name'));
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null; // destructuring patterns are not single symbols
  const value = node.childForFieldName('value');
  if (value && FUNCTION_VALUES.has(value.type)) return pascal(name) ? 'component' : 'function';
  if (value?.type === 'class') return 'class';
  const decl = node.parent; // lexical_declaration (const/let) | variable_declaration (var) | for_statement ...
  if (decl?.type !== 'lexical_declaration' && decl?.type !== 'variable_declaration') return null;
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

const calleeText = (node, ctx) => ctx.text(ctx.field(node, 'function'));
const callsLike = (name) => (node, ctx) => calleeText(node, ctx) === name;
const firstStringArg = (node) => quote(node.childForFieldName('arguments')?.namedChildren?.[0]?.text);
// `require()` / dynamic `import()` are module edges, not calls.
const isPlainCall = (node, ctx) => {
  const fn = calleeText(node, ctx);
  return fn !== 'require' && fn !== 'import';
};

// CommonJS: `exports.name = ...` / `module.exports.name = ...` publishes a binding.
function isExportsAssignment(node) {
  const left = node.childForFieldName('left');
  if (left?.type !== 'member_expression') return false;
  const obj = left.childForFieldName('object');
  if (obj?.type === 'identifier') return obj.text === 'exports';
  if (obj?.type !== 'member_expression') return false;
  const inner = obj.childForFieldName('object');
  return inner?.type === 'identifier' && inner.text === 'module' && obj.childForFieldName('property')?.text === 'exports';
}
const exportsName = (node) => node.childForFieldName('left')?.childForFieldName('property');

// Host formats (Svelte / Astro / Vue / Razor) embed scripts in HTML-ish `<script>` tags.
// The text between the tags is returned verbatim together with its absolute 1-based line,
// so inner symbols land on the right file lines and keep their columns. `lang="ts"` and
// `lang="tsx"` select their pack; anything else uses `defaultLang`.
export function scriptBlocks(source, { defaultLang = 'javascript' } = {}) {
  const blocks = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const m of source.matchAll(re)) {
    const attrs = m[1];
    if (/(?:^|\s)src\s*=/i.test(attrs)) continue; // external file, nothing embedded
    const text = m[2];
    if (!text.trim()) continue;
    const lang = /(?:^|\s)lang\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const value = (lang ? lang[1] ?? lang[2] ?? lang[3] : '')?.toLowerCase();
    const start = m.index + 7 + attrs.length + 1; // "<script" + attributes + ">"
    const startLine = source.slice(0, start).split('\n').length;
    const body = text.trimEnd();
    const endLine = startLine + (body.match(/\n/g) ?? []).length;
    blocks.push({ text, startLine, endLine, lang: { ts: 'typescript', tsx: 'tsx' }[value] ?? defaultLang });
  }
  return blocks;
}

// One embedding entry per target pack: the engine resolves `lang` statically, so the
// host declares one extractor per language and each returns only the blocks it owns.
export const onlyLang = (lang) => (source) => scriptBlocks(source).filter((b) => b.lang === lang);

// Parameter names, binding positions and host-element JSX tags are not references.
// The capture must sit on the inner identifier (the engine consumes only captured
// nodes). Patterns that contain `@skip` are passed to the query verbatim, and a
// trailing predicate is silently ignored once patterns are joined with newlines, so
// the `#match?` has to live inside the grouping parentheses. It reads the alias
// capture `@tag` because `@skip` would be ambiguous inside the same group.
const jsxHostTag = (el) => `((${el} name: (identifier) @skip @tag) (#match? @tag "^[a-z]"))`;
export const JSX_HOST_TAG_PATTERNS = ['jsx_opening_element', 'jsx_closing_element', 'jsx_self_closing_element'].map(jsxHostTag);
const skipPatterns = [
  '(formal_parameters (identifier) @skip)',
  '(formal_parameters (assignment_pattern left: (identifier) @skip))',
  '(object_pattern (pair_pattern value: (identifier) @skip))',
  '(array_pattern (identifier) @skip)',
  ...JSX_HOST_TAG_PATTERNS,
];

const spec = {
  id: 'javascript',
  label: 'JavaScript',
  extensions: ['.js', '.jsx', '.mjs', '.cjs'],
  grammar: 'javascript',
  support: 'full',
  scope: 'locals',
  commentTypes: ['comment'],
  transparentAncestors: ['export_statement'],
  definitions: {
    function_declaration: { kind: 'function', name: 'name', signature: ['parameters'] },
    generator_function_declaration: { kind: 'function', name: 'name', signature: ['parameters'] },
    class_declaration: { kind: 'class', name: 'name' },
    method_definition: { kind: 'method', name: 'name', signature: ['parameters'] },
    field_definition: { kind: 'field', name: 'property' },
    variable_declarator: { kind: declaratorKind, name: 'name', when: (n, ctx) => declaratorKind(n, ctx) !== null, doc: { from: declaratorDoc } },
    assignment_expression: { kind: 'constant', name: exportsName, when: isExportsAssignment },
  },
  calls: [
    { node: 'call_expression', fn: 'function', when: isPlainCall },
    { node: 'new_expression', fn: 'constructor' },
  ],
  imports: [
    { node: 'import_statement', kind: 'import', spec: (n, ctx) => quote(ctx.text(ctx.field(n, 'source'))), names: importNames },
    { node: 'export_statement', kind: 'reexport', when: (n) => n.childForFieldName('source') !== null, spec: (n, ctx) => quote(ctx.text(ctx.field(n, 'source'))) },
    { node: 'call_expression', kind: 'require', when: callsLike('require'), spec: firstStringArg },
    { node: 'call_expression', kind: 'dynamic', when: callsLike('import'), spec: firstStringArg },
  ],
  references: [{ node: 'identifier' }],
  skipPatterns,
  // Re-cover top-level definitions swallowed by ERROR nodes (same mechanism as the TypeScript pack).
  recovery: [
    { kind: 'function', regex: '^export\\s+default\\s+(?:async\\s+)?function\\s*\\*?\\s*([A-Za-z_$][\\w$]*)' },
    { kind: 'class', regex: '^export\\s+default\\s+class\\s+([A-Za-z_$][\\w$]*)' },
    { kind: 'function', regex: '^(?:export\\s+)?(?:async\\s+)?function\\s*\\*?\\s*([A-Za-z_$][\\w$]*)' },
    { kind: 'class', regex: '^(?:export\\s+)?class\\s+([A-Za-z_$][\\w$]*)' },
    { kind: 'constant', regex: '^export\\s+const\\s+([A-Za-z_$][\\w$]*)\\s*=' },
    { kind: 'constant', regex: '^module\\.exports\\.([A-Za-z_$][\\w$]*)\\s*=' },
  ],
  isExported,
};

export default spec;

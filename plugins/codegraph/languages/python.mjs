// Python pack (CONTRACTS.md §5). Node names and fields verified against the
// bundled tree-sitter-python wasm with bin/ast.mjs.
const field = (n, f) => n.childForFieldName(f);

// Carries no meaning as a reference. Filtered in postProcess because the engine's
// skipPatterns consume the node the `@skip` capture sits on (parameter names),
// so a text predicate on identifiers cannot be expressed as a query pattern.
const NOT_A_REFERENCE = /^(?:_|self|cls)$/;

// `import a.b` -> spec `a.b`, name `a`; `import a.b as c` -> spec `a.b`, alias `c`.
function importSpec(node, ctx) {
  const item = node.namedChildren[0];
  if (!item) return null;
  const mod = item.type === 'aliased_import' ? field(item, 'name') : item;
  return mod ? ctx.text(mod) || null : null;
}

function importNames(node, ctx) {
  const out = [];
  for (const item of node.namedChildren) {
    if (item.type === 'aliased_import') {
      const alias = field(item, 'alias');
      out.push({ imported: '*', alias: alias ? ctx.text(alias) : '' });
    } else if (item.type === 'dotted_name') {
      const root = item.namedChildren.find((c) => c.type === 'identifier');
      const name = root ? ctx.text(root) : ctx.text(item);
      out.push({ imported: name, alias: name });
    }
  }
  return out.length ? out : null;
}

// `from .pkg import X as Y, Z, *`: the module keeps its leading dots.
function fromImportSpec(node, ctx) {
  const mod = field(node, 'module_name');
  return mod ? ctx.text(mod) || null : null;
}

function fromImportNames(node, ctx) {
  const mod = field(node, 'module_name');
  const out = [];
  // Node objects are not identity-stable in web-tree-sitter; compare by id.
  for (const c of node.namedChildren) {
    if (mod && c.id === mod.id) continue;
    if (c.type === 'wildcard_import') out.push({ imported: '*', alias: '*' });
    else if (c.type === 'aliased_import') {
      const name = ctx.text(field(c, 'name'));
      const alias = field(c, 'alias');
      out.push({ imported: name, alias: alias ? ctx.text(alias) : name });
    } else if (c.type === 'dotted_name') {
      out.push({ imported: c.text, alias: c.text });
    }
  }
  return out.length ? out : null;
}

// Module-level `NAME = value` (also annotated `NAME: T = value`); locals and
// attribute/subscript targets are not symbols. Written as a type chain because
// `ctx.isTopLevel` compares Node objects by identity and web-tree-sitter hands
// out a fresh object per access, so it never sees the root.
function isModuleConstant(node) {
  return (
    field(node, 'left')?.type === 'identifier' &&
    node.parent?.type === 'expression_statement' &&
    node.parent.parent?.type === 'module'
  );
}

// `type Alias[T] = ...`: the first child is the `type` node holding the alias name.
function typeAliasName(node, ctx) {
  const lhs = node.namedChildren[0];
  const id = lhs?.namedChildren.find((c) => c.type === 'identifier') ?? lhs?.namedChildren[0];
  if (!id) return null;
  ctx.consume(id);
  return ctx.text(id) || null;
}

// `(self, x: float) -> float`: the engine's field join would print `) float`.
function functionSignature(node, ctx) {
  const params = field(node, 'parameters');
  const ret = field(node, 'return_type');
  const head = params ? ctx.text(params) : '()';
  return ret ? `${head} -> ${ctx.text(ret)}` : head;
}

// Python's only visibility convention is the leading underscore; `__all__` and dunder methods are private too.
const isExported = (_node, sym) => !sym.name.startsWith('_');

const spec = {
  id: 'python',
  label: 'Python',
  extensions: ['.py', '.pyi'],
  grammar: 'python',
  support: 'full',
  commentTypes: ['comment'],
  // `expression_statement` wraps every simple statement; a module-level assignment
  // is the statement's only child, so treat the wrapper as transparent.
  transparentAncestors: ['expression_statement'],
  definitions: {
    function_definition: {
      kind: 'function', name: 'name', signature: functionSignature, doc: { from: 'bodyFirstString' },
    },
    class_definition: { kind: 'class', name: 'name', doc: { from: 'bodyFirstString' } },
    assignment: { kind: 'constant', name: 'left', when: isModuleConstant },
    type_alias_statement: { kind: 'type', name: typeAliasName },
  },
  calls: [{ node: 'call', fn: 'function' }],
  imports: [
    { node: 'import_statement', kind: 'import', spec: importSpec, names: importNames },
    { node: 'import_from_statement', kind: 'from', spec: fromImportSpec, names: fromImportNames },
  ],
  references: [{ node: 'identifier' }],
  isExported,
  hooks: {
    postProcess(out) {
      out.refs = out.refs.filter((r) => !(r.kind === 'ref' && NOT_A_REFERENCE.test(r.name)));
    },
  },
};

export default spec;

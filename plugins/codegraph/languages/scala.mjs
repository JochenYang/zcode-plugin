// Language pack id must equal the file name (registry.mjs). See CONTRACTS.md §5.
//
// tree-sitter-scala 0.19 notes (checked with bin/ast.mjs):
// - Field names exist: `name`, `parameters`, `return_type`, `body`, `pattern`, `path`, `function`.
// - `def f: T` without a body is `function_declaration`; with a body it is `function_definition`.
// - `items.map(...)` is `call_expression` > `function: field_expression(value, field)`; `Map.empty[T]`
//   (no parens) is `generic_function`.
// - `val`/`var` also appear for locals inside blocks; only declaration-level ones become symbols.
// - Symbolic method names (`def +(other)`) are not supported by this grammar version (ERROR node).

const consumeAll = (node, ctx, types) => {
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (types.includes(n.type)) ctx.consume(n);
    for (const c of n.namedChildren) stack.push(c);
  }
};

// Scala is public by default; `private` (with or without a qualifier) is the only hiding modifier.
function isExported(node) {
  const mods = node.namedChildren.find((c) => c.type === 'modifiers');
  return !mods || !/\bprivate\b/.test(mods.text);
}

function packageName(node, ctx) {
  const path = node.childForFieldName('name');
  if (path) consumeAll(path, ctx, ['identifier']);
  return path;
}

// `import a.b.{C, D => E}` -> spec `a.b`, names C->C, D->E; `import a.b._` -> spec `a.b` + wildcard.
const importPath = (node) => node.childForFieldName('path')?.text ?? '';
const importSpec = (node) => importPath(node);

function importNames(node) {
  const selectors = node.namedChildren.find((c) => c.type === 'import_selectors');
  if (selectors) {
    return selectors.namedChildren.map((s) => {
      if (s.type === 'renamed_identifier') {
        return { imported: s.childForFieldName('name')?.text, alias: s.childForFieldName('alias')?.text };
      }
      return { imported: s.text, alias: s.text };
    });
  }
  if (node.namedChildren.some((c) => c.type === 'wildcard')) return [{ imported: '*', alias: '*' }];
  const last = importPath(node).split('.').pop();
  return last ? [{ imported: last, alias: last }] : null;
}

// `obj.m(...)` -> name `m`, receiver `obj`; `f(...)` -> name `f`.
function callName(node, ctx) {
  const fn = node.childForFieldName('function');
  if (!fn) return null;
  if (fn.type === 'field_expression') {
    const name = fn.childForFieldName('field');
    if (name) ctx.consume(name); // the call ref already represents the name
    return { name: ctx.text(name), receiver: ctx.text(fn.childForFieldName('value')) };
  }
  if (fn.type === 'identifier') ctx.consume(fn);
  return ctx.text(fn);
}

const skipPatterns = [
  '(class_parameter name: (identifier) @skip)',
  '(parameter name: (identifier) @skip)',
  '(val_definition pattern: (identifier) @skip)',
  '(var_definition pattern: (identifier) @skip)',
];

const DECLARATION = new Set(['compilation_unit', 'template_body']);

export default {
  id: 'scala',
  label: 'Scala',
  extensions: ['.scala', '.sc'],
  grammar: 'scala',
  support: 'full',
  commentTypes: ['comment'],
  transparentAncestors: [],
  definitions: {
    package_clause: { kind: 'namespace', name: packageName },
    function_definition: { kind: 'function', name: 'name', signature: ['parameters', 'return_type'] },
    function_declaration: { kind: 'function', name: 'name', signature: ['parameters', 'return_type'] },
    class_definition: { kind: 'class', name: 'name' },
    trait_definition: { kind: 'trait', name: 'name' },
    object_definition: { kind: 'object', name: 'name' },
    type_definition: { kind: 'type', name: 'name' },
    val_definition: { kind: 'constant', name: 'pattern', when: (node) => DECLARATION.has(node.parent?.type) },
    var_definition: { kind: 'variable', name: 'pattern', when: (node) => DECLARATION.has(node.parent?.type) },
  },
  calls: [
    { node: 'call_expression', fn: callName },
    { node: 'generic_function', fn: callName },
  ],
  imports: [{ node: 'import_declaration', kind: 'import', spec: importSpec, names: importNames }],
  references: [{ node: 'identifier' }, { node: 'type_identifier', kind: 'type' }],
  skipPatterns,
  isExported,
  embeddings: [],
  hooks: {},
};

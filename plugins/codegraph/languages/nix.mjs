// Nix pack (CONTRACTS.md §5). Grammar: nix-community/tree-sitter-nix (ABI 15 build).
// Everything is an expression: `binding` (attrpath = rhs) covers `let` and attrset members,
// `apply_expression` is the only call form, and `import <path>` is an apply whose `function` is the
// identifier `import`. `formals`/`universal` parameters and attrpath identifiers are not refs.
const IMPORT_NAMES = new Set(['import', 'builtins.import']);

const fnNode = (node) => node.childForFieldName('function');
// Applications are curried: `f a b` is `(f a) b`. Every application shares one head, so only the
// outermost apply is recorded and it is named after that head.
const headOf = (node) => {
  let fn = fnNode(node);
  while (fn?.type === 'apply_expression') fn = fnNode(fn);
  return fn;
};
const isApplicationHead = (node) => node.parent?.type === 'apply_expression' && fnNode(node.parent)?.id === node.id;
const isImportApply = (node) => {
  const head = headOf(node);
  return head?.type === 'variable_expression' && IMPORT_NAMES.has(head.text);
};
// `import <nixpkgs> { }` imports the path (the inner argument), then calls the result.
const importArgument = (node) => (fnNode(node)?.type === 'apply_expression' ? fnNode(node) : node).childForFieldName('argument');
const isCall = (node) => !isImportApply(node) && !isApplicationHead(node);
const isImport = (node) => isImportApply(node) && !isApplicationHead(node);
const importSpec = (node) => importArgument(node)?.text.trim() ?? null;

const rhsKind = (node) => {
  const rhs = node.childForFieldName('expression');
  if (rhs?.type === 'function_expression') return 'function';
  if (rhs?.type === 'attrset_expression') return 'type';
  return 'variable';
};
const attrpathName = (node) => node.childForFieldName('attrpath')?.text.trim() ?? null;

// Attrsets passed as call arguments (`mkDerivation { name = ...; }`) are parameters, not
// definitions worth indexing; only `let` bindings and attrset members become symbols.
// web-tree-sitter hands out fresh wrappers for every lookup, so compare node ids, not objects.
const isArgumentAttrset = (attrset) => attrset?.parent?.childForFieldName('argument')?.id === attrset?.id;
const isIndexableBinding = (node) => !isArgumentAttrset(node.parent?.parent);

export default {
  id: 'nix',
  label: 'Nix',
  extensions: ['.nix'],
  grammar: 'nix',
  support: 'full',
  commentTypes: ['comment'],
  definitions: {
    binding: { kind: rhsKind, name: attrpathName, when: isIndexableBinding },
  },
  calls: [{ node: 'apply_expression', fn: headOf, when: isCall }],
  imports: [{ node: 'apply_expression', kind: 'import', when: isImport, spec: importSpec }],
  references: [{ node: 'identifier' }],
  skipPatterns: [
    '(attrpath (identifier) @skip)',
    '(inherited_attrs (identifier) @skip)',
    '(formal name: (identifier) @skip)',
    '(function_expression universal: (identifier) @skip)',
  ],
};

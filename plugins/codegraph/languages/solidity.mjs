// Solidity pack (CONTRACTS.md §5). Grammar: JoranHonig/tree-sitter-solidity (2020 snapshot),
// node types confirmed with bin/ast.mjs: `error_definition` is `error_declaration` there,
// `new X()` is a call_expression whose `function` is a `new_expression`, and `constant` state
// variables stay `state_variable_declaration` (only file-level constants get `constant_variable_declaration`).
const stripQuotes = (s) => String(s ?? '').trim().replace(/^["']|["']$/g, '');

const INTERNAL_VISIBILITIES = new Set(['private', 'internal']);
const NEW_CALLEE_TYPES = new Set(['new_expression', 'struct_expression']);
const EXPORTED_KINDS = new Set(['class', 'interface', 'constant']);

// `function f(uint a) external view returns (bool)`: parameters are unlabelled `parameter`
// children, so the signature is assembled from named children rather than field paths.
function functionSignature(node) {
  const parts = [];
  for (const c of node.namedChildren) {
    if (c.type === 'parameter') parts.push(c.text);
  }
  const modifiers = node.namedChildren
    .filter((c) => c.type === 'visibility' || c.type === 'state_mutability')
    .map((c) => c.text);
  const ret = node.childForFieldName('return_type_definition');
  return [`(${parts.join(', ')})`, ...modifiers, ret?.text].filter(Boolean).join(' ');
}

// `fallback()`/`receive()` carry no name field; the keyword is the first anonymous child.
const fallbackName = (node) => node.children.find((c) => c.type === 'fallback' || c.type === 'receive')?.text ?? null;

const stateVariableKind = (node) => (/\bconstant\b/.test(node.text) ? 'constant' : 'field');

const isPlainCall = (node, ctx) => !NEW_CALLEE_TYPES.has(ctx.field(node, 'function')?.type);
// `new Vault{value: 1}()` is a struct_expression wrapping the new_expression; count it once.
const isNewStandalone = (node) => node.parent?.type !== 'struct_expression';
const newTypeName = (node, ctx) => ctx.text(ctx.field(node, 'name'));
const structNewName = (node, ctx) => ctx.text(ctx.field(ctx.field(node, 'type'), 'name'));
const isStructNew = (node, ctx) => ctx.field(node, 'type')?.type === 'new_expression';

// The grammar collapses `import {A} from` and `import "x" as A` to the same `import_name` field;
// only the source text tells them apart.
function importNames(node) {
  const aliases = node.namedChildren.filter((c) => c.type === 'symbol_alias' || c.type === 'import_alias');
  if (aliases.length) {
    return aliases.map((a) => {
      const ids = a.namedChildren.filter((c) => c.type === 'identifier').map((c) => c.text);
      return { imported: ids[0], alias: ids[ids.length - 1] };
    });
  }
  const name = node.childForFieldName('import_name');
  if (!name) return null;
  const named = /\{/.test(node.text);
  return [{ imported: named ? name.text : '*', alias: name.text }];
}

// Visibility is explicit on members; file-level functions default to public (exported).
function isExported(node, sym) {
  if (EXPORTED_KINDS.has(sym.kind)) return true;
  if (sym.kind === 'function' || sym.kind === 'method') {
    const vis = node.namedChildren.find((c) => c.type === 'visibility');
    if (!vis) return node.type !== 'modifier_definition';
    return !INTERNAL_VISIBILITIES.has(vis.text);
  }
  if (sym.kind === 'field' || sym.kind === 'constant') {
    const vis = node.namedChildren.find((c) => c.type === 'visibility');
    return vis?.text === 'public';
  }
  if (sym.kind === 'macro') return false;
  return null;
}

export default {
  id: 'solidity',
  label: 'Solidity',
  extensions: ['.sol'],
  grammar: 'solidity',
  support: 'full',
  commentTypes: ['comment'],
  definitions: {
    contract_declaration: { kind: 'class', name: 'name' },
    library_declaration: { kind: 'class', name: 'name' },
    interface_declaration: { kind: 'interface', name: 'name' },
    function_definition: { kind: 'function', name: 'name', signature: functionSignature },
    fallback_receive_definition: { kind: 'function', name: fallbackName, signature: functionSignature },
    modifier_definition: { kind: 'macro', name: 'name', signature: functionSignature },
    event_definition: { kind: 'other', name: 'name' },
    error_declaration: { kind: 'other', name: 'name' },
    struct_declaration: { kind: 'struct', name: 'name' },
    enum_declaration: { kind: 'enum', name: 'name' },
    state_variable_declaration: { kind: stateVariableKind, name: 'name' },
    constant_variable_declaration: { kind: 'constant', name: 'name' },
  },
  calls: [
    { node: 'call_expression', fn: 'function', when: isPlainCall },
    { node: 'new_expression', fn: newTypeName, when: isNewStandalone },
    { node: 'struct_expression', fn: structNewName, when: isStructNew },
    { node: 'emit_statement', fn: 'name' },
  ],
  imports: [
    {
      node: 'import_directive',
      kind: 'import',
      spec: (n, ctx) => stripQuotes(ctx.text(ctx.field(n, 'source'))),
      names: importNames,
    },
  ],
  references: [{ node: 'identifier' }, { node: 'user_defined_type', kind: 'type' }],
  // Skip patterns are full query patterns whose `@skip` capture sits on the identifier to hide
  // (the engine uses a pattern verbatim when it already carries `@skip`). The first one is rooted
  // at `_` so the `user_defined_type` itself is not captured and still becomes a `type` ref.
  skipPatterns: [
    '(_ (user_defined_type (identifier) @skip))',
    '(parameter name: (identifier) @skip)',
    '(event_paramater name: (identifier) @skip)',
    '(error_parameter name: (identifier) @skip)',
    '(struct_member name: (identifier) @skip)',
    '(variable_declaration name: (identifier) @skip)',
  ],
  isExported,
};

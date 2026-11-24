// Luau pack: the Lua rules plus type definitions. Verified against the bundled
// tree-sitter-luau 1.2.0 wasm with bin/ast.mjs:
// - `export type X = ...` and `type X = ...` are both `type_definition` (the `export`
//   keyword is an anonymous token inside the node), so export state is read from text.
// - `export function` is not accepted by this grammar (it yields an ERROR node), so
//   functions are never marked exported.
const field = (n, f) => n.childForFieldName(f);

// `type Callback<T> = ...` names the alias inside a `generic_type` node.
function typeName(node, ctx) {
  const name = field(node, 'name');
  if (!name) return null;
  const id = name.type === 'identifier' ? name : name.namedChildren.find((c) => c.type === 'identifier');
  if (!id) return null;
  ctx.consume(id); // the alias name is the symbol, not a reference to it
  return ctx.text(id) || null;
}

const isExported = (node) => (node.type === 'type_definition' ? /^export\s/.test(node.text) : null);

const spec = {
  id: 'luau',
  label: 'Luau',
  extensions: ['.luau'],
  grammar: 'luau',
  extends: 'lua',
  definitions: {
    type_definition: { kind: 'type', name: typeName },
  },
  isExported,
};

export default spec;

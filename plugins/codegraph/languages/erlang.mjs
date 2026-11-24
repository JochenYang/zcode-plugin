// Erlang pack (CONTRACTS.md §5). Grammar: WhatsApp/tree-sitter-erlang.
// Node types confirmed with bin/ast.mjs: functions are `fun_decl > function_clause` (one fun_decl
// per clause, so multi-clause functions are merged by name/arity in postProcess), calls are `call`
// (local) and `remote` (module:fun), types are `type_alias`/`opaque`, macros `pp_define`, and the
// include forms are `pp_include`/`pp_include_lib`. Atoms are far too noisy as refs, so only `var`
// nodes are referenced.
const stripQuotes = (s) => String(s ?? '').trim().replace(/^["']|["']$/g, '');

const clauseOf = (node) => (node.type === 'fun_decl' ? node.childForFieldName('clause') : node);

function arityOf(node) {
  const args = clauseOf(node)?.childForFieldName('args');
  return args ? args.namedChildren.length : 0;
}

const functionName = (node) => clauseOf(node)?.childForFieldName('name')?.text ?? null;
const functionSignature = (node) => `${functionName(node)}/${arityOf(node)}`;
const typeName = (node) => node.childForFieldName('name')?.childForFieldName('name')?.text ?? null;

// `%% @doc Text` is the Edoc form; strip the markers the engine's default stripper leaves behind.
function erlangDoc(node) {
  const prev = node.previousNamedSibling ?? node.previousSibling;
  if (!prev || prev.type !== 'comment') return null;
  if (node.startPosition.row - prev.endPosition.row > 2) return null;
  const text = prev.text
    .replace(/^\s*%+\s*(?:@doc\s*)?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

const TYPE_NODES = new Set(['type_alias', 'opaque', 'spec', 'field_type', 'record_field', 'record_decl', 'type_name', 'type_sig']);
// Types contain calls too (`integer()`, `dict:dict()`); they are not code calls.
const inTypeContext = (node) => {
  for (let n = node; n; n = n.parent) if (TYPE_NODES.has(n.type)) return true;
  return false;
};

// The grammar's `remote_module` atom text includes the trailing colon (`gen_server:`).
const remoteCall = (node) => {
  const fun = node.childForFieldName('fun');
  return { name: fun?.childForFieldName('expr')?.text ?? '', receiver: (node.childForFieldName('module')?.text ?? '').replace(/:$/, '') };
};
const isLocalCall = (node) => node.parent?.type !== 'remote' && !inTypeContext(node);
const isRemoteCall = (node) => !inTypeContext(node);

const importNames = (node) =>
  node.namedChildren
    .filter((c) => c.type === 'fa')
    .map((fa) => ({ imported: fa.childForFieldName('fun')?.text ?? '', alias: fa.childForFieldName('fun')?.text ?? '' }));

const arityKey = (sym) => `${sym.name}/${sym.signature?.slice(sym.signature.lastIndexOf('/') + 1)}`;

// Clauses of one function arrive as separate `fun_decl` symbols; keep the first and stretch it to
// the last clause so the outline shows `deposit/2 22-26`. `exported` comes from `-export([...])`.
function postProcess(out, ctx) {
  const exported = new Set();
  const stack = [ctx.tree.rootNode];
  while (stack.length) {
    const node = stack.pop();
    for (const c of node.namedChildren) stack.push(c);
    if (node.type !== 'export_attribute') continue;
    for (const fa of node.namedChildren) {
      if (fa.type === 'fa') exported.add(`${fa.childForFieldName('fun')?.text}/${fa.childForFieldName('arity')?.childForFieldName('value')?.text}`);
    }
  }
  const first = new Map();
  out.symbols = out.symbols.filter((sym) => {
    if (sym.kind !== 'function') return true;
    const key = arityKey(sym);
    const head = first.get(key);
    if (!head) {
      first.set(key, sym);
      return true;
    }
    if (sym.endLine > head.endLine) head.endLine = sym.endLine;
    return false;
  });
  for (const sym of out.symbols) if (sym.kind === 'function') sym.exported = exported.has(arityKey(sym));
}

export default {
  id: 'erlang',
  label: 'Erlang',
  extensions: ['.erl', '.hrl', '.escript', '.app.src', '.app'],
  grammar: 'erlang',
  support: 'full',
  commentTypes: ['comment'],
  definitions: {
    module_attribute: { kind: 'module', name: 'name' },
    fun_decl: { kind: 'function', name: functionName, signature: functionSignature, doc: { from: erlangDoc } },
    record_decl: { kind: 'struct', name: 'name', doc: { from: erlangDoc } },
    record_field: { kind: 'field', name: 'name', when: (n) => n.parent?.type === 'record_decl' },
    type_alias: { kind: 'type', name: typeName, doc: { from: erlangDoc } },
    opaque: { kind: 'type', name: typeName, doc: { from: erlangDoc } },
    pp_define: { kind: 'macro', name: (n) => n.childForFieldName('lhs')?.childForFieldName('name')?.text ?? null },
  },
  calls: [
    { node: 'remote', fn: remoteCall, when: isRemoteCall },
    { node: 'call', fn: 'expr', when: isLocalCall },
  ],
  imports: [
    { node: 'import_attribute', kind: 'import', spec: (n) => n.childForFieldName('module')?.text ?? null, names: importNames },
    { node: 'pp_include_lib', kind: 'include', spec: (n) => stripQuotes(n.childForFieldName('file')?.text) },
    { node: 'pp_include', kind: 'include', spec: (n) => stripQuotes(n.childForFieldName('file')?.text) },
  ],
  references: [{ node: 'var' }],
  // The macro's own name (`-define(MAX_FEE, 1)`) is a definition, not a use.
  skipPatterns: ['(pp_define lhs: (macro_lhs (var) @skip))'],
  hooks: { postProcess },
};

// Lua pack (CONTRACTS.md §5). Node names and fields verified against the bundled
// tree-sitter-lua (Azganoth, ABI 15) wasm with bin/ast.mjs. Luau extends this file.
const field = (n, f) => n.childForFieldName(f);

// `f()`, `a.b.f()`, `obj:m()`: name plus receiver text. `tbl["k"]()`, `(f)()` are dynamic.
function callee(node, ctx) {
  if (!node) return null;
  if (node.type === 'identifier') return ctx.text(node);
  if (node.type === 'dot_index_expression') return ctx.text(field(node, 'field'));
  if (node.type === 'method_index_expression') return ctx.text(field(node, 'method'));
  return null;
}

function callTarget(node, ctx) {
  const name = field(node, 'name');
  if (!name) return null;
  if (name.type === 'dot_index_expression' || name.type === 'method_index_expression') {
    const part = field(name, 'field') ?? field(name, 'method');
    const table = field(name, 'table');
    return { name: ctx.text(part), receiver: ctx.text(table) };
  }
  return name.type === 'identifier' ? { name: ctx.text(name), receiver: '' } : null;
}

const isRequire = (node, ctx) => callee(field(node, 'name'), ctx) === 'require';
// Calls are evaluated before imports by the engine, so require must opt out of the call rule.
const isPlainCall = (node, ctx) => !isRequire(node, ctx);

function requireSpec(node, ctx) {
  const first = field(node, 'arguments')?.namedChildren?.[0];
  return first?.type === 'string' ? luaString(first, ctx) || null : null;
}

// Lua strings carry their quotes (`"x"`, `'x'`, `[[x]]`, `[=[x]=]`).
function luaString(node, ctx) {
  const raw = ctx.text(node).trim();
  const long = /^\[(=*)\[([\s\S]*)\]\1\]$/.exec(raw);
  if (long) return long[2];
  return raw.replace(/^["']|["']$/g, '');
}

// `function M.f` / `function M:m` / `function f` / `local function f`.
function functionName(node, ctx) {
  return callee(field(node, 'name'), ctx);
}

const functionKind = (node) => (field(node, 'name')?.type === 'method_index_expression' ? 'method' : 'function');

// `local x = ..` declares one symbol; `local a, b = ..` has no single name and is skipped.
function declaredVariable(node, ctx) {
  const stmt = node.namedChildren.find((c) => c.type === 'assignment_statement') ?? node;
  const list = stmt.namedChildren.find((c) => c.type === 'variable_list');
  const names = (list?.namedChildren ?? []).filter((c) => c.type === 'identifier');
  if (names.length !== 1) return null;
  ctx.consume(names[0]);
  return ctx.text(names[0]) || null;
}

// SCREAMING_SNAKE locals are constants by convention (`M`/`Vector` are module tables).
const variableKind = (node, ctx) => (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(declaredVariable(node, ctx) ?? '') ? 'constant' : 'variable');

// Lua scope: only chunk-level locals are symbols; locals inside functions stay out.
function isChunkLevel(node) {
  return node.parent?.type === 'chunk';
}

// Comments: `--`, LDoc `---`, or block `--[[ ]]`; each line is its own node.
function commentBlock(node, ctx) {
  const lines = [];
  let prev = node.previousNamedSibling;
  let row = node.startPosition.row;
  while (prev && prev.type === 'comment' && row - prev.endPosition.row <= 1) {
    const raw = ctx.text(prev);
    const block = /^--\[(=*)\[([\s\S]*)\]\1\]$/.exec(raw.trim());
    const line = (block ? block[2] : raw.replace(/^--+/, '')).trim();
    if (line) lines.unshift(line);
    row = prev.startPosition.row;
    prev = prev.previousNamedSibling;
  }
  return lines;
}

// LDoc prose: the lines before the first `@tag`.
function ldocDoc(node, ctx) {
  const prose = [];
  for (const line of commentBlock(node, ctx)) {
    if (line.startsWith('@')) break;
    prose.push(line);
  }
  return prose.length ? prose.join(' ') : null;
}

const documented = (rule) => ({ ...rule, doc: { from: ldocDoc } });

const spec = {
  id: 'lua',
  label: 'Lua',
  extensions: ['.lua'],
  grammar: 'lua',
  support: 'full',
  commentTypes: ['comment'],
  definitions: {
    function_declaration: documented({ kind: functionKind, name: functionName, signature: 'parameters' }),
    variable_declaration: documented({ kind: variableKind, name: declaredVariable, when: isChunkLevel }),
  },
  calls: [{ node: 'function_call', fn: callTarget, when: isPlainCall }],
  imports: [{ node: 'function_call', kind: 'require', when: isRequire, spec: requireSpec }],
  references: [{ node: 'identifier' }],
  isExported: null,
  hooks: {
    // `_` is the discard variable and `self` the implicit method receiver; neither is a symbol.
    postProcess(out) {
      out.refs = out.refs.filter((r) => !(r.kind === 'ref' && (r.name === '_' || r.name === 'self')));
    },
  },
};

export default spec;

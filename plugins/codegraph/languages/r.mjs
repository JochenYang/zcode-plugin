// R pack (CONTRACTS.md §5). Node names and fields verified against the bundled
// r-lib/tree-sitter-r wasm with bin/ast.mjs.
const field = (n, f) => n.childForFieldName(f);
const ASSIGN_OPS = new Set(['<-', '=', '<<-']);
const IMPORTS = new Set(['library', 'require', 'source']);
const stripQuotes = (s) => String(s ?? '').trim().replace(/^"|"$/g, '');
// `` `weird name` `` is a legal identifier; the backticks are quoting, not part of the name.
const unquote = (s) => String(s ?? '').replace(/^`|`$/g, '').trim();

// `f <- function(x) {...}`, `f = function(x) x`: the function_definition has no name
// field; the name is the lhs of the enclosing assignment. Anonymous functions
// (`sapply(x, function(i) ...)`, `error = function(e) e`) have no such parent.
function assignedName(node, ctx) {
  const p = node.parent;
  // Node objects are not identity-stable in web-tree-sitter; compare by id.
  if (!p || p.type !== 'binary_operator' || field(p, 'rhs')?.id !== node.id) return null;
  const op = field(p, 'operator');
  if (!op || !ASSIGN_OPS.has(op.text)) return null;
  const lhs = field(p, 'lhs');
  if (!lhs) return null;
  ctx.consume(lhs); // the assigned name is the symbol, not a reference to it
  if (lhs.type === 'string') return stripQuotes(ctx.text(lhs)) || null;
  return lhs.type === 'identifier' ? unquote(ctx.text(lhs)) || null : null;
}

const isNamedFunction = (node, ctx) => assignedName(node, ctx) !== null;

// Top-level `x <- value` that is not a function (`names(v) <- ..`, `v[1] <- ..` have
// call/subset left-hand sides and are skipped). SCREAMING_SNAKE names are constants.
function variableName(node, ctx) {
  if (node.parent?.type !== 'program') return null;
  const op = field(node, 'operator');
  if (!op || !ASSIGN_OPS.has(op.text)) return null;
  const lhs = field(node, 'lhs');
  const rhs = field(node, 'rhs');
  if (!lhs || lhs.type !== 'identifier' || !rhs || rhs.type === 'function_definition') return null;
  ctx.consume(lhs);
  return unquote(ctx.text(lhs)) || null;
}

const isTopLevelValue = (node, ctx) => variableName(node, ctx) !== null;
const variableKind = (node, ctx) => (/^[A-Z][A-Z0-9]*(?:[._][A-Z0-9]+)*$/.test(variableName(node, ctx) ?? '') ? 'constant' : 'variable');

// `f()`, `pkg::f()`, `l$method()`, `"f"(x)`; `(function(x) x)(1)` and `obj[[k]]()` are dynamic.
function callTarget(node, ctx) {
  const fn = field(node, 'function');
  if (!fn) return null;
  if (fn.type === 'identifier') return { name: unquote(ctx.text(fn)), receiver: '' };
  if (fn.type === 'string') return { name: stripQuotes(ctx.text(fn)), receiver: '' };
  if (fn.type === 'namespace_operator' || fn.type === 'extract_operator') {
    return { name: unquote(ctx.text(field(fn, 'rhs'))), receiver: unquote(ctx.text(field(fn, 'lhs'))) };
  }
  return null;
}

const isImport = (node, ctx) => {
  const fn = field(node, 'function');
  return fn?.type === 'identifier' && IMPORTS.has(fn.text);
};
// Calls are evaluated before imports by the engine, so library calls must opt out.
const isPlainCall = (node, ctx) => !isImport(node, ctx);

// `library(stats)`, `require("pkg")`, `source("file.R")`: the first argument is the spec.
function importSpec(node, ctx) {
  const first = field(node, 'arguments')?.namedChildren?.[0];
  const value = first?.type === 'argument' ? field(first, 'value') : first;
  if (!value) return null;
  if (value.type === 'string') return stripQuotes(ctx.text(value)) || null;
  return value.type === 'identifier' ? unquote(ctx.text(value)) || null : null;
}

// Roxygen: each `#'` line is its own comment node; the description is the prose
// before the first `@tag`. Plain `#` comments are not documentation.
function roxygenDoc(node, ctx) {
  const owner = node.parent?.type === 'binary_operator' ? node.parent : node;
  const lines = [];
  let prev = owner.previousNamedSibling;
  let row = owner.startPosition.row;
  while (prev && prev.type === 'comment' && row - prev.endPosition.row <= 1) {
    const text = ctx.text(prev);
    if (!/^#'/.test(text)) break;
    lines.unshift(text.replace(/^#'{1,2}/, '').trim());
    row = prev.startPosition.row;
    prev = prev.previousNamedSibling;
  }
  const prose = [];
  for (const line of lines) {
    if (line.startsWith('@')) break;
    if (line) prose.push(line);
  }
  const text = prose
    .join(' ')
    .replace(/\\(?:code|emph|strong)\{([^}]*)\}/g, '$1')
    .replace(/[`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

const spec = {
  id: 'r',
  label: 'R',
  extensions: ['.R'],
  grammar: 'r',
  support: 'full',
  commentTypes: ['comment'],
  definitions: {
    function_definition: { kind: 'function', name: assignedName, when: isNamedFunction, signature: 'parameters', doc: { from: roxygenDoc } },
    binary_operator: { kind: variableKind, name: variableName, when: isTopLevelValue },
  },
  calls: [{ node: 'call', fn: callTarget, when: isPlainCall }],
  imports: [{ node: 'call', kind: 'require', when: isImport, spec: importSpec }],
  references: [{ node: 'identifier' }],
  isExported: null,
};

export default spec;

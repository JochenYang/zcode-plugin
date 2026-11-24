// Scope-level reference resolution for packs with `scope: 'locals'` (JS/TS/Ruby).
// Runs inside the extraction worker, called by the engine (CONTRACTS.md §6/§8).
//
// The locals query tags three capture kinds: `@local.scope` (a node that opens a
// lexical scope), `@local.definition` (a name binding) and `@local.reference`
// (a name use). Captures come back in document order and a scope node always
// starts at or before everything it contains, so a stack of open scopes is all
// the structure that is needed.
//
// Two passes run over the same capture list: the first registers every
// definition in its innermost open scope, the second resolves references from
// the innermost scope outwards. One pass would miss hoisted function
// declarations (a use above the declaration in the same scope must still see
// the local instead of an import or a same-named global).
//
// A declaration whose scope node is the declaration itself (function, class,
// interface, enum, namespace) binds its name in the ENCLOSING scope: the name
// is visible outside, and the body still sees it through the parent chain.
//
// Only references that resolve to a local definition are returned. A definition
// that is an indexed symbol (it is the `name` of its declaration and that
// declaration is the symbol) yields `localDef = symbolIndex`; a plain local
// (parameter, let/const, catch, loop variable...) yields `localDef = null`,
// which the pipeline marks `?` without falling back to a global name. A local
// that merely shares its name with the enclosing function is not that symbol.
// References without a local binding are left to the pipeline (imports and
// unique-name rules).
//
// Binding occurrences of plain locals are reported too (with `localDef = null`),
// so the declaration name of a local never gets attached by name to an unrelated
// global symbol. Definitions that are indexed symbols are not reported: the
// engine consumed their name and a self-edge would only pollute callers.

import { initTreeSitter } from '../../grammars/loader.mjs';

// The engine initialises the runtime before importing this module, so this
// await resolves immediately in the normal flow; a direct import initialises
// the runtime itself. resolveLocals itself stays synchronous (frozen signature).
const { Query } = await initTreeSitter();

const SCOPE = 'local.scope';
const DEFINITION = 'local.definition';
const REFERENCE = 'local.reference';
const CAPTURE_RANK = { [SCOPE]: 0, [DEFINITION]: 1, [REFERENCE]: 2 };

const queryCache = new Map(); // queryText -> Query

function queryFor(language, queryText) {
  let query = queryCache.get(queryText);
  if (!query) {
    try {
      query = new Query(language, queryText);
    } catch (err) {
      throw new Error(`resolveLocals: locals query does not compile against "${language}": ${err?.message ?? err}`, { cause: err });
    }
    queryCache.set(queryText, query);
  }
  return query;
}

// Every tree-sitter property access crosses the wasm boundary, so positions are
// read once per capture and the walk works on plain numbers afterwards.
// Document order with deterministic tie-breaking: two nodes that start at the
// same position are nested (the wider one contains the other), so the wider
// goes first; a scope that starts on its own first token (method name, program
// starting with an identifier) is opened before that token is processed;
// definitions precede references of the same node.
function ordered(captures) {
  const entries = captures.map((capture, i) => {
    const start = capture.node.startPosition;
    const end = capture.node.endPosition;
    return {
      name: capture.name, node: capture.node, i,
      startRow: start.row, startCol: start.column, endRow: end.row, endCol: end.column,
      rank: CAPTURE_RANK[capture.name] ?? 3,
    };
  });
  entries.sort((a, b) =>
    a.startRow - b.startRow || a.startCol - b.startCol || b.endRow - a.endRow || b.endCol - a.endCol || a.rank - b.rank || a.i - b.i
  );
  return entries;
}

// Close every scope that ends at or before `entry` starts. End positions are
// exclusive, so a capture starting exactly at a scope's end is outside it.
function closeScopes(stack, entry) {
  while (stack.length > 1) {
    const top = stack[stack.length - 1];
    const inside = entry.startRow < top.endRow || (entry.startRow === top.endRow && entry.startCol < top.endCol);
    if (inside) break;
    stack.pop();
  }
}

// Position keys with the engine's containment rule (1-based line, 0-based
// column, end inclusive); a missing endCol means "to the end of endLine".
const LINE_SCALE = 1e6;
const positionKey = (line, col) => line * LINE_SCALE + col;

// Flat interval table of the file's symbols. Definitions nest, so the
// innermost symbol containing a position is the one with the greatest start
// among those containing it: binary-search the start, walk back only while a
// container is still possible (bounded by the largest symbol extent).
function symbolIndex(symbols) {
  const n = symbols.length;
  const start = new Float64Array(n);
  const end = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    start[i] = positionKey(symbols[i].startLine, symbols[i].startCol ?? 0);
    end[i] = positionKey(symbols[i].endLine, symbols[i].endCol ?? LINE_SCALE);
  }
  // Equal starts: the wider (outer) symbol sorts first so the backward walk in
  // enclosing() meets the inner one first.
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => start[a] - start[b] || end[b] - end[a]);
  const sortedStart = new Float64Array(n);
  let maxExtent = 0;
  for (let k = 0; k < n; k++) {
    const i = order[k];
    sortedStart[k] = start[i];
    maxExtent = Math.max(maxExtent, end[i] - start[i]);
  }
  const byName = new Map(); // name -> symbol indexes
  for (let i = 0; i < n; i++) byName.set(symbols[i].name, [...(byName.get(symbols[i].name) ?? []), i]);
  return { symbols, start, end, order, sortedStart, maxExtent, byName };
}

// Innermost symbol containing a position (1-based line, 0-based column), or null.
function enclosing(index, line, col) {
  const { start, end, order, sortedStart, maxExtent } = index;
  const p = positionKey(line, col);
  let lo = 0;
  let hi = sortedStart.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedStart[mid] <= p) lo = mid + 1;
    else hi = mid;
  }
  const floor = p - maxExtent;
  for (let k = lo - 1; k >= 0 && sortedStart[k] >= floor; k--) {
    const i = order[k];
    if (p >= start[i] && p <= end[i]) return i;
  }
  return null;
}

// A definition is the symbol it declares when it is the `name` field of its
// declaration and that declaration starts where a same-named symbol starts
// (the symbol is the declaration or the declarator). A local that merely shares
// its name with an enclosing function fails the position test and stays a local.
function symbolForDefinition(index, node) {
  const parent = node.parent;
  // Node handles are fresh wrappers: compare the stable node id, not the object.
  if (!parent || typeof parent.childForFieldName !== 'function') return null;
  const nameNode = parent.childForFieldName('name');
  if (!nameNode || nameNode.id !== node.id) return null;
  const declStart = parent.startPosition;
  const declLine = declStart.row + 1;
  const declCol = declStart.column;
  const start = node.startPosition;
  const p = positionKey(start.row + 1, start.column);
  for (const i of index.byName.get(node.text) ?? []) {
    const s = index.symbols[i];
    if (s.startLine !== declLine || (s.startCol ?? 0) !== declCol) continue;
    if (p < index.start[i] || p > index.end[i]) continue;
    return i;
  }
  return null;
}

/**
 * Resolve local references of one parse tree.
 *
 * @param {Tree} tree            parse tree (not deleted yet); its language compiles the query
 * @param {string} queryText     locals.scm source (`@local.scope` / `@local.definition` / `@local.reference`)
 * @param {object[]} symbols     the file's symbols so far (1-based lines, 0-based columns)
 * @returns {{ name: string, startLine: number, startCol: number, endLine: number, symbol: number|null, localDef: number|null }[]}
 */
export function resolveLocals(tree, queryText, symbols) {
  if (!tree || typeof queryText !== 'string' || queryText.length === 0) return [];
  const query = queryFor(tree.language, queryText);
  const entries = ordered(query.captures(tree.rootNode));
  if (entries.length === 0) return [];
  const index = symbolIndex(symbols ?? []);

  // The implicit root scope carries the definitions of queries without a
  // file-level scope pattern (the upstream JavaScript query has none).
  const rootEnd = tree.rootNode.endPosition;
  const rootScope = { endRow: rootEnd.row, endCol: rootEnd.column, node: null };
  const rootDefs = new Map();
  const defsByScope = new Map(); // scope node id -> definition table (built in pass 1, read in pass 2)
  const defSymbol = new Map(); // definition node id -> indexed symbol or null
  const referenceTypes = new Set(); // node types the query reports as references

  // Pass 1: definitions into their scope. First definition wins; a later one
  // only replaces it when it is an indexed symbol and the first is not.
  const stack = [{ ...rootScope, defs: rootDefs }];
  for (const entry of entries) {
    if (entry.name === REFERENCE) {
      referenceTypes.add(entry.node.type);
      continue;
    }
    if (entry.name !== SCOPE && entry.name !== DEFINITION) continue;
    closeScopes(stack, entry);
    if (entry.name === SCOPE) {
      const scope = { endRow: entry.endRow, endCol: entry.endCol, node: entry.node, defs: new Map() };
      defsByScope.set(entry.node.id, scope.defs);
      stack.push(scope);
      continue;
    }
    const text = entry.node.text;
    if (!text) continue;
    const symbol = symbolForDefinition(index, entry.node);
    defSymbol.set(entry.node.id, symbol);
    // The `name` of a declaration that is itself a scope binds one level out;
    // other bindings of a scope node (catch parameter, for-of left) stay inside.
    const top = stack[stack.length - 1];
    const parent = entry.node.parent;
    const nameNode = parent && typeof parent.childForFieldName === 'function' ? parent.childForFieldName('name') : null;
    const declarationName = nameNode !== null && nameNode.id === entry.node.id;
    const scopeDefs = (declarationName && top.node !== null && top.node.id === parent.id ? stack[stack.length - 2] : top).defs;
    const existing = scopeDefs.get(text);
    if (existing === undefined) {
      scopeDefs.set(text, { symbol });
    } else if (existing.symbol === null && symbol !== null) {
      existing.symbol = symbol;
    }
  }

  // Pass 2: references, innermost scope first.
  stack.length = 0;
  stack.push({ ...rootScope, defs: rootDefs });
  const out = [];
  const emitted = new Set();
  for (const entry of entries) {
    if (entry.name !== SCOPE && entry.name !== REFERENCE && entry.name !== DEFINITION) continue;
    closeScopes(stack, entry);
    if (entry.name === SCOPE) {
      stack.push({ endRow: entry.endRow, endCol: entry.endCol, node: entry.node, defs: defsByScope.get(entry.node.id) ?? new Map() });
      continue;
    }
    if (emitted.has(entry.node.id)) continue;
    const text = entry.node.text;
    const push = (localDef) => {
      emitted.add(entry.node.id);
      out.push({
        name: text,
        startLine: entry.startRow + 1,
        startCol: entry.startCol,
        endLine: entry.endCol > 0 ? entry.endRow + 1 : entry.endRow,
        symbol: enclosing(index, entry.startRow + 1, entry.startCol),
        localDef,
      });
    };
    if (entry.name === DEFINITION) {
      // Binding occurrence of a plain local: `?`, never a name-based global edge.
      if (defSymbol.get(entry.node.id) === null && referenceTypes.has(entry.node.type)) push(null);
      continue;
    }
    // The broad reference pattern also captures declaration names: not a use.
    if (defSymbol.has(entry.node.id)) continue;
    let localDef = null;
    let found = false;
    for (let k = stack.length - 1; k >= 0 && !found; k--) {
      const def = stack[k].defs.get(text);
      if (def !== undefined) {
        found = true;
        localDef = def.symbol;
      }
    }
    if (found) push(localDef);
  }
  return out;
}

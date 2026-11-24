// Pascal / Delphi pack (CONTRACTS.md §5). Grammar: Isopod/tree-sitter-pascal.
// Node types confirmed with bin/ast.mjs: units are `unit > interface/implementation`, routines are
// `defProc` (header=declProc, body=block), types live in `declType` whose `type` child is
// `declClass` for both `class` and `record`, and calls are `exprCall` with `entity` = identifier or
// `exprDot`. Routine implementations are indexed (not the interface forward declarations), so body
// refs attach to the symbol that owns them; `exported` is filled in postProcess from the interface.
const DOC = { from: pascalDoc };

// Pascal comments are `{ ... }`, `(* ... *)` or `// ...`; the engine's default stripper only knows
// C-style markers, so the text is cleaned here.
function pascalDoc(node) {
  const prev = node.previousNamedSibling ?? node.previousSibling;
  if (!prev || prev.type !== 'comment') return null;
  if (node.startPosition.row - prev.endPosition.row > 2) return null;
  const text = prev.text
    .replace(/^\s*\{|\}\s*$/g, '')
    .replace(/^\s*\(\*|\*\)\s*$/g, '')
    .replace(/^\/\/\s?/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

const headerOf = (node) => (node.type === 'defProc' ? node.childForFieldName('header') : node);
const nameIdentifiers = (node) => node.namedChildren.filter((c) => c.type === 'identifier');

function routineName(node) {
  const name = headerOf(node)?.childForFieldName('name');
  return name ? name.text.trim() : null;
}

const routineKind = (node) => (routineName(node)?.includes('.') ? 'method' : 'function');

function routineSignature(node) {
  const header = headerOf(node);
  const args = header?.childForFieldName('args');
  const ret = header?.childForFieldName('type');
  const sig = `${args?.text ?? ''}${ret ? `: ${ret.text}` : ''}`.trim();
  return sig || null;
}

// `class`/`record`/`enum`/`interface` are told apart by the keyword opening the type body.
function typeKind(node) {
  const t = node.childForFieldName('type');
  const head = t?.children[0]?.type;
  if (head === 'kClass') return 'class';
  if (head === 'kRecord') return 'struct';
  if (head === 'declEnum') return 'enum';
  if (head === 'kInterface' || head === 'declInterface' || head === 'kDispInterface') return 'interface';
  return 'type';
}

const sectionOf = (node) => {
  for (let n = node; n; n = n.parent) {
    if (n.type === 'interface' || n.type === 'implementation' || n.type === 'program' || n.type === 'library') return n.type;
  }
  return null;
};

// Only unit-level var sections count; `defProc local=declVars` are locals.
const isUnitVar = (node) => node.parent?.type === 'declVars' && node.parent.parent?.type !== 'defProc';

// `var A, B: Integer;` repeats the `name` field; the rule indexes the first, postProcess inserts the
// rest right after it so symbols stay in document order. The same walk marks refs that point at a
// `typeref` identifier as `type`: two reference rules on one node type would both match and
// duplicate every ref, so the kind is assigned here instead.
function walkTree(tree, out, lineOffset = 0) {
  const nodes = [];
  const visit = (n) => {
    nodes.push(n);
    for (const c of n.namedChildren) visit(c);
  };
  visit(tree.rootNode);
  const typePositions = new Set();
  for (const node of nodes) {
    if (node.type === 'identifier' && node.parent?.type === 'typeref') {
      typePositions.add(`${node.startPosition.row}:${node.startPosition.column}`);
    }
    if (node.type !== 'declVar' && node.type !== 'declConst' && node.type !== 'declField') continue;
    if (node.type === 'declVar' && !isUnitVar(node)) continue;
    const names = node.namedChildren.filter((c) => c.type === 'identifier');
    if (names.length < 2) continue;
    const section = sectionOf(node);
    const exported = section ? section === 'interface' : null;
    const kind = node.type === 'declVar' ? 'variable' : node.type === 'declConst' ? 'constant' : 'field';
    const extras = names.slice(1).map((id) => {
      const s = id.startPosition;
      return {
        kind,
        name: id.text,
        qual: null,
        startLine: s.row + 1 + lineOffset,
        startCol: s.column,
        endLine: s.row + 1 + lineOffset,
        endCol: id.endPosition.column,
        signature: null,
        doc: null,
        exported,
        parent: null,
        block: null,
      };
    });
    const first = names[0].startPosition;
    const at = out.symbols.findIndex((s) => s.startLine === first.row + 1 + lineOffset && s.startCol === first.column && s.name === names[0].text);
    if (at >= 0) out.symbols.splice(at + 1, 0, ...extras);
    else out.symbols.push(...extras);
  }
  for (const r of out.refs) {
    if (typePositions.has(`${r.startLine - 1 - lineOffset}:${r.startCol}`)) r.kind = 'type';
  }
}

// A routine is exported when the interface section declares the same name (`TVault.Deposit` is
// declared as a member, so the class name alone is enough for methods).
function markExportedRoutines(tree, out) {
  const iface = tree.rootNode.namedChildren.find((c) => c.type === 'unit')?.namedChildren.find((c) => c.type === 'interface');
  if (!iface) return;
  const declared = new Set();
  const stack = [iface];
  while (stack.length) {
    const node = stack.pop();
    if (node.type === 'declType' && (typeKind(node) === 'class' || typeKind(node) === 'struct')) declared.add(node.childForFieldName('name')?.text);
    if (node.type === 'declProc') declared.add(node.childForFieldName('name')?.text);
    for (const c of node.namedChildren) stack.push(c);
  }
  for (const sym of out.symbols) {
    if (sym.kind !== 'function' && sym.kind !== 'method') continue;
    const className = sym.name.split('.')[0];
    sym.exported = declared.has(sym.name) || (sym.kind === 'method' && declared.has(className));
  }
}

const postProcess = (out, ctx) => {
  walkTree(ctx.tree, out, ctx.lineOffset);
  markExportedRoutines(ctx.tree, out);
};

// Interface-section types/consts/vars are the unit's public surface; routines are decided in postProcess.
function isExported(node, sym) {
  if (sym.kind === 'function' || sym.kind === 'method') return null;
  const section = sectionOf(node);
  return section ? section === 'interface' : null;
}

export default {
  id: 'pascal',
  label: 'Pascal',
  extensions: ['.pas', '.dpr', '.dpk', '.lpr'],
  grammar: 'pascal',
  support: 'full',
  commentTypes: ['comment'],
  definitions: {
    defProc: { kind: routineKind, name: routineName, signature: routineSignature, doc: DOC },
    declType: { kind: typeKind, name: 'name', doc: DOC },
    declConst: { kind: 'constant', name: 'name', doc: DOC },
    declVar: { kind: 'variable', name: 'name', when: isUnitVar, doc: DOC },
    declField: { kind: 'field', name: 'name', doc: DOC },
    declProp: { kind: 'property', name: 'name', doc: DOC },
  },
  calls: [{ node: 'exprCall', fn: 'entity' }],
  imports: [
    {
      node: 'moduleName',
      kind: 'import',
      when: (n) => n.parent?.type === 'declUses',
      spec: (n) => nameIdentifiers(n)[0]?.text ?? null,
    },
  ],
  references: [{ node: 'identifier' }],
  skipPatterns: [
    '(declProc (identifier) @skip)',
    '(genericDot (identifier) @skip)',
    '(declArg name: (identifier) @skip)',
    '(moduleName (identifier) @skip)',
    '(declEnumValue name: (identifier) @skip)',
    '(declVar name: (identifier) @skip)',
    '(declConst name: (identifier) @skip)',
    '(declField name: (identifier) @skip)',
    '(declProp name: (identifier) @skip)',
    '(exprCall entity: (exprDot rhs: (identifier) @skip))',
  ],
  isExported,
  hooks: { postProcess },
};

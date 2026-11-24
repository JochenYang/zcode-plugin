// CFML tag pack (CONTRACTS.md §5). Grammar: cfmleditor/tree-sitter-cfml cfml dialect.
// Node types confirmed with bin/ast.mjs: `<cfcomponent>` is `cf_component_open_tag` (attributes
// under `cf_tag_attributes`), `<cffunction>` is `cf_function_tag` (attributes as direct children),
// every other tag is a generic `cf_selfclose_tag`/`cf_set_tag`/... whose tag name is an external
// token that is not in the tree, so it is read from the source. `<cfscript>` bodies and tag-less
// script `.cfc` files are handed to the `cfscript` pack through embeddings.
const stripQuotes = (s) => String(s ?? '').trim().replace(/^["']|["']$/g, '');

const attributesOf = (node) =>
  node.namedChildren.flatMap((c) => (c.type === 'cf_tag_attributes' ? c.namedChildren : [c])).filter((c) => c.type === 'cf_attribute');

const attrValue = (node, name) => {
  const attr = attributesOf(node).find((a) => a.namedChildren.find((c) => c.type === 'cf_attribute_name')?.text === name);
  const value = attr?.namedChildren.find((c) => c.type === 'quoted_cf_attribute_value');
  return value ? stripQuotes(value.text) : null;
};

// The tag name (`cfproperty`, `cfinclude`) is not a node; read it from the source text.
const tagName = (node, ctx) => /^<\s*cf([\w-]+)/i.exec(ctx.source.slice(node.startIndex, node.startIndex + 60))?.[1]?.toLowerCase() ?? null;
const hasTag = (name) => (node, ctx) => tagName(node, ctx) === name;

// `<cffunction name="..." returntype="...">` with `<cfargument name="...">` children.
function functionSignature(node, ctx) {
  const args = node.namedChildren
    .filter((c) => c.type === 'cf_selfclose_tag' && tagName(c, ctx) === 'argument')
    .map((c) => attrValue(c, 'name'))
    .filter(Boolean);
  const ret = attrValue(node, 'returntype');
  return `(${args.join(', ')})${ret ? `: ${ret}` : ''}`;
}

// `<!--- Credits an amount for a user. --->`; the grammar's cf_comment starts right after the
// previous tag, so only the comment text is kept.
function tagDoc(node) {
  const prev = node.previousNamedSibling ?? node.previousSibling;
  if (!prev || prev.type !== 'cf_comment') return null;
  if (node.startPosition.row - prev.endPosition.row > 2) return null;
  const text = prev.text
    .replace(/^[\s\S]*?<!---/, '')
    .replace(/--->[\s\S]*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

// Access defaults to public; private/package hide the function from other templates.
const isExported = (node, sym) => {
  if (sym.kind === 'class') return true;
  if (sym.kind !== 'function' && sym.kind !== 'method') return null;
  const access = attrValue(node, 'access');
  return access !== 'private' && access !== 'package';
};

const SCRIPT_BLOCK = /<cfscript\b[^>]*>([\s\S]*?)<\/cfscript\s*>/gi;
const SCRIPT_HEAD = /^\s*(?:import\b|component\b|(?:public|private|remote|package)\b|function\b|void\b|var\b)/i;
const lineAt = (source, index) => source.slice(0, index).split('\n').length;

// Returns absolute 1-based lines; the engine parses each block with the cfscript pack and offsets
// symbols/refs by `startLine`. Plain HTML `.cfm` files are left alone (no block, no false errors).
function scriptBlocks(source) {
  const blocks = [];
  if (!/<cf/i.test(source)) {
    if (SCRIPT_HEAD.test(source)) {
      return [{ text: source, startLine: 1, endLine: source.trimEnd().split('\n').length }];
    }
    return blocks;
  }
  for (const m of source.matchAll(SCRIPT_BLOCK)) {
    const bodyStart = m.index + m[0].indexOf(m[1]);
    const bodyEnd = bodyStart + m[1].trimEnd().length;
    blocks.push({ text: m[1], startLine: lineAt(source, bodyStart), endLine: lineAt(source, bodyEnd) });
  }
  return blocks;
}

// `cf_component_open_tag` covers only the opening tag, so its members would not be contained in it.
// Stretch the component symbol to the closing tag so functions become `Vault.deposit` methods.
function postProcess(out, ctx) {
  const close = ctx.tree.rootNode.namedChildren.find((c) => c.type === 'cf_component_close_tag');
  if (!close) return;
  const e = close.endPosition;
  for (const sym of out.symbols) {
    if (sym.kind !== 'class' || sym.block !== null) continue;
    sym.endLine = (e.column > 0 ? e.row + 1 : e.row) + ctx.lineOffset;
    sym.endCol = e.column;
  }
}

export default {
  id: 'cfml',
  label: 'CFML',
  // `.cfs` is owned by the `cfscript` pack (parsed directly with the cfscript grammar).
  extensions: ['.cfc', '.cfm'],
  grammar: 'cfml',
  support: 'full',
  commentTypes: ['cf_comment', 'comment'],
  definitions: {
    cf_component_open_tag: { kind: 'class', name: (n) => attrValue(n, 'displayname'), doc: { from: (n) => attrValue(n, 'hint') } },
    cf_function_tag: { kind: 'function', name: (n) => attrValue(n, 'name'), signature: functionSignature, doc: { from: tagDoc } },
    cf_selfclose_tag: { kind: 'property', name: (n) => attrValue(n, 'name'), when: hasTag('property') },
  },
  calls: [{ node: 'call_expression', fn: 'function' }],
  imports: [{ node: 'cf_selfclose_tag', kind: 'include', when: hasTag('include'), spec: (n) => attrValue(n, 'template') }],
  references: [{ node: 'identifier' }, { node: 'property_identifier' }],
  skipPatterns: ['(call_expression function: (member_expression property: (property_identifier) @skip))'],
  embeddings: [{ lang: 'cfscript', extract: scriptBlocks }],
  isExported,
  hooks: { postProcess },
};

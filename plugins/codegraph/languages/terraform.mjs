// Terraform / OpenTofu pack (CONTRACTS.md §5). Grammar: tree-sitter-hcl terraform dialect.
// Every construct is a `block` (first `identifier` = block type, then one `string_lit` per label)
// or an `attribute` (`identifier` = expression). Reference chains (`var.x`, `data.t.n.attr`,
// `module.m.out`, `each.key`, `aws_instance.web.id`) are an `expression` whose named children are
// only `variable_expr`/`get_attr`; the grammar has no `relative_resource` node. No calls: HCL
// function calls (`format(...)`) are expression-level and not part of the code graph.
const stripQuotes = (s) => String(s ?? '').trim().replace(/^"|"$/g, '');

const BLOCK_KINDS = {
  resource: 'component',
  data: 'component',
  variable: 'variable',
  output: 'constant',
  module: 'module',
};

// `resource "aws_instance" "web"` -> `aws_instance.web`; `locals` -> `locals`.
function blockName(node) {
  const parts = [];
  for (const c of node.children) {
    if (c.type === 'identifier' && !parts.length) parts.push(c.text);
    else if (c.type === 'string_lit') parts.push(stripQuotes(c.text));
    else if (c.type === 'block_start') break;
  }
  return parts.join('.');
}

const blockKind = (node) => BLOCK_KINDS[node.children.find((c) => c.type === 'identifier')?.text] ?? 'other';

const ownerBlock = (node) => (node.parent?.type === 'body' ? node.parent.parent : null);
const attributeName = (node) => node.children.find((c) => c.type === 'identifier')?.text ?? null;

// Attributes inside a `locals` block are the only attribute-level definitions in HCL.
const isLocalsAttribute = (node) => ownerBlock(node)?.type === 'block' && attributeName(ownerBlock(node)) === 'locals';

const isModuleSource = (node) => attributeName(node) === 'source' && attributeName(ownerBlock(node)) === 'module';
const attributeString = (node) => stripQuotes(node.children.find((c) => c.type === 'expression')?.text);

// Pure reference chains only: literals, function calls, `for` expressions and operators
// are not references. `type = string` inside `variable` blocks is a type keyword, not a ref.
function isRefChain(node) {
  const kids = node.namedChildren;
  if (!kids.length || !kids.every((c) => c.type === 'variable_expr' || c.type === 'get_attr')) return false;
  if (node.parent?.type === 'attribute' && attributeName(node.parent) === 'type') return false;
  return true;
}

// A comment before the first block is a sibling of `body` (the wrapper), not of the block.
function blockDoc(node) {
  let prev = node.previousNamedSibling ?? node.previousSibling;
  const body = node.parent;
  if (!prev && body?.type === 'body' && body.namedChildren[0]?.id === node.id) prev = body.previousNamedSibling ?? body.previousSibling;
  if (!prev || prev.type !== 'comment') return null;
  if (node.startPosition.row - prev.endPosition.row > 2) return null;
  const text = prev.text.replace(/^\s*#+\s?/, '').replace(/\s+/g, ' ').trim();
  return text || null;
}

export default {
  id: 'terraform',
  label: 'Terraform',
  extensions: ['.tf', '.tfvars', '.tofu'],
  grammar: 'terraform',
  support: 'full',
  commentTypes: ['comment'],
  definitions: {
    block: { kind: blockKind, name: blockName, doc: { from: blockDoc } },
    attribute: { kind: 'variable', name: (node) => attributeName(node), when: isLocalsAttribute },
  },
  imports: [
    { node: 'attribute', kind: 'module', when: isModuleSource, spec: attributeString },
  ],
  references: [{ node: 'expression', kind: 'ref', when: isRefChain }],
  // Object keys are parsed as `expression > variable_expr`; they name a key, they do not reference anything.
  skipPatterns: ['(object_elem key: (expression) @skip)'],
};

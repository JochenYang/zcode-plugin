// CFScript pack (CONTRACTS.md §5). Grammar: cfmleditor/tree-sitter-cfml cfscript dialect.
// Covers `.cfs` files directly and the `<cfscript>` bodies / tag-less `.cfc` files that the `cfml`
// pack embeds. Node types confirmed with bin/ast.mjs: `component` (attributes are unlabelled
// `component_attribute` children), `property_declaration`, `function_declaration` (fields
// `name`/`parameters`/`body`; the access type and return type are unlabelled), `import_statement`
// with `source` = string or `import_path`, and JS-like `call_expression`/`new_expression`.
const stripQuotes = (s) => String(s ?? '').trim().replace(/^["']|["']$/g, '');

const attrValue = (attrs, name) => {
  const attr = attrs.find((a) => a.namedChildren[0]?.type === 'identifier' && a.namedChildren[0].text === name);
  if (!attr) return null;
  const value = attr.namedChildren.find((c) => c.type === 'string');
  return value ? stripQuotes(value.text) : null;
};

const attributesOf = (node) => node.namedChildren.filter((c) => c.type === 'component_attribute');

// `component displayname="Vault" hint="..."`: displayname is the symbol, hint is the doc.
const componentName = (node) => attrValue(attributesOf(node), 'displayname');
const componentDoc = (node) => attrValue(attributesOf(node), 'hint');

const propertyName = (node) => attrValue(attributesOf(node), 'name');

const accessType = (node) => node.namedChildren.find((c) => c.type === 'access_type')?.text ?? null;
// CFML defaults to `public`; only `private`/`package` hide a function from callers.
const isExported = (node, sym) => {
  if (sym.kind !== 'function' && sym.kind !== 'method') return sym.kind === 'class' ? true : null;
  const access = accessType(node);
  return access !== 'private' && access !== 'package';
};

// `public numeric function f(...)`: the unlabelled identifier before the name is the return type.
function functionSignature(node) {
  const kids = node.namedChildren;
  const paramsIdx = kids.findIndex((c) => c.type === 'formal_parameters');
  const ret = paramsIdx >= 2 && kids[paramsIdx - 2].type === 'identifier' ? kids[paramsIdx - 2].text : null;
  const params = node.childForFieldName('parameters');
  return `${params?.text ?? ''}${ret ? `: ${ret}` : ''}` || null;
}

const importSpec = (node) => stripQuotes(node.childForFieldName('source')?.text);

export default {
  id: 'cfscript',
  label: 'CFScript',
  extensions: ['.cfs'],
  grammar: 'cfscript',
  support: 'full',
  commentTypes: ['comment', 'line_comment', 'block_comment'],
  definitions: {
    component: { kind: 'class', name: componentName, doc: { from: componentDoc } },
    property_declaration: { kind: 'property', name: propertyName },
    function_declaration: { kind: 'function', name: 'name', signature: functionSignature },
  },
  calls: [
    { node: 'call_expression', fn: 'function' },
    { node: 'new_expression', fn: 'constructor' },
  ],
  imports: [{ node: 'import_statement', kind: 'import', spec: importSpec }],
  references: [{ node: 'identifier' }, { node: 'property_identifier' }],
  skipPatterns: [
    '(component_attribute (identifier) @skip)',
    '(import_path (identifier) @skip)',
    '(formal_parameters (identifier) @skip)',
    '(assignment_pattern (identifier) @skip)',
    '(parameter_type (identifier) @skip)',
    '(variable_declarator name: (identifier) @skip)',
    // The member name of a call (`this.log(x)`) is already the call; keep the receiver only.
    '(call_expression function: (member_expression property: (property_identifier) @skip))',
    // Return type keyword sits right before the function name.
    '(function_declaration (identifier) @skip . (identifier) . (formal_parameters))',
  ],
  isExported,
};

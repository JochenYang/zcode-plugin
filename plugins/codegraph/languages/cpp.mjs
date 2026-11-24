// C++ LanguageSpec: the C pack plus class/namespace/template syntax (CONTRACTS.md §5).
// Grammar: tree-sitter-cpp. Adds `field_identifier` / `namespace_identifier` references.
import { declaratorInfo, declaratorName, docComment, isExported as isExportedC } from './c.mjs';

const DOC = { from: docComment };

// `static` on a class member means "per class", not internal linkage, and `exported`
// follows the access specifier in force (private by default for `class`, public for `struct`).
function classBodyOf(node) {
  let p = node.parent;
  while (p?.type === 'template_declaration') p = p.parent;
  return p?.type === 'field_declaration_list' ? p : null;
}

function memberExported(node, list) {
  let access = null;
  for (const c of list.children) {
    if (c.startIndex >= node.startIndex) break;
    if (c.type === 'access_specifier') access = c.text.replace(/:\s*$/, '');
  }
  if (access) return access === 'public';
  return list.parent?.children[0]?.text === 'struct';
}

const isExported = (node) => {
  const list = classBodyOf(node);
  return list ? memberExported(node, list) : isExportedC(node);
};

// Member declarations: `void connect(const Node&);` is a method, `int id_;` a field.
const memberKind = (node, ctx) => (declaratorInfo(node, ctx).fn ? 'method' : 'field');
const hasMemberName = (node, ctx) => !!declaratorInfo(node, ctx).name;

const spec = {
  id: 'cpp',
  label: 'C++',
  extensions: ['.cpp', '.hpp', '.cc', '.cxx', '.hxx'],
  grammar: 'cpp',
  extends: 'c',
  // `template <typename T>` wraps the declaration; its doc comment sits above the template.
  transparentAncestors: ['template_declaration'],
  definitions: {
    // `class Foo f;` (elaborated type specifier) is a reference: require a body.
    class_specifier: { kind: 'class', name: 'name', when: (n, ctx) => !!ctx.field(n, 'body'), doc: DOC },
    namespace_definition: { kind: 'namespace', name: 'name', doc: DOC },
    alias_declaration: { kind: 'type', name: 'name', doc: DOC },
    field_declaration: { kind: memberKind, name: declaratorName, when: hasMemberName, doc: DOC },
  },
  calls: [{ node: 'new_expression', fn: 'constructor' }],
  references: [{ node: 'field_identifier' }, { node: 'namespace_identifier', kind: 'type' }],
  // `x.m()` already yields a call on `m`; the selector's own name and template callee
  // names (`std::make_unique<T>()`) must not also count as references. C's list is
  // inherited (`extends` appends skipPatterns); only C++-only constructs are listed here.
  skipPatterns: [
    '(parameter_declaration declarator: (reference_declarator (identifier) @skip))',
    '(field_expression field: (field_identifier) @skip)',
    '(qualified_identifier name: (identifier) @skip)',
    '(template_function name: (identifier) @skip)',
    '(type_parameter_declaration (type_identifier) @skip)',
    '(attribute (identifier) @skip)',
  ],
  isExported,
};

export default spec;

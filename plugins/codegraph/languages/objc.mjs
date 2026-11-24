// Objective-C LanguageSpec: the C pack plus @interface/@protocol/@implementation (CONTRACTS.md §5).
// Grammar: tree-sitter-objc 2.x names them `class_interface` / `class_implementation` /
// `protocol_declaration` / `module_import` (older revisions used *_declaration). A method's
// selector has no field of its own: it is the `identifier` children interleaved with the
// `method_parameter` children (`graph:(GraphNode *)node didAddEdge:(GraphNode *)other`).
import { docComment } from './c.mjs';

const DOC = { from: docComment };

const firstIdentifier = (node) => node.namedChildren.find((c) => c.type === 'identifier') ?? null;

// Class/protocol names are the first identifier; a category (`@interface Foo (Bar)`) is
// appended so it does not collide with the main interface's symbol.
function className(node, ctx) {
  const name = firstIdentifier(node);
  if (!name) return null;
  ctx.consume(name);
  const category = ctx.field(node, 'category');
  if (category) ctx.consume(category);
  return category ? `${name.text} (${category.text})` : name.text;
}

function protocolName(node, ctx) {
  const name = firstIdentifier(node);
  if (!name) return null;
  ctx.consume(name);
  return name.text;
}

// Every child carrying a field name (web-tree-sitter exposes only the first one via
// childForFieldName, and a multi-part message has several `method` children).
function fieldChildren(node, field) {
  const out = [];
  for (let i = 0; i < node.childCount; i++) {
    const names = typeof node.fieldNamesForChild === 'function' ? node.fieldNamesForChild(i) : [node.fieldNameForChild(i)];
    if (names.includes(field)) out.push(node.child(i));
  }
  return out;
}

// In a message the selector parts carry the `method` field; in a method declaration they are
// the bare `identifier` children (parameters nest their own names, so they never collide).
const selectorParts = (node) => {
  const viaField = fieldChildren(node, 'method');
  return viaField.length ? viaField : node.namedChildren.filter((c) => c.type === 'identifier');
};
// A selector ends with `:` only when there are arguments: `method_parameter` children in a
// declaration, or argument expressions beyond the receiver and selector parts in a message.
function hasParameters(node) {
  if (node.namedChildren.some((c) => c.type === 'method_parameter')) return true;
  if (node.type !== 'message_expression') return false;
  const taken = new Set([...selectorParts(node), ...fieldChildren(node, 'receiver')].map((c) => c.startIndex));
  return node.namedChildren.some((c) => !taken.has(c.startIndex));
}
// `init`, `connectTo:`, `graph:didAddEdge:`
const selectorOf = (node) => selectorParts(node).map((c) => c.text).join(':') + (hasParameters(node) ? ':' : '');

// As a definition name the selector parts are the symbol's own name: consume them so they
// are not also indexed as references.
function methodName(node, ctx) {
  for (const c of selectorParts(node)) ctx.consume(c);
  return selectorOf(node);
}

// `(void) connectTo:(GraphNode *)other` / `(void) invalidate`
function methodSignature(node) {
  const selectorStarts = new Set(selectorParts(node).map((c) => c.startIndex));
  const colon = hasParameters(node) ? ':' : '';
  let sig = node.namedChildren.find((c) => c.type === 'method_type')?.text ?? '';
  for (const c of node.namedChildren) {
    if (selectorStarts.has(c.startIndex)) sig += ` ${c.text}${colon}`;
    else if (c.type === 'method_parameter') {
      const t = c.namedChildren.find((x) => x.type === 'method_type')?.text ?? '';
      const n = c.namedChildren.find((x) => x.type === 'identifier')?.text ?? '';
      sig += `${t}${n}`;
    }
  }
  return sig;
}

// `@property ... NSString *label;` and ivars keep their name inside a C struct declarator.
function declaredMemberName(node, ctx) {
  const decl = node.namedChildren.find((c) => c.type === 'struct_declaration');
  const declarator = decl?.namedChildren.find((c) => c.type === 'struct_declarator');
  for (let d = declarator; d; ) {
    if (d.type === 'identifier' || d.type === 'field_identifier') {
      ctx.consume(d);
      return d;
    }
    d = ctx.field(d, 'declarator') ?? d.namedChildren.find((c) => c.type.endsWith('declarator') || c.type === 'identifier') ?? null;
  }
  return null;
}

// Receivers read as `self`, `GraphNode`, `NSNotificationCenter.defaultCenter`, or verbatim
// (`[GraphNode alloc]`) when they are neither an identifier nor a message chain.
function receiverText(node, ctx) {
  if (!node) return '';
  if (node.type === 'message_expression') {
    const inner = receiverText(ctx.field(node, 'receiver'), ctx);
    const selector = selectorOf(node);
    return inner ? `${inner}.${selector}` : selector;
  }
  return node.text.replace(/\s+/g, ' ').trim();
}

const messageCall = (node, ctx) => ({ name: selectorOf(node), receiver: receiverText(ctx.field(node, 'receiver'), ctx) });

const spec = {
  id: 'objc',
  label: 'Objective-C',
  extensions: ['.m', '.mm'],
  grammar: 'objc',
  extends: 'c',
  definitions: {
    class_interface: { kind: 'class', name: className, doc: DOC },
    class_implementation: { kind: 'class', name: className, doc: DOC },
    protocol_declaration: { kind: 'interface', name: protocolName, doc: DOC },
    method_declaration: { kind: 'method', name: methodName, signature: methodSignature, doc: DOC },
    method_definition: { kind: 'method', name: methodName, signature: methodSignature, doc: DOC },
    property_declaration: { kind: 'property', name: declaredMemberName, doc: DOC },
    instance_variable: { kind: 'field', name: declaredMemberName },
  },
  calls: [{ node: 'message_expression', fn: messageCall }],
  imports: [{ node: 'module_import', kind: 'import', spec: (n, ctx) => ctx.field(n, 'path')?.text?.trim() }],
  references: [],
  // C's list is inherited (`extends` appends skipPatterns). Selector parts are the call's
  // name; `self`/`super` never denote an indexed symbol.
  skipPatterns: [
    '(message_expression method: (identifier) @skip)',
    '(message_expression receiver: (identifier) @skip)',
    '(method_parameter (identifier) @skip)',
    '(property_attribute (identifier) @skip)',
    '(identifier) @skip (#eq? @skip "self")',
    '(identifier) @skip (#eq? @skip "super")',
  ],
};

export default spec;

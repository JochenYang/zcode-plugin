// ArkTS (HarmonyOS) = TypeScript + ArkUI declarative syntax. Every TS rule comes from
// typescript.mjs; the arkts grammar is a TS superset whose node types all exist, so the
// inherited query compiles without "absent node type" warnings. This pack adds the
// ArkUI nodes: `@Component struct Foo { build() {...} }` and `Column() { ... }`.
const spec = {
  id: 'arkts',
  label: 'ArkTS',
  extensions: ['.ets'],
  grammar: 'arkts',
  extends: 'typescript',
  definitions: {
    // A struct is always a custom component in ArkTS; its members become method/field
    // automatically because `component` is a container kind in the engine.
    struct_declaration: { kind: 'component', name: 'name', doc: { from: structDoc } },
  },
  calls: [
    // `Column() { ... }` and `Text(x).fontSize(16)` are one node with the constructor in
    // `function`; chained attribute setters are styling, not navigation targets.
    { node: 'arkui_component_expression', fn: 'function' },
  ],
};

// `/** Doc */ @Entry @Component struct X {}`: decorators sit between the comment and the
// declaration, so the engine's default (previous named sibling) would see a decorator.
function structDoc(node) {
  let prev = node.previousNamedSibling;
  while (prev?.type === 'decorator') prev = prev.previousNamedSibling;
  if (!prev || prev.type !== 'comment' || node.startPosition.row - prev.endPosition.row > 2) return null;
  return prev.text.replace(/^\/\*\*|\*\/$/g, '').replace(/^\s*\*\s?/gm, '').trim() || null;
}

export default spec;

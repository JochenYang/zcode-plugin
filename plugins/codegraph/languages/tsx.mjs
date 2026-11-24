// TSX = TypeScript + JSX (CONTRACTS.md §5 `extends`). Every definition/call/import
// rule comes from typescript.mjs; this pack only swaps the grammar (so JSX parses
// with 0 ERROR nodes), classifies PascalCase function declarations as components
// (the React naming convention; `const Foo = () => <div/>` already becomes one via
// the inherited declarator rule) and adds the JSX host-tag exclusions, because `<div>`
// is not a reference to a symbol named `div` while `<PriceTag/>` is a component reference.
import { JSX_HOST_TAG_PATTERNS } from './javascript.mjs';

const pascal = (name) => /^[A-Z]/.test(name);
const componentIfPascal = (node, ctx) => (pascal(ctx.text(ctx.field(node, 'name'))) ? 'component' : 'function');

const spec = {
  id: 'tsx',
  label: 'TSX',
  extensions: ['.tsx'],
  grammar: 'tsx',
  extends: 'typescript',
  definitions: {
    function_declaration: { kind: componentIfPascal, name: 'name', signature: ['parameters', 'return_type'] },
  },
  skipPatterns: JSX_HOST_TAG_PATTERNS,
};

export default spec;

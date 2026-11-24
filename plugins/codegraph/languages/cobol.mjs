// COBOL has no bundled tree-sitter grammar (the only candidate wasm crashes Node during V8
// tier-up), so the pack is file-level only: files enter the `files` table and the repo map by
// path/language, with no symbols, refs or imports (CONTRACTS.md §5 `support: 'file-level'`).
export default {
  id: 'cobol',
  label: 'COBOL',
  extensions: ['.cbl', '.cob', '.cpy'],
  support: 'file-level',
};

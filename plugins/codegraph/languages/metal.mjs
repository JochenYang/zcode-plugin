// Metal LanguageSpec (CONTRACTS.md §5).
// The bundled grammar is plain C++: the `kernel`/`vertex`/`fragment` entry-point qualifiers
// and the `device`/`constant`/`thread` address-space qualifiers produce ERROR nodes. The
// pack therefore has no grammar of its own and feeds the C++ pack a byte-for-byte neutralised
// copy of the source (every rewrite keeps the original length, so lines and columns stay
// exact). `[[attribute]]` syntax and the `metal` vector types already parse as C++. A
// dedicated tree-sitter-metal grammar would remove this shim (see contract-requests.md).

// Replace every match with spaces of the same length (newlines inside a match are kept).
const blank = (source, regex) => source.replace(regex, (m) => m.replace(/[^\n]/g, ' '));

// Entry-point qualifiers start a line and become `inline` (exported; a kernel/vertex/fragment
// stage is the shader's public interface). A return type must follow, so a variable or call
// named `vertex` (`vertex += 1;`) is left alone.
const TYPE_START = '(?:void|bool|char|uchar|short|ushort|int|uint|long|ulong|half\\d?|float\\d?|size_t|unsigned|signed|struct|class|template|constexpr|[A-Z])';
const ENTRY_POINTS = new RegExp(`^([ \\t]*)(kernel|vertex|fragment)(?=\\s+${TYPE_START})`, 'gm');
// Address-space qualifiers are only touched when a type follows (keyword, or a capitalised
// type name) and nothing qualified them (`std::thread`, `obj.device`, `&thread` stay intact).
const ADDRESS_SPACES = new RegExp(`(?<![\\w:.>&])(device|constant|threadgroup_imageblock|threadgroup|thread|ray_data|object_data)(?=\\s+(?:const\\s+)?${TYPE_START})`, 'g');

const preprocess = (source) =>
  blank(source.replace(ENTRY_POINTS, (_m, indent, kw) => `${indent}${'inline'.padEnd(kw.length)}`), ADDRESS_SPACES);

const spec = {
  id: 'metal',
  label: 'Metal',
  extensions: ['.metal'],
  grammar: null,
  support: 'script',
  extends: 'cpp',
  embeddings: [
    {
      lang: 'cpp',
      extract: (source) => (source.trim() ? [{ text: preprocess(source), startLine: 1, endLine: source.split('\n').length }] : []),
    },
  ],
};

export default spec;

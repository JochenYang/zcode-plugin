// CUDA LanguageSpec (CONTRACTS.md §5).
// The bundled grammar is plain C++: `__global__`/`__device__` qualifiers and the `<<<...>>>`
// launch syntax produce ERROR nodes (kernels still index, launch calls are lost). The pack
// therefore has no grammar of its own and feeds the C++ pack a byte-for-byte neutralised
// copy of the source: every rewrite keeps the original length so lines and columns stay exact.
// A dedicated tree-sitter-cuda grammar would remove this shim (see contract-requests.md).

// Splits the source into [start, end, isCode] spans; comments and string/char literals are
// copied verbatim so neither keyword rules nor launch pairing touch their contents.
function spans(source) {
  const out = [];
  let start = 0;
  let i = 0;
  while (i < source.length) {
    let end = -1;
    if (source.startsWith('//', i)) end = source.indexOf('\n', i) < 0 ? source.length : source.indexOf('\n', i);
    else if (source.startsWith('/*', i)) { const e = source.indexOf('*/', i + 2); end = e < 0 ? source.length : e + 2; }
    else if (source[i] === '"' || source[i] === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== source[i]) j += source[j] === '\\' ? 2 : 1;
      end = Math.min(j + 1, source.length);
    }
    if (end < 0) { i++; continue; }
    out.push([start, i, true], [i, end, false]);
    start = i = end;
  }
  out.push([start, source.length, true]);
  return out;
}

const blank = (m) => m.replace(/[^\n]/g, ' ');

// `k<<<grid, block, shared, stream>>>(args)` -> `k                              (args)`.
// The configuration expression is dropped; the call itself survives as a normal call.
function blankLaunches(code) {
  let out = '';
  let i = 0;
  for (;;) {
    const start = code.indexOf('<<<', i);
    if (start < 0) return out + code.slice(i);
    let depth = 0;
    let end = -1;
    for (let j = start + 3; j < code.length; j++) {
      if (code.startsWith('>>>', j) && depth === 0) { end = j + 3; break; }
      if (code[j] === '<') depth++;
      else if (code[j] === '>') depth--;
    }
    if (end < 0) return out + code.slice(i);
    out += `${code.slice(i, start)}${' '.repeat(end - start)}`;
    i = end;
  }
}

// Kernels are the module's entry points (`__global__` -> `inline`, i.e. exported); device
// helpers and address spaces are internal (`__device__`/`__shared__`/... -> `static`); pure
// annotations are blanked. Every replacement has the token's length.
const keyword = (word, replacement) => (s) => s.replace(new RegExp(`\\b${word}\\b`, 'g'), replacement.padEnd(word.length));
const RULES = [
  (s) => s.replace(/__launch_bounds__\s*\([^)]*\)/g, blank),
  blankLaunches,
  keyword('__global__', 'inline'),
  ...['__device__', '__shared__', '__constant__', '__managed__'].map((w) => keyword(w, 'static')),
  ...['__forceinline__', '__host__'].map((w) => keyword(w, 'inline')),
  (s) => s.replace(/\b__(?:noinline|restrict)__\b/g, blank),
  keyword('__align__', 'alignas'),
];

const preprocess = (source) =>
  spans(source)
    .map(([a, b, isCode]) => {
      const text = source.slice(a, b);
      return isCode ? RULES.reduce((s, rule) => rule(s), text) : text;
    })
    .join('');

const spec = {
  id: 'cuda',
  label: 'CUDA',
  extensions: ['.cu', '.cuh'],
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

// ASP.NET Razor views (.cshtml) and Blazor components (.razor). There is no Razor
// grammar: a file contributes only its embedded code. C# lives in `@functions { }`,
// `@code { }` and `@{ }` blocks (-> csharp pack); `<script>` tags follow the HTML rule
// (`lang="ts"` -> typescript, otherwise javascript). Markup and `@expression` inline
// transitions are not indexed.
import { onlyLang } from './javascript.mjs';

// `@functions` / `@code` bodies are class members (Razor compiles them into the page
// class), but the embedded text is parsed on its own: top-level methods would parse as
// C# 9 local functions and `private class` would be an error. Wrapping the body in a
// class keeps members valid; the prefix sits on the block's first line and the suffix
// after its last line, so symbol line numbers are unchanged.
const MEMBER_WRAPPER = 'class RazorFunctions {';
const WRAPPER_NAME = 'RazorFunctions';

// Razor comments may contain text that looks like a code block; blank them in place so
// offsets (and therefore line numbers) stay stable.
const maskComments = (source) => source.replace(/@\*[\s\S]*?\*@/g, (m) => m.replace(/[^\n]/g, ' '));

// Index of the `}` closing the `{` at `open`, ignoring braces inside C# string literals
// (`"…"`, `'…'`, `@"…"`, `$"…"`, raw `"""…"""`) and comments (`//`, `/* */`).
function matchBrace(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}') {
      if (--depth === 0) return i;
    } else if (c === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
      if (i < 0) return -1;
    } else if (c === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i + 2);
      if (i < 0) return -1;
      i++;
    } else if (c === '"') {
      if (source.startsWith('"""', i)) {
        i = source.indexOf('"""', i + 3);
        if (i < 0) return -1;
        i += 2;
      } else {
        for (i++; i < source.length && source[i] !== '"'; i++) if (source[i] === '\\') i++;
      }
    } else if (c === '\'') {
      for (i++; i < source.length && source[i] !== '\''; i++) if (source[i] === '\\') i++;
    }
  }
  return -1;
}

export function csharpBlocks(source) {
  const masked = maskComments(source);
  const blocks = [];
  const re = /(?<!@)@(?:(functions|code)\s*)?\{/g;
  let lastEnd = -1;
  for (const m of masked.matchAll(re)) {
    if (m.index < lastEnd) continue; // nested match inside an earlier block
    const open = m.index + m[0].length - 1;
    const close = matchBrace(masked, open);
    if (close < 0) continue;
    lastEnd = close;
    const body = source.slice(open + 1, close);
    if (!body.trim()) continue;
    const startLine = source.slice(0, open + 1).split('\n').length;
    const endLine = startLine + (body.trimEnd().match(/\n/g) ?? []).length;
    const text = m[1] ? `${MEMBER_WRAPPER}${body}\n}` : body;
    blocks.push({ text, startLine, endLine });
  }
  return blocks;
}

// Drops the synthetic wrapper class before containment is computed (the engine runs
// hooks.postProcess for script-only packs too), so members end up top-level.
function postProcess(out) {
  const wrappers = new Set(out.symbols.filter((s) => s.kind === 'class' && s.name === WRAPPER_NAME));
  if (!wrappers.size) return;
  out.symbols = out.symbols.filter((s) => !wrappers.has(s));
}

const spec = {
  id: 'razor',
  label: 'Razor',
  extensions: ['.cshtml', '.razor'],
  support: 'script',
  embeddings: [
    { lang: 'csharp', extract: csharpBlocks },
    { lang: 'typescript', extract: onlyLang('typescript') },
    { lang: 'tsx', extract: onlyLang('tsx') },
    { lang: 'javascript', extract: onlyLang('javascript') },
  ],
  hooks: { postProcess },
};

export default spec;

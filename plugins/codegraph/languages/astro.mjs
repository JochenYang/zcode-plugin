// Astro components have no grammar: a file contributes only its embedded scripts
// (`support: 'script'`). The `---` fence at the top is the component frontmatter,
// which Astro always processes as TypeScript; `<script>` tags follow the HTML rule
// (`lang="ts"` -> typescript, otherwise JavaScript). Template markup is not indexed.
import { onlyLang } from './javascript.mjs';

// The fence must start on line 1; the body is everything up to the closing `---` line.
export function frontmatter(source) {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!m) return [];
  const text = m[1];
  if (!text.trim()) return [];
  const startLine = 2;
  const endLine = startLine + (text.trimEnd().match(/\n/g) ?? []).length;
  return [{ text, startLine, endLine }];
}

const spec = {
  id: 'astro',
  label: 'Astro',
  extensions: ['.astro'],
  support: 'script',
  embeddings: [
    { lang: 'typescript', extract: (source) => [...frontmatter(source), ...onlyLang('typescript')(source)] },
    { lang: 'tsx', extract: onlyLang('tsx') },
    { lang: 'javascript', extract: onlyLang('javascript') },
  ],
};

export default spec;

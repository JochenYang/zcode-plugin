// Svelte packs live in `support: 'script'` mode: there is no Svelte grammar, so the
// component file contributes only its script blocks. `<script context="module">` and
// the instance `<script>` are both extracted (in document order); `lang="ts"` routes a
// block to the TypeScript pack, otherwise it is JavaScript. Template markup is not
// indexed (Svelte 5 template functions are rare; runes live in the script).
import { onlyLang } from './javascript.mjs';

const spec = {
  id: 'svelte',
  label: 'Svelte',
  extensions: ['.svelte'],
  support: 'script',
  embeddings: [
    { lang: 'typescript', extract: onlyLang('typescript') },
    { lang: 'tsx', extract: onlyLang('tsx') },
    { lang: 'javascript', extract: onlyLang('javascript') },
  ],
};

export default spec;

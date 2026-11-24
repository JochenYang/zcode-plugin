// Vue SFCs. The bundled vue grammar only parses the outer structure (template / script /
// style elements, 23 KB, no script semantics); it is kept so template syntax errors still
// surface in parseOk/errorNodes. Script contents are embedded instead: `<script setup
// lang="ts">` goes to the typescript pack, a plain `<script>` to javascript.
import { onlyLang } from './javascript.mjs';

const spec = {
  id: 'vue',
  label: 'Vue',
  extensions: ['.vue'],
  grammar: 'vue',
  embeddings: [
    { lang: 'typescript', extract: onlyLang('typescript') },
    { lang: 'tsx', extract: onlyLang('tsx') },
    { lang: 'javascript', extract: onlyLang('javascript') },
  ],
};

export default spec;

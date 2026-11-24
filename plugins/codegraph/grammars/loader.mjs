// Loads the vendored tree-sitter runtime and grammar wasm files.
// Vendored on purpose: plugins installed from a marketplace never run `npm install`.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GRAMMARS_DIR } from '../src/paths.mjs';

let runtime = null; // { Parser, Language, Query }
const languages = new Map(); // grammarId -> Promise<Language>
const parsers = new Map(); // grammarId -> Parser (one per process/worker; parse() returns a fresh tree)
const queries = new Map(); // `${grammarId}/${name}` -> string | null

export function wasmPathFor(grammarId) {
  return path.join(GRAMMARS_DIR, 'wasm', `tree-sitter-${grammarId}.wasm`);
}

export function hasGrammar(grammarId) {
  return fs.existsSync(wasmPathFor(grammarId));
}

export async function initTreeSitter() {
  if (runtime) return runtime;
  const entry = pathToFileURL(path.join(GRAMMARS_DIR, 'runtime', 'web-tree-sitter.mjs')).href;
  const mod = await import(entry);
  const Parser = mod.Parser ?? mod.default?.Parser;
  const Language = mod.Language ?? mod.default?.Language;
  const Query = mod.Query ?? mod.default?.Query;
  if (!Parser || !Language || !Query) throw new Error(`tree-sitter runtime at ${entry} does not export Parser/Language/Query`);
  // Resolve the runtime wasm explicitly: the file is renamed to .mjs, so do not rely on import.meta.url heuristics.
  await Parser.init({
    locateFile: (scriptName) => pathToFileURL(path.join(GRAMMARS_DIR, 'runtime', path.basename(scriptName))).href,
  });
  runtime = { Parser, Language, Query };
  return runtime;
}

export async function loadLanguage(grammarId) {
  const { Language } = await initTreeSitter();
  let pending = languages.get(grammarId);
  if (!pending) {
    const file = wasmPathFor(grammarId);
    if (!fs.existsSync(file)) {
      throw new Error(`grammar "${grammarId}" is not bundled (missing ${path.basename(file)})`);
    }
    // web-tree-sitter reads the file with fs in Node: pass a native path, not a file: URL.
    pending = Language.load(file);
    pending.catch(() => languages.delete(grammarId));
    languages.set(grammarId, pending);
  }
  return pending;
}

// Parsers are reusable and hold native state; one per grammar per worker instead of one per file.
export async function parserFor(grammarId) {
  const { Parser } = await initTreeSitter();
  const language = await loadLanguage(grammarId);
  let parser = parsers.get(grammarId);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(language);
    parsers.set(grammarId, parser);
  }
  return parser;
}

// Reference queries shipped next to the wasm (tags.scm / locals.scm); null when absent.
// `; inherits: a, b` lines splice the base grammars' queries in front (tree-sitter convention).
export function queryTextFor(grammarId, name, seen = new Set()) {
  const key = `${grammarId}/${name}`;
  if (!queries.has(key)) {
    const file = path.join(GRAMMARS_DIR, 'queries', grammarId, `${name}.scm`);
    let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const inherit = /^;\s*inherits:\s*([^\n]+)/m.exec(text ?? '');
    if (inherit && !seen.has(grammarId)) {
      seen.add(grammarId);
      const bases = inherit[1].split(',').map((s) => s.trim()).filter(Boolean);
      text = bases.map((b) => queryTextFor(b, name, seen) ?? '').filter(Boolean).join('\n') + '\n' + text;
    }
    queries.set(key, text);
  }
  return queries.get(key);
}

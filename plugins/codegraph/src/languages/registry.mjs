// Discovers language packs in ../../languages/*.mjs. No central list: adding a
// language is one file, so parallel authors never edit a shared registry.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LANGUAGES_DIR } from '../paths.mjs';

let cache = null; // LanguageSpec[]
const byId = new Map();

const MERGE_KEYS = ['definitions', 'hooks'];
const CONCAT_KEYS = ['calls', 'imports', 'references', 'skipPatterns', 'recovery', 'embeddings', 'commentTypes', 'extensions'];

function materialize(raw, base) {
  const spec = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (base && MERGE_KEYS.includes(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      spec[key] = { ...(base[key] ?? {}), ...value };
    } else if (base && CONCAT_KEYS.includes(key) && Array.isArray(value)) {
      spec[key] = key === 'extensions' ? value : [...(base[key] ?? []), ...value];
    } else {
      spec[key] = value;
    }
  }
  return spec;
}

async function loadOne(id, seen = new Set()) {
  if (byId.has(id)) return byId.get(id);
  if (seen.has(id)) throw new Error(`language pack "${id}" extends itself`);
  seen.add(id);
  const file = path.join(LANGUAGES_DIR, `${id}.mjs`);
  if (!fs.existsSync(file)) throw new Error(`language pack "${id}" not found at ${file}`);
  const mod = await import(pathToFileURL(file).href);
  const raw = mod.default;
  if (!raw || raw.id !== id) throw new Error(`language pack ${file} must default-export { id: '${id}', ... }`);
  const base = raw.extends ? await loadOne(raw.extends, seen) : null;
  const spec = materialize(raw, base);
  spec.extends = raw.extends ?? null;
  spec.support ??= 'full';
  spec.commentTypes ??= ['comment', 'line_comment', 'block_comment'];
  spec.maxParseBytes ??= 4 * 1024 * 1024;
  spec.definitions ??= {};
  spec.calls ??= [];
  spec.imports ??= [];
  spec.references ??= [];
  spec.embeddings ??= [];
  spec.hooks ??= {};
  if (!Array.isArray(spec.extensions) || spec.extensions.length === 0) {
    throw new Error(`language pack "${id}" declares no extensions`);
  }
  byId.set(id, spec);
  return spec;
}

export async function loadSpecs({ strict = false } = {}) {
  if (cache) return cache;
  const ids = fs
    .readdirSync(LANGUAGES_DIR)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => f.slice(0, -4))
    .sort();
  loadErrors.length = 0;
  for (const id of ids) {
    try {
      await loadOne(id);
    } catch (err) {
      // A broken pack must not take the whole index down (a lane may be mid-write); tests run strict.
      if (strict) throw err;
      loadErrors.push({ id, message: err?.message ?? String(err) });
      process.stderr.write(`codegraph: skipping language pack "${id}": ${err?.message ?? err}\n`);
    }
  }
  cache = ids.filter((id) => byId.has(id)).map((id) => byId.get(id));
  return cache;
}

// Packs that failed to load in the last non-strict loadSpecs(): [{ id, message }].
export const loadErrors = [];

export function specById(id) {
  return byId.get(id) ?? null;
}

// Longest extension wins so `.d.ts` style multi-dot suffixes can be claimed by a pack.
export function specForPath(relativePath, specs = cache) {
  const p = String(relativePath).split('\\').join('/');
  const base = p.slice(p.lastIndexOf('/') + 1).toLowerCase();
  let best = null;
  let bestLen = 0;
  for (const spec of specs ?? []) {
    for (const ext of spec.extensions) {
      const e = ext.toLowerCase();
      if (base.length > e.length && base.endsWith(e) && e.length > bestLen) {
        best = spec;
        bestLen = e.length;
      }
    }
  }
  return best;
}

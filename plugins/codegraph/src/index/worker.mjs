// Extraction worker: owns one engine instance per thread (CONTRACTS.md §9). The
// main thread never parses; it hands over { type: 'extract', path, abs, lang,
// knownHash? } and gets back one of:
//   { type: 'result', path, extracted }   — fresh ExtractedFile
//   { type: 'unchanged', path, hash }     — content hashes to knownHash (mtime-only change)
//   { type: 'error', path, message, code?, hash? }
// `hash` on an error means the file was read but extraction failed, so the caller
// can record it as a parse failure instead of retrying on every sync.

import fs from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { initEngine, extractFile, specForPath, hashSource } from '../extract/engine.mjs';

await initEngine();
parentPort.postMessage({ type: 'ready' });

parentPort.on('message', async (msg) => {
  if (!msg || msg.type !== 'extract') return;
  const rel = msg.path;
  let text;
  try {
    text = fs.readFileSync(msg.abs, 'utf8');
  } catch (err) {
    parentPort.postMessage({ type: 'error', path: rel, message: `cannot read ${rel}: ${err.message}`, code: err.code ?? null });
    return;
  }
  let hash;
  try {
    hash = hashSource(text);
    if (msg.knownHash && msg.knownHash === hash) {
      parentPort.postMessage({ type: 'unchanged', path: rel, hash });
      return;
    }
    const spec = specForPath(rel);
    if (!spec) throw new Error(`no language pack matches "${rel}"`);
    const extracted = await extractFile({ path: rel, source: text, spec });
    parentPort.postMessage({ type: 'result', path: rel, extracted });
  } catch (err) {
    parentPort.postMessage({ type: 'error', path: rel, message: err?.message ?? String(err), code: null, hash });
  }
});

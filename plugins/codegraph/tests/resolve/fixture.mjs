// Shared helper for resolve / graph tests: index the ts-basic fixture project
// into an in-memory database with the real engine, then run the resolver.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../../src/store/db.mjs';
import { replaceFile } from '../../src/store/repo.mjs';
import { initEngine, extractFile, loadSpecs, specForPath } from '../../src/extract/engine.mjs';
import { resolveAll } from '../../src/resolve/pipeline.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT = path.join(HERE, '..', 'fixtures', 'projects', 'ts-basic');

let engine = null;
export function ensureEngine() {
  engine ??= initEngine();
  return engine;
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs, base));
    else out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out.sort();
}

/**
 * Index every supported file of the fixture into a fresh in-memory database.
 * @param {{ resolve?: boolean, project?: string }} [options]
 */
export async function buildProject({ resolve = true, project = PROJECT } = {}) {
  await ensureEngine();
  const specs = await loadSpecs();
  const db = openDatabase(':memory:');
  for (const rel of walk(project)) {
    const spec = specForPath(rel, specs);
    if (!spec) continue;
    const source = fs.readFileSync(path.join(project, rel), 'utf8');
    const out = await extractFile({ path: rel, source, spec });
    replaceFile(db, { path: rel, lang: out.lang, hash: out.hash, mtimeMs: 1, size: out.size, parseOk: out.parseOk, errorNodes: out.errorNodes, indexedAt: 1 }, out);
  }
  if (resolve) resolveAll(db);
  return db;
}

/** Every ref of a file with its resolution and target, in source order. */
export function refsOf(db, file) {
  return db.prepare(
    'SELECT r.id, r.name, r.receiver, r.kind, r.start_line AS line, r.resolution, r.target_id AS targetId, r.scope,' +
    ' s.name AS target, f2.path AS targetPath' +
    ' FROM refs r JOIN files f ON f.id = r.file_id LEFT JOIN symbols s ON s.id = r.target_id LEFT JOIN files f2 ON f2.id = s.file_id' +
    ' WHERE f.path = ? ORDER BY r.start_line, r.start_col, r.id'
  ).all(file);
}

/** The ref of `file` at `line` whose name (or receiver.name) is `name`. */
export function refAt(db, file, line, name, kind = null) {
  const hits = refsOf(db, file).filter((r) => r.line === line && (r.name === name || (r.receiver && `${r.receiver}.${r.name}` === name)) && (kind === null || r.kind === kind));
  if (hits.length !== 1) throw new Error(`expected exactly one ref ${name}@${file}:${line}, found ${hits.length}`);
  return hits[0];
}

export function importsOf(db, file) {
  return db.prepare(
    'SELECT i.*, f2.path AS resolved FROM imports i JOIN files f ON f.id = i.file_id LEFT JOIN files f2 ON f2.id = i.resolved_file_id WHERE f.path = ? ORDER BY i.start_line, i.id'
  ).all(file);
}

export function fileIdOf(db, file) {
  const row = db.prepare('SELECT id FROM files WHERE path = ?').get(file);
  if (!row) throw new Error(`no file ${file}`);
  return row.id;
}

export function symbolIdOf(db, file, name) {
  const row = db.prepare('SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ? AND s.name = ?').get(file, name);
  if (!row) throw new Error(`no symbol ${name} in ${file}`);
  return row.id;
}

export function closeQuietly(db) {
  try {
    db.close();
  } catch {
    // already closed
  }
}

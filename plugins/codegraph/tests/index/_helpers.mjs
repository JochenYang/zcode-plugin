// Shared setup for the indexer lane tests: every test gets a throwaway project
// directory under <repo>/.tmp/lane-a and ZCODE_PLUGIN_DATA pointed at a scratch
// data directory, so nothing touches the real plugin data. afterEach closes
// every Indexer before removing directories (Windows keeps handles locked).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN = path.resolve(HERE, '..', '..');
export const REPO = path.resolve(PLUGIN, '..', '..');
export const SCRATCH = path.join(REPO, '.tmp', 'lane-a');
export const FIXTURES = path.join(PLUGIN, 'tests', 'fixtures', 'langs', 'typescript');
export const SAMPLE = fs.readFileSync(path.join(FIXTURES, 'sample.ts'), 'utf8');
export const BROKEN = fs.readFileSync(path.join(FIXTURES, 'broken.ts'), 'utf8');

export function scratchDir(prefix) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  return fs.mkdtempSync(path.join(SCRATCH, `${prefix}-`));
}

/** Point the plugin data directory at a fresh scratch dir; returns it. */
export function useScratchData(prefix = 'data') {
  const dir = scratchDir(prefix);
  process.env.ZCODE_PLUGIN_DATA = dir;
  return dir;
}

export function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
}

export function writeProject(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Move a file's mtime into the future so an mtime/size scan sees a change. */
export function touch(abs, deltaMs = 2000) {
  const t = new Date(Date.now() + deltaMs);
  fs.utimesSync(abs, t, t);
}

export async function closeAll(indexers) {
  for (const ix of indexers.splice(0)) {
    try {
      await ix.close();
    } catch {
      // a failed test may have left a half-open indexer; cleanup must continue
    }
  }
}

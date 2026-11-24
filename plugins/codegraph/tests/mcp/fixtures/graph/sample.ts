// Fixture for tests/mcp/tools.test.mjs: indexed through the real extraction
// engine and read back from disk for the inline-body case. Keep it small and
// deterministic; the assertions name the symbols and lines below.
import { readFile } from 'node:fs';
import type { Options } from './options';

/** Parses a config string. */
export function parseConfig(src: string, opts?: Options): Config {
  const text = readFile(src, 'utf8');
  return validate(text, opts);
}

export class Loader {
  /** Loads once and caches. */
  load(file: string): Config {
    return parseConfig(file);
  }
}

export default function loadAll(dir: string): Config[] {
  return [new Loader().load(dir)];
}

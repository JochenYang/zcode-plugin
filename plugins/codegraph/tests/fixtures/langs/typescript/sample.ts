import { readFile } from 'node:fs';
import path from 'node:path';
import type { Options } from './options';

/** Parses a config string. */
export function parseConfig(src: string, opts?: Options): Config {
  const text = readFile(src, 'utf8');
  return validate(text, opts);
}

export class Loader {
  private cache = new Map<string, Config>();

  /** Loads once and caches. */
  load(file: string): Config {
    const key = path.resolve(file);
    if (!this.cache.has(key)) {
      this.cache.set(key, parseConfig(key));
    }
    return this.cache.get(key);
  }
}

const validate = (text: string, opts?: Options): Config => ({ text, opts });

interface Config {
  text: string;
  opts?: Options;
}

export default function loadAll(dir: string): Config[] {
  return [new Loader().load(dir)];
}

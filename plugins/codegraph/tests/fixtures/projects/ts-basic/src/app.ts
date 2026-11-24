import { helper, format } from './util';
import { helper as doubled } from './util';
import { Shape } from './shapes';
import { square } from './math';

export function run(n: number): number {
  let helper: (n: number) => number = doubled;
  const value = helper(n);
  const other = doubled(n);
  const shaped: Shape = Shape.create();
  const plus = (x: number) => x + 1;
  return square(value) + other + shaped.area() + plus(n) + format('x').length;
}

export function ambiguous(): string {
  return duplicated();
}

export async function loadLater(): Promise<unknown> {
  const mod = await import('./util');
  return mod;
}

const cache = new Map<string, number>();

export function memo(n: number): number {
  if (cache.has(n)) return cache.get(n) ?? 0;
  const result = helper(n);
  cache.set(n, result);
  return result;
}

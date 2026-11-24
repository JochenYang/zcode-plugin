import { helper } from '../util';
import { square } from '../math';

export function deep(n: number): number {
  return helper(square(n));
}

import { clamp } from './math.js';

/** The percentage a part is of a whole, clamped to 0..100. */
export function percent(part: number, whole: number): number {
  return whole === 0 ? 0 : clamp((part / whole) * 100, 0, 100);
}

/** The value held at or under the limit. */
export function clamp(value: number, limit: number): number {
  if (value > limit) return limit;
  return value;
}

/** Never called by a test. */
export function double(value: number): number {
  return value * 2;
}

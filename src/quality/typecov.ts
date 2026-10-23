import type { Policy } from '../core/finding.js';

/** Each package's shipped code stays at least this share typed, in percent. */
export const TYPE_COVERAGE_FLOOR = 99.5;

/** Whether `typed` of `total` identifiers reach the floor, in exact integers; none counts as all. */
export function reachesTypeFloor(typed: number, total: number): boolean {
  return typed * 1000 >= total * TYPE_COVERAGE_FLOOR * 10;
}

/** How far below the floor a percentage may fall and still be at it: division's rounding error. */
const ROUNDING = 1e-9;

/**
 * The policy for a package's untyped identifiers, from the package's percentage typed: each is a
 * `standard` finding below the floor, compared with the base commit, and `info` at or above it.
 */
export function untypedPolicy(percent: number): Policy {
  return percent >= TYPE_COVERAGE_FLOOR - ROUNDING ? 'info' : 'standard';
}

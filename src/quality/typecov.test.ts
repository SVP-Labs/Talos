import { describe, expect, it } from 'vitest';
import { reachesTypeFloor, TYPE_COVERAGE_FLOOR, untypedPolicy } from './typecov.js';

describe('the type coverage floor', () => {
  it('is 99.5%', () => {
    expect(TYPE_COVERAGE_FLOOR).toBe(99.5);
  });

  it('is reached in exact integers, and by a package with nothing to type', () => {
    expect(reachesTypeFloor(995, 1000)).toBe(true);
    expect(reachesTypeFloor(994, 1000)).toBe(false);
    expect(reachesTypeFloor(199, 200)).toBe(true);
    expect(reachesTypeFloor(0, 0)).toBe(true);
  });

  it('makes untyped identifiers standard findings below it and info at or above it', () => {
    expect(untypedPolicy(99.49)).toBe('standard');
    expect(untypedPolicy(99.5)).toBe('info');
    expect(untypedPolicy((199 / 200) * 100)).toBe('info');
    expect(untypedPolicy(100)).toBe('info');
  });
});

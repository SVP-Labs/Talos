import { describe, expect, it } from 'vitest';
import { percent } from './index.js';
import { clamp } from './math.js';

describe('clamp', () => {
  it('holds a value between its bounds', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});

describe('percent', () => {
  it('is a clamped share of the whole', () => {
    expect(percent(1, 4)).toBe(25);
    expect(percent(5, 4)).toBe(100);
    expect(percent(1, 0)).toBe(0);
  });
});

import { expect, it } from 'vitest';
import { clamp } from './clamp.js';

it('clamps a large value', () => {
  expect(clamp(20, 10)).toBe(10);
});

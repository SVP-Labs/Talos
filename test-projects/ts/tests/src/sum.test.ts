import { expect, it } from 'vitest';
import { sum } from './sum.js';

it('adds', () => {
  expect(sum(2, 2)).toBe(4);
});

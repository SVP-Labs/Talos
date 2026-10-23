import { expect, test } from '@playwright/test';

test('adds up', () => {
  expect(1 + 1).toBe(2);
});

test('fails on purpose', () => {
  expect(1 + 1).toBe(3);
});

import { describe, expect, it } from 'vitest';
import { enclosing } from './lint.js';

describe('enclosing', () => {
  const spans = {
    functions: [
      { name: 'first', owner: '', start: 1, end: 5 },
      { name: 'outer', owner: '', start: 8, end: 30 },
      { name: 'inner', owner: null, start: 12, end: 20 },
    ],
    docstrings: [],
  };

  it('finds the innermost function a line belongs to', () => {
    expect(enclosing(spans, 9)?.name).toBe('outer');
    expect(enclosing(spans, 12)?.name).toBe('inner');
    expect(enclosing(spans, 25)?.name).toBe('outer');
    expect(enclosing(spans, 6)).toBeUndefined();
    expect(enclosing(undefined, 6)).toBeUndefined();
  });
});

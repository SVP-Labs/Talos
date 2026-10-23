import { describe, expect, it } from 'vitest';
import { chunks, parseJson } from './run.js';

describe('chunks', () => {
  it('keeps each run of arguments under the limit, counting each quoted with a space', () => {
    expect(chunks(['aaaa', 'bbbb', 'cc', 'd'], 14)).toEqual([
      ['aaaa', 'bbbb'],
      ['cc', 'd'],
    ]);
    expect(chunks(['aaaa', 'bbbb'], 13)).toEqual([['aaaa'], ['bbbb']]);
    expect(chunks([], 10)).toEqual([]);
    expect(chunks(['a-very-long-argument'], 5)).toEqual([['a-very-long-argument']]);
  });
});

describe('parseJson', () => {
  it('reads JSON and names the tool when it cannot', () => {
    expect(parseJson('{"a":1}', 'x')).toEqual({ a: 1 });
    expect(() => parseJson('oops', 'luacheck')).toThrow(/luacheck printed no readable JSON: oops/);
  });
});

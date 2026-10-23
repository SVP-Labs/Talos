import { describe, expect, it } from 'vitest';
import { literalMatches, matchNaming, setsKey } from './literal.js';

const WORD = { start: /(?<![\p{L}\p{N}_-])/uy, end: /(?![\p{L}\p{N}_-])/uy };
/** No `#` stands in these texts, so these edges pass everywhere. */
const ANYWHERE = { start: /(?<!#)/y, end: /(?!#)/y };

describe('literalMatches', () => {
  it('finds the needle as written, never as a pattern', () => {
    expect(literalMatches('a.b axb a.b', 'a.b', ANYWHERE)).toEqual([0, 8]);
    expect(literalMatches('(x+)* [y] (x+)*', '(x+)*', ANYWHERE)).toEqual([0, 10]);
    expect(literalMatches('a\\d 1', String.raw`\d`, ANYWHERE)).toEqual([1]);
  });

  it('keeps to the edges, left to right and without overlap', () => {
    expect(literalMatches('cat cats scat cat', 'cat', WORD)).toEqual([0, 14]);
    expect(literalMatches('aaaa', 'aa', ANYWHERE)).toEqual([0, 2]);
    expect(literalMatches('ab-ab ab', 'ab', WORD)).toEqual([6]);
  });

  it('matches either case only when asked', () => {
    expect(literalMatches('Cat CAT cat', 'cat', WORD)).toEqual([8]);
    expect(literalMatches('Cat CAT cat', 'cat', WORD, true)).toEqual([0, 4, 8]);
    expect(literalMatches('Fuß FUẞ', 'fuß', WORD, true)).toEqual([0, 4]);
    expect(literalMatches('ſun Σος', 'sun σοσ', WORD, true)).toEqual([0]);
    expect(literalMatches('İs', 'is', WORD, true)).toEqual([]);
  });

  it('steps over characters outside the basic plane whole', () => {
    expect(literalMatches('😀a 😀😀', '😀', ANYWHERE, true)).toEqual([0, 4, 6]);
    expect(literalMatches('😀x ax x', 'x', WORD, true)).toEqual([2, 7]);
  });

  it('finds nothing for an empty needle or past the text', () => {
    expect(literalMatches('abc', '', ANYWHERE)).toEqual([]);
    expect(literalMatches('ab', 'abc', ANYWHERE, true)).toEqual([]);
    expect(literalMatches('', 'a', ANYWHERE, true)).toEqual([]);
  });
});

describe('setsKey', () => {
  it('reads a key bare or quoted, before its separator', () => {
    expect(setsKey('serde = "1"', 'serde', '=')).toBe(true);
    expect(setsKey('  "serde"= { version = "1" }', 'serde', '=')).toBe(true);
    expect(setsKey("\t'node' : 22", 'node', ':')).toBe(true);
    expect(setsKey('node:22', 'node', ':')).toBe(true);
  });

  it('refuses another key, a longer one, or another separator', () => {
    expect(setsKey('serde_json = "1"', 'serde', '=')).toBe(false);
    expect(setsKey('serde: 1', 'serde', '=')).toBe(false);
    expect(setsKey('# serde = "1"', 'serde', '=')).toBe(false);
    expect(setsKey('"serde" "= 1', 'serde', '=')).toBe(false);
  });

  it('compares a key with metacharacters as written', () => {
    expect(setsKey('a.b = 1', 'a.b', '=')).toBe(true);
    expect(setsKey('axb = 1', 'a.b', '=')).toBe(false);
    expect(setsKey('c++ = 1', 'c++', '=')).toBe(true);
  });
});

describe('matchNaming', () => {
  const LABEL = /^[ \t]*([A-Za-z_]\w*)/gm;

  it('finds the first match from a place on whose group is the name', () => {
    const text = 'END\n  ENDS\n  END;\nEND';
    const found = matchNaming(LABEL, text, 4, 'END');
    expect(found?.index).toBe(11);
    expect(found?.[0]).toBe('  END');
    expect(matchNaming(LABEL, text, 0, 'END')?.index).toBe(0);
  });

  it('finds nothing when no match names it', () => {
    expect(matchNaming(LABEL, 'ENDS\nEN', 0, 'END')).toBeUndefined();
  });

  it('moves on past an empty match', () => {
    expect(matchNaming(/(b?)/g, 'aab', 0, 'b')?.index).toBe(2);
  });
});

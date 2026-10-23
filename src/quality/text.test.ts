import { describe, expect, it } from 'vitest';
import { clip, firstLine, lastLines, lineRanges } from './text.js';

describe('clip', () => {
  it('collapses whitespace and cuts long text with an ellipsis', () => {
    expect(clip('  a \n\t b  ', 10)).toBe('a b');
    expect(clip('abcdefghij', 10)).toBe('abcdefghij');
    expect(clip('clip this sentence', 9)).toBe('clip thi…');
  });
});

describe('firstLine', () => {
  it('takes the first line that says something', () => {
    expect(firstLine('\n  \r\nexpected 3 to be 4\nat x')).toBe('expected 3 to be 4');
    expect(firstLine('')).toBe('');
    expect(firstLine(`${'x'.repeat(200)}\n`, 20)).toHaveLength(20);
  });
});

describe('lastLines', () => {
  it('keeps the last lines, each clipped', () => {
    const output = ['one', 'two', 'three', 'y'.repeat(30), ''].join('\n');
    expect(lastLines(output, 2, 10)).toBe(`three\n${'y'.repeat(9)}…`);
    expect(lastLines('a\r\nb\n')).toBe('a\nb');
  });
});

describe('lineRanges', () => {
  it('joins runs of lines, deduplicated and sorted', () => {
    expect(lineRanges([9, 3, 4, 5, 4, 12])).toBe('3-5,9,12');
    expect(lineRanges([])).toBe('');
  });
});

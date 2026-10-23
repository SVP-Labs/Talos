import { describe, expect, it } from 'vitest';
import { countedLines, MAX_FILE_LINES, sizeFindings } from './sizes.js';
import { parseSpans } from './spans.js';

describe('countedLines', () => {
  it('skips blank lines, comments and docstrings', () => {
    const text =
      '"""Module."""\n\n# note\nx = 1\ndef f():\n    """Doc\n    more."""\n    return x\n';
    expect(
      countedLines(text, [
        [1, 1],
        [6, 7],
      ]),
    ).toEqual([false, false, false, false, true, true, false, false, true]);
  });
});

function body(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `    total += ${i}`).join('\n');
}

describe('sizeFindings', () => {
  it('reports a function over 60 lines of code, decorators to last line', () => {
    const text = `@cache\ndef long() -> int:\n    """Doc."""\n${body(59)}\n    return total\n`;
    const spans = { functions: [{ name: 'long', owner: '', start: 1, end: 63 }], docstrings: [] };
    expect(sizeFindings('src/m.py', text, { ...spans, docstrings: [[3, 3]] })).toEqual([
      {
        rule: 'talos/max-lines-per-function',
        message: "Function 'long' has 62 lines of code; the most allowed is 60.",
        location: { file: 'src/m.py', line: 1, endLine: 63 },
      },
    ]);
    expect(sizeFindings('src/m.py', text, spans)[0]?.message).toContain('63 lines');
  });

  it('reports a file over 400 lines of code from the first line past the limit', () => {
    const constants = Array.from({ length: MAX_FILE_LINES + 2 }, (_, i) => `X${i} = ${i}`);
    const text = ['"""Doc."""', ...constants, ''].join('\n');
    expect(sizeFindings('a.py', text, { functions: [], docstrings: [[1, 1]] })).toEqual([
      {
        rule: 'talos/max-lines',
        message: 'This file has 402 lines of code; the most allowed is 400.',
        location: { file: 'a.py', line: 402, endLine: 403 },
      },
    ]);
  });

  it('finds nothing in code within the limits', () => {
    expect(sizeFindings('a.py', 'x = 1\n', { functions: [], docstrings: [] })).toEqual([]);
  });
});

describe('parseSpans', () => {
  it('reads the span script’s output and drops files that did not parse', () => {
    // Recorded from the span script on Python 3.13.
    const text =
      '{"src/demo/risk.py": {"functions": [{"name": "score", "owner": "", "start": 4, ' +
      '"end": 8}], "docstrings": [[1, 1], [5, 5]]}, "broken.py": null}\n';
    const spans = parseSpans(text);
    expect([...spans.keys()]).toEqual(['src/demo/risk.py']);
    expect(spans.get('src/demo/risk.py')?.functions[0]).toEqual({
      name: 'score',
      owner: '',
      start: 4,
      end: 8,
    });
  });

  it('refuses other output', () => {
    expect(() => parseSpans('{"a.py": {"functions": 1}}')).toThrow();
  });
});

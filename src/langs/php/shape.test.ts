import { describe, expect, it } from 'vitest';
import { parseShapes, shapeFindings, type Span, widen } from './shape.js';
import { EngineError } from '../../core/check.js';

// Recorded from the shape script under PHP 8.4 with nikic/php-parser 5, paths shortened.
const REPORT = {
  format: 'talos-php-shape/1',
  files: [
    {
      file: 'src/Messy.php',
      lines: 73,
      overFrom: null,
      lastLine: 82,
      deep: [{ line: 66, endLine: 70 }],
      spans: [
        { line: 7, endLine: 82, kind: 'class' },
        { line: 9, endLine: 12, kind: 'function' },
        { line: 60, endLine: 76, kind: 'function' },
      ],
    },
    { file: 'src/Broken.php', error: 'Syntax error, unexpected EOF, expecting T_VARIABLE' },
    { file: 'src/Rates.php', lines: 418, overFrom: 405, lastLine: 422, deep: [], spans: [] },
    { file: 'tests/BigTest.php', lines: 500, overFrom: 450, lastLine: 520, deep: [], spans: [] },
  ],
};

describe('parseShapes', () => {
  it('reads each file, or the error that kept it from being parsed', () => {
    const shapes = parseShapes(REPORT);
    expect(shapes).toHaveLength(4);
    expect(shapes[1]).toEqual(REPORT.files[1]);
    expect(() => parseShapes({ format: 'other', files: [] })).toThrow(EngineError);
  });
});

describe('shapeFindings', () => {
  it('reports each block nested too deep and files over the limit, tests exempt from size', () => {
    expect(shapeFindings(parseShapes(REPORT))).toEqual([
      {
        rule: 'talos/max-depth',
        message: 'This block is nested 4 deep; the most allowed is 3.',
        location: { file: 'src/Messy.php', line: 66, endLine: 70 },
      },
      {
        rule: 'talos/max-lines',
        message: 'This file has 418 lines of code; the most allowed is 400.',
        location: { file: 'src/Rates.php', line: 405, endLine: 422 },
      },
    ]);
  });
});

describe('widen', () => {
  const spans: Span[] = [
    { line: 7, endLine: 82, kind: 'class' },
    { line: 60, endLine: 76, kind: 'function' },
  ];

  it('spans a complexity finding over its whole function or class', () => {
    const fn = {
      rule: 'phpstan/complexity.functionLike',
      message: 'x',
      location: { file: 'a', line: 60 },
    };
    expect(widen(fn, spans).location).toEqual({ file: 'a', line: 60, endLine: 76 });
    const cls = {
      rule: 'phpstan/complexity.classLike',
      message: 'x',
      location: { file: 'a', line: 7 },
    };
    expect(widen(cls, spans).location).toEqual({ file: 'a', line: 7, endLine: 82 });
  });

  it('leaves a finding it cannot place as it is', () => {
    const lost = {
      rule: 'phpstan/complexity.functionLike',
      message: 'x',
      location: { file: 'a', line: 3 },
    };
    expect(widen(lost, spans)).toBe(lost);
    const keyed = { rule: 'phpstan/complexity.functionLike', message: 'x', key: 'k' };
    expect(widen(keyed, spans)).toBe(keyed);
  });
});

import { describe, expect, it } from 'vitest';
import { parseRuffJson, sentence } from './ruff.js';
import { EngineError } from '../../core/check.js';

// Recorded from ruff 0.17.2 (`fix` objects dropped): a syntax error, a rule, and the formatter.
const CHECK = `[
 {"cell": null, "code": null, "end_location": {"column": 8, "row": 1},
  "filename": "/repo/bad.py", "location": {"column": 7, "row": 1},
  "message": "Expected a parameter or the end of the parameter list", "name": "invalid-syntax",
  "noqa_row": null, "severity": "error", "url": null},
 {"cell": null, "code": "C901", "end_location": {"column": 12, "row": 4},
  "filename": "/repo/src/pkg/mod.py", "location": {"column": 5, "row": 4},
  "message": "\`classify\` is too complex (14 > 12)", "name": "complex-structure", "noqa_row": 4,
  "severity": "error", "url": "https://docs.astral.sh/ruff/rules/complex-structure"}
]`;

const FORMAT = `[
 {"cell": null, "code": "unformatted", "end_location": {"column": 10, "row": 3},
  "filename": "/repo/src/demo/fmt.py", "location": {"column": 8, "row": 1},
  "message": "File would be reformatted", "name": "unformatted", "noqa_row": null,
  "severity": "error", "url": null}
]`;

describe('parseRuffJson', () => {
  it('reads rules, their spans and docs, and names syntax errors', () => {
    expect(parseRuffJson(CHECK)).toEqual([
      {
        code: 'invalid-syntax',
        message: 'Expected a parameter or the end of the parameter list',
        file: '/repo/bad.py',
        line: 1,
        endLine: 1,
        column: 7,
      },
      {
        code: 'C901',
        message: '`classify` is too complex (14 > 12)',
        file: '/repo/src/pkg/mod.py',
        line: 4,
        endLine: 4,
        column: 5,
        url: 'https://docs.astral.sh/ruff/rules/complex-structure',
      },
    ]);
  });

  it('reads the formatter’s report, one span per file', () => {
    expect(parseRuffJson(FORMAT)).toMatchObject([
      { code: 'unformatted', file: '/repo/src/demo/fmt.py', line: 1, endLine: 3 },
    ]);
  });

  it('takes empty output as no findings and refuses anything else', () => {
    expect(parseRuffJson('')).toEqual([]);
    expect(() => parseRuffJson('error: failed to parse')).toThrow(EngineError);
    expect(() => parseRuffJson('[{"code": 1}]')).toThrow(EngineError);
  });
});

describe('sentence', () => {
  it('keeps the first line and ends it with a full stop', () => {
    expect(sentence('`os` imported but unused')).toBe('`os` imported but unused.');
    expect(sentence('Type is wrong.\n  detail')).toBe('Type is wrong.');
    expect(sentence('x'.repeat(300), 10)).toBe(`${'x'.repeat(9)}….`);
  });
});

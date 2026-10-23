import { describe, expect, it } from 'vitest';
import { parseBasedpyright } from './types.js';
import { EngineError } from '../../core/check.js';

// Recorded from basedpyright 1.40.2 --outputjson, which starts with a blank line.
const OUTPUT = `
{
    "version": "1.40.2",
    "time": "1792754675553",
    "generalDiagnostics": [
        {
            "file": "/repo/src/demo/calc.py",
            "severity": "error",
            "message": "Type \`Any\` is not allowed",
            "range": {"start": {"line": 11, "character": 21}, "end": {"line": 11, "character": 24}},
            "rule": "reportExplicitAny"
        },
        {
            "file": "/repo/src/demo/calc.py",
            "severity": "error",
            "message": "Type \\"str\\" is not assignable to return type \\"int\\"\\n  \\"str\\" is not assignable to \\"int\\"",
            "range": {"start": {"line": 13, "character": 11}, "end": {"line": 14, "character": 2}},
            "rule": "reportReturnType"
        },
        {
            "file": "/repo/src/demo/calc.py",
            "severity": "error",
            "message": "Expected expression",
            "range": {"start": {"line": 20, "character": 0}, "end": {"line": 20, "character": 1}}
        },
        {
            "file": "/repo/src/demo/calc.py",
            "severity": "information",
            "message": "Type of \\"x\\" is \\"int\\"",
            "range": {"start": {"line": 30, "character": 12}, "end": {"line": 30, "character": 13}}
        }
    ],
    "summary": {"filesAnalyzed": 1, "errorCount": 3, "warningCount": 0, "informationCount": 1, "timeInSec": 0.3}
}`;

describe('parseBasedpyright', () => {
  it('reads rules and 1-based spans, and drops rule-less notes', () => {
    expect(parseBasedpyright(OUTPUT)).toEqual([
      {
        file: '/repo/src/demo/calc.py',
        rule: 'reportExplicitAny',
        message: 'Type `Any` is not allowed',
        line: 12,
        endLine: 12,
        column: 22,
      },
      {
        file: '/repo/src/demo/calc.py',
        rule: 'reportReturnType',
        message: 'Type "str" is not assignable to return type "int"\n  "str" is not assignable to "int"',
        line: 14,
        endLine: 15,
        column: 12,
      },
      {
        file: '/repo/src/demo/calc.py',
        rule: 'error',
        message: 'Expected expression',
        line: 21,
        endLine: 21,
        column: 1,
      },
    ]);
  });

  it('refuses output it cannot read', () => {
    expect(() => parseBasedpyright('Config file could not be read')).toThrow(EngineError);
    expect(() => parseBasedpyright('{"summary": {}}')).toThrow(EngineError);
  });
});

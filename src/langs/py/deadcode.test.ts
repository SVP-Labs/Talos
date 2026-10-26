import { describe, expect, it } from 'vitest';
import { parseVulture } from './deadcode.js';

// Recorded from vulture 2.16 with --min-confidence 0 --sort-by-size.
const OUTPUT = `src/demo/calc.py:3: unused import 'os' (90% confidence, 1 line)
tests/test_fix.py:4: unreachable code after 'return' (100% confidence, 1 line)
src/demo/calc.py:12: unused function 'unused_helper' (60% confidence, 2 lines)
src/demo/calc.py:16: unused function 'branchy' (60% confidence, 7 lines)
src/demo/shapes.py:3: unused attribute 'colour' (60% confidence, 1 line)
src/demo/loop.py:2: unsatisfiable 'while' condition (100% confidence, 3 lines)
`;

describe('parseVulture', () => {
  it('reads each item with its code, span and a plain message', () => {
    expect(parseVulture(OUTPUT)).toEqual([
      {
        file: 'src/demo/calc.py',
        line: 3,
        endLine: 3,
        code: 'V104',
        message: "The import 'os' is never used.",
      },
      {
        file: 'tests/test_fix.py',
        line: 4,
        endLine: 4,
        code: 'V201',
        message: "Unreachable code after 'return'.",
      },
      {
        file: 'src/demo/calc.py',
        line: 12,
        endLine: 13,
        code: 'V103',
        message: "The function 'unused_helper' is never used.",
      },
      {
        file: 'src/demo/calc.py',
        line: 16,
        endLine: 22,
        code: 'V103',
        message: "The function 'branchy' is never used.",
      },
      {
        file: 'src/demo/shapes.py',
        line: 3,
        endLine: 3,
        code: 'V101',
        message: "The attribute 'colour' is never used.",
      },
      {
        file: 'src/demo/loop.py',
        line: 2,
        endLine: 4,
        code: 'V201',
        message: "Unsatisfiable 'while' condition.",
      },
    ]);
  });

  it('reads lines without a size and skips anything else', () => {
    expect(
      parseVulture("a.py:3: unused variable 'x' (60% confidence)\nError: a.py: invalid syntax\n"),
    ).toEqual([
      {
        file: 'a.py',
        line: 3,
        endLine: 3,
        code: 'V107',
        message: "The variable 'x' is never used.",
      },
    ]);
  });
});

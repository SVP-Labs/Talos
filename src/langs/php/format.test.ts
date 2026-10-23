import { describe, expect, it } from 'vitest';
import { changedSpan, formatFinding, parsePintJson } from './format.js';
import { EngineError } from '../../core/check.js';

// Recorded from pint 1.32.1 fixing a copy (`-v --format=json`), its diff dropped; a file it
// could not parse is reported on a line of its own before the JSON.
const REPORT = `  ERROR /tmp/pc/src/Broken.php: Parse error: Unclosed '(' on line 2 on line 3.
{"about":"PHP CS Fixer 3.95.25",
"files":[{"name":"src\\/Ledger.php","appliedFixers":["function_declaration","braces_position",
"statement_indentation","return_type_declaration","binary_operator_spaces","array_syntax"]}],
"time":{"total":0},"memory":0}`;

describe('parsePintJson', () => {
  it('reads each file pint changed and the fixers it applied', () => {
    const json: unknown = JSON.parse(REPORT.slice(REPORT.indexOf('{')));
    expect(parsePintJson(json)).toEqual([
      {
        path: 'src/Ledger.php',
        fixers: [
          'function_declaration',
          'braces_position',
          'statement_indentation',
          'return_type_declaration',
          'binary_operator_spaces',
          'array_syntax',
        ],
      },
    ]);
    expect(parsePintJson({ files: [] })).toEqual([]);
    expect(() => parsePintJson({ files: [{ path: 'x' }] })).toThrow(EngineError);
  });
});

describe('changedSpan', () => {
  it('spans the first to the last line that differs, on the original side', () => {
    const before = 'a\nb\nc( x )\nd\ne\n';
    const after = 'a\nb\nc(x)\nd\ne\n';
    expect(changedSpan(before, after)).toEqual({ line: 3, endLine: 3 });
    expect(changedSpan('a\nf() { x; }\nz\n', 'a\nf()\n{\n    x;\n}\nz\n')).toEqual({
      line: 2,
      endLine: 2,
    });
    expect(changedSpan('<?php\nx;\n', '<?php\n\ndeclare(strict_types=1);\n\nx;\n')).toEqual({
      line: 2,
      endLine: 2,
    });
    expect(changedSpan('same\n', 'same\n')).toBeUndefined();
  });
});

describe('formatFinding', () => {
  it('names the lines and the first fixers', () => {
    const fixers = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(formatFinding('src/X.php', { line: 3, endLine: 7 }, fixers)).toEqual({
      rule: 'pint/format',
      message: 'Lines 3 to 7 are not formatted the way pint writes them (a, b, c, d, e, …).',
      location: { file: 'src/X.php', line: 3, endLine: 7 },
    });
    expect(formatFinding('src/X.php', { line: 2, endLine: 2 }, []).message).toBe(
      'Line 2 is not formatted the way pint writes them.',
    );
  });
});

import { describe, expect, it } from 'vitest';
import {
  diffSides,
  type Mutant,
  mutantFinding,
  mutantKey,
  parseCargoMutants,
  parseInfection,
  parseMutmut,
  parseStryker,
  sliceSpan,
} from './mutants.js';
import { EngineError } from '../core/check.js';
import { MUTMUT_REPORT } from '../langs/py/mutmut-report.js';

const SUM = `export function sum(a: number, b: number): number {
  return a + b;
}

export function sign(n: number): number {
  if (n > 0) {
    return 1;
  }
  if (n < 0) {
    return -1;
  }
  return 0;
}
`;

describe('sliceSpan', () => {
  it('cuts the text between two 1-based positions, the end excluded', () => {
    expect(sliceSpan(SUM, { line: 6, column: 7 }, { line: 6, column: 12 })).toBe('n > 0');
    expect(sliceSpan(SUM, { line: 6, column: 14 }, { line: 8, column: 4 })).toBe(
      '{\n    return 1;\n  }',
    );
    expect(sliceSpan('a\r\nbc', { line: 2, column: 1 }, { line: 2, column: 2 })).toBe('b');
    expect(sliceSpan('a', { line: 5, column: 1 }, { line: 5, column: 3 })).toBe('');
  });
});

// Recorded from Stryker 9 with the Vitest runner (`reporters: ['json']`), trimmed.
const STRYKER = JSON.stringify({
  files: {
    'src/sum.ts': {
      language: 'typescript',
      source: SUM,
      mutants: [
        {
          id: '9',
          mutatorName: 'ConditionalExpression',
          replacement: 'false',
          status: 'NoCoverage',
          static: false,
          coveredBy: [],
          location: { end: { column: 12, line: 9 }, start: { column: 7, line: 9 } },
        },
        {
          id: '1',
          mutatorName: 'ArithmeticOperator',
          replacement: 'a - b',
          statusReason: 'expected -1 to be 3 // Object.is equality',
          status: 'Killed',
          location: { end: { column: 15, line: 2 }, start: { column: 10, line: 2 } },
        },
        {
          id: '13',
          mutatorName: 'EqualityOperator',
          replacement: 'n >= 0',
          status: 'Survived',
          location: { end: { column: 12, line: 6 }, start: { column: 7, line: 6 } },
        },
        {
          id: '15',
          mutatorName: 'BlockStatement',
          status: 'Survived',
          location: { end: { column: 4, line: 8 }, start: { column: 14, line: 6 } },
        },
      ],
    },
  },
  schemaVersion: '1.0',
  thresholds: { high: 80, low: 60 },
});

describe('parseStryker', () => {
  it('reads each mutant’s fate, place, and the code it replaced', () => {
    expect(parseStryker(STRYKER)).toEqual<Mutant[]>([
      {
        file: 'src/sum.ts',
        line: 9,
        endLine: 9,
        mutator: 'ConditionalExpression',
        original: 'n < 0',
        replacement: 'false',
        status: 'no-coverage',
      },
      {
        file: 'src/sum.ts',
        line: 2,
        endLine: 2,
        mutator: 'ArithmeticOperator',
        original: 'a + b',
        replacement: 'a - b',
        status: 'other',
      },
      {
        file: 'src/sum.ts',
        line: 6,
        endLine: 6,
        mutator: 'EqualityOperator',
        original: 'n > 0',
        replacement: 'n >= 0',
        status: 'survived',
      },
      {
        file: 'src/sum.ts',
        line: 6,
        endLine: 8,
        mutator: 'BlockStatement',
        original: '{\n    return 1;\n  }',
        replacement: '',
        status: 'survived',
      },
    ]);
  });

  it('throws an engine error for text that isn’t a mutation-testing report', () => {
    expect(() => parseStryker('{')).toThrow(new EngineError('the Stryker report is not JSON'));
    expect(() => parseStryker('{"files": {}}')).toThrow(
      'the Stryker report is not a mutation-testing report',
    );
  });
});

// Recorded from Infection 0.35 (`logs.json`), trimmed: source texts and output dropped.
const INFECTION = JSON.stringify({
  stats: { totalMutantsCount: 3, killedCount: 1, notCoveredCount: 1, escapedCount: 1 },
  escaped: [
    {
      mutator: {
        mutatorName: 'Identical',
        originalFilePath: '/w/src/Calculator.php',
        originalStartLine: 31,
      },
      diff: '@@ @@\n             while ($n > 10) {\n-                    if ($i === 2) {\n+                    if ($i !== 2) {\n                         $n--;',
      processOutput: '',
    },
  ],
  killed: [
    {
      mutator: {
        mutatorName: 'PublicVisibility',
        originalFilePath: '/w/src/Calculator.php',
        originalStartLine: 11,
      },
      diff: '@@ @@\n-    public function add(int $a, int $b): int\n+    protected function add(int $a, int $b): int',
      processOutput: '',
    },
  ],
  errored: [],
  syntaxErrors: [],
  uncovered: [
    {
      mutator: {
        mutatorName: 'ReturnRemoval',
        originalFilePath: '/w/src/Calculator.php',
        originalStartLine: 18,
        originalEndLine: 18,
      },
      diff: '@@ @@\n\n     public function untyped($value)\n     {\n-        return $value;\n+\n     }',
      processOutput: '',
    },
  ],
  ignored: [],
});

describe('diffSides', () => {
  it('takes the removed and added lines after the hunk header', () => {
    expect(diffSides('--- a\n+++ b\n@@ @@\n x\n-  old\n- more\n+  new\n')).toEqual({
      original: 'old\nmore',
      replacement: 'new',
    });
  });
});

describe('parseInfection', () => {
  it('reads escaped mutants as survived and uncovered ones as no-coverage', () => {
    expect(parseInfection(INFECTION)).toEqual<Mutant[]>([
      {
        file: '/w/src/Calculator.php',
        line: 31,
        mutator: 'Identical',
        original: 'if ($i === 2) {',
        replacement: 'if ($i !== 2) {',
        status: 'survived',
      },
      {
        file: '/w/src/Calculator.php',
        line: 18,
        endLine: 18,
        mutator: 'ReturnRemoval',
        original: 'return $value;',
        replacement: '',
        status: 'no-coverage',
      },
    ]);
  });

  it('reads a log with nothing escaped, and throws for another document', () => {
    expect(parseInfection('{"stats": {}}')).toEqual([]);
    expect(() => parseInfection('[]')).toThrow(
      new EngineError('the Infection report is not an Infection JSON log'),
    );
    expect(() => parseInfection('')).toThrow('the Infection report is not JSON');
  });
});

const QUIET = `//! Quiet.

/// Is it quiet.
#[must_use]
pub fn is_quiet(hour: u8) -> bool {
    hour < 7 || hour > 22
}
`;

function cargoMutant(name: string, extra: Record<string, unknown>) {
  return {
    name,
    package: 'demo-core',
    file: 'core/src/quiet.rs',
    function: { function_name: 'is_quiet', return_type: '-> bool' },
    ...extra,
  };
}

// Recorded from cargo-mutants 27.1 (`mutants.out/outcomes.json`), trimmed.
const CARGO = JSON.stringify({
  outcomes: [
    { scenario: 'Baseline', summary: 'Success', log_path: 'log/baseline.log' },
    {
      scenario: {
        Mutant: cargoMutant('core/src/quiet.rs:6:5: replace is_quiet -> bool with true', {
          span: { start: { line: 6, column: 5 }, end: { line: 6, column: 26 } },
          replacement: 'true',
          genre: 'FnValue',
        }),
      },
      summary: 'CaughtMutant',
    },
    {
      scenario: {
        Mutant: cargoMutant('core/src/quiet.rs:6:10: replace < with <= in is_quiet', {
          span: { start: { line: 6, column: 10 }, end: { line: 6, column: 11 } },
          replacement: '<=',
          genre: 'BinaryOperator',
        }),
      },
      summary: 'MissedMutant',
    },
    {
      scenario: {
        Mutant: cargoMutant('core/src/quiet.rs:6:22: replace > with == in is_quiet', {
          replacement: '==',
          genre: 'BinaryOperator',
        }),
      },
      summary: 'MissedMutant',
    },
  ],
  total_mutants: 3,
  missed: 2,
  caught: 1,
  cargo_mutants_version: '27.1.0',
});

describe('parseCargoMutants', () => {
  it('reads missed mutants as survived, the original code from the source', () => {
    const asked: string[] = [];
    const mutants = parseCargoMutants(CARGO, (file) => {
      asked.push(file);
      return QUIET;
    });
    expect(mutants).toEqual<Mutant[]>([
      {
        file: 'core/src/quiet.rs',
        line: 6,
        endLine: 6,
        mutator: 'FnValue',
        original: 'hour < 7 || hour > 22',
        replacement: 'true',
        status: 'other',
      },
      {
        file: 'core/src/quiet.rs',
        line: 6,
        endLine: 6,
        mutator: 'BinaryOperator',
        original: '<',
        replacement: '<=',
        status: 'survived',
      },
      {
        file: 'core/src/quiet.rs',
        line: 6,
        mutator: 'BinaryOperator',
        original: 'replace > with == in is_quiet',
        replacement: '==',
        status: 'survived',
      },
    ]);
    expect(asked).toEqual(['core/src/quiet.rs', 'core/src/quiet.rs', 'core/src/quiet.rs']);
  });

  it('falls back on the mutant’s name when the source is unknown or the name odd', () => {
    const odd = JSON.stringify({
      outcomes: [
        {
          scenario: {
            Mutant: cargoMutant('weird', { replacement: 'x', genre: 'FnValue' }),
          },
          summary: 'MissedMutant',
        },
      ],
    });
    expect(parseCargoMutants(odd, () => undefined)).toEqual([
      expect.objectContaining({ line: 1, original: 'weird' }),
    ]);
    expect(parseCargoMutants(CARGO, () => undefined)[1]).toMatchObject({
      original: 'replace < with <= in is_quiet',
    });
  });

  it('throws an engine error for another document', () => {
    expect(() => parseCargoMutants('{"outcomes": 3}', () => undefined)).toThrow(
      new EngineError('the cargo-mutants report is not an outcomes.json'),
    );
  });
});

describe('parseMutmut', () => {
  it('reads the Python pack’s report, keeping mutmut’s name out of the identity', () => {
    const report = JSON.stringify({
      format: MUTMUT_REPORT,
      mutants: [
        {
          name: 'm.core.x_grow__mutmut_1',
          file: 'src/m/core.py',
          status: 'survived',
          functionLine: 10,
          diff: '@@ -1,2 +1,2 @@\n def grow(size):\n-    return size + 1\n+    return size - 1\n',
        },
        {
          name: 'm.core.x_grow__mutmut_2',
          file: 'src/m/core.py',
          status: 'no tests',
          functionLine: 10,
          diff: '@@ -1,2 +1,2 @@\n def grow(size):\n-    return size + 1\n+    return size + 2\n',
        },
        {
          name: 'm.core.x_grow__mutmut_3',
          file: 'src/m/core.py',
          status: 'killed',
          functionLine: 10,
          diff: '',
        },
      ],
    });
    expect(parseMutmut(report)).toEqual([
      {
        file: 'src/m/core.py',
        line: 11,
        mutator: 'mutmut',
        label: 'm.core.x_grow__mutmut_1',
        original: 'return size + 1',
        replacement: 'return size - 1',
        status: 'survived',
      },
      {
        file: 'src/m/core.py',
        line: 11,
        mutator: 'mutmut',
        label: 'm.core.x_grow__mutmut_2',
        original: 'return size + 1',
        replacement: 'return size + 2',
        status: 'no-coverage',
      },
      expect.objectContaining({ status: 'other' }),
    ]);
  });
});

function mutant(fields: Partial<Mutant>): Mutant {
  return {
    file: 'src/a.ts',
    line: 3,
    mutator: 'EqualityOperator',
    original: 'n > 0',
    replacement: 'n >= 0',
    status: 'survived',
    ...fields,
  };
}

describe('mutantKey', () => {
  it('names the mutation and its code, whitespace collapsed, never the place', () => {
    expect(mutantKey(mutant({ original: 'n  >\n 0' }))).toBe('EqualityOperator: n > 0 → n >= 0');
    expect(mutantKey(mutant({ file: 'b.ts', line: 90 }))).toBe(mutantKey(mutant({})));
  });

  it('shortens long code to a prefix and a hash', () => {
    const long = `{ ${'x();'.repeat(40)} }`;
    const key = mutantKey(mutant({ original: long, replacement: '{}' }));
    expect(key).toMatch(/^EqualityOperator: (.{60})…#[0-9a-f]{12} → \{\}$/);
    expect(key.slice('EqualityOperator: '.length, -'…#c435fce9fe5d → {}'.length)).toBe(
      long.slice(0, 60),
    );
    expect(key).not.toBe(
      mutantKey(mutant({ original: `${long.slice(0, -2)}y(); }`, replacement: '{}' })),
    );
  });
});

describe('mutantFinding', () => {
  it('reports a survivor at its repository file with its span', () => {
    expect(mutantFinding(mutant({ endLine: 5 }), 'web/src/a.ts')).toEqual({
      rule: 'mutation/survived',
      message: 'No test fails when `n > 0` becomes `n >= 0` (EqualityOperator).',
      location: { file: 'web/src/a.ts', line: 3, endLine: 5 },
      key: 'EqualityOperator: n > 0 → n >= 0',
    });
  });

  it('says when no test runs the code, when the mutant removes it, and when there is no code', () => {
    const removed = mutantFinding(
      mutant({ status: 'no-coverage', replacement: '', endLine: 1, line: 0 }),
      'a.ts',
    );
    expect(removed.message).toBe(
      'No test runs `n > 0`, so nothing fails when it is removed (EqualityOperator).',
    );
    expect(removed.location).toEqual({ file: 'a.ts', line: 1 });
    expect(mutantFinding(mutant({ original: '', label: 'x__mutmut_4' }), 'a.py').message).toBe(
      'No test fails when this x__mutmut_4 mutant is applied.',
    );
  });
});

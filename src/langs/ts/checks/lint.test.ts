import { describe, expect, it } from 'vitest';
import { parseEslint, sentence } from './lint.js';
import { EngineError } from '../../../core/check.js';

/** Recorded from eslint 10.13.0 -f json with the generated base, trimmed to two messages a file. */
const RECORDED = [
  { filePath: '/repo/eslint.config.js', messages: [] },
  {
    filePath: '/repo/src/a.ts',
    messages: [
      {
        ruleId: '@typescript-eslint/no-explicit-any',
        severity: 2,
        message: 'Unexpected any. Specify a different type.',
        line: 1,
        column: 22,
        messageId: 'unexpectedAny',
        endLine: 1,
        endColumn: 25,
      },
      {
        ruleId: null,
        message: "Unused eslint-disable directive (no problems were reported from 'no-console').",
        line: 4,
        column: 1,
        severity: 2,
      },
    ],
  },
  {
    filePath: '/repo/src/bad.ts',
    messages: [
      {
        ruleId: null,
        fatal: true,
        severity: 2,
        message: 'Parsing error: Expression expected.',
        line: 1,
        column: 11,
      },
    ],
  },
  {
    filePath: '/repo/dist/x.js',
    messages: [
      {
        ruleId: null,
        fatal: false,
        severity: 1,
        message:
          'File ignored because of a matching ignore pattern. Use "--no-ignore" to disable file ignore settings or use "--no-warn-ignored" to suppress this warning.',
      },
    ],
  },
];

const toRepo = (path: string): string => path.replace('/repo/', '');

describe('parseEslint', () => {
  it('turns messages into problems and lists ignored files apart', () => {
    const run = parseEslint(RECORDED, toRepo);
    expect(run.problems).toEqual([
      {
        rule: 'eslint/@typescript-eslint/no-explicit-any',
        message: 'Unexpected any. Specify a different type.',
        file: 'src/a.ts',
        line: 1,
        column: 22,
        endLine: 1,
      },
      {
        rule: 'eslint/unused-directive',
        message: "Unused eslint-disable directive (no problems were reported from 'no-console').",
        file: 'src/a.ts',
        line: 4,
        column: 1,
      },
      {
        rule: 'eslint/parse-error',
        message: 'Parsing error: Expression expected.',
        file: 'src/bad.ts',
        line: 1,
        column: 11,
      },
    ]);
    expect(run.ignored).toEqual(['dist/x.js']);
  });

  it('refuses output that is not ESLint’s JSON', () => {
    expect(() => parseEslint({ oops: true }, toRepo)).toThrow(EngineError);
  });
});

describe('sentence', () => {
  it('collapses whitespace and clips long messages', () => {
    expect(sentence('  a\n   b ')).toBe('a b');
    expect(sentence('x'.repeat(400))).toHaveLength(300);
  });
});

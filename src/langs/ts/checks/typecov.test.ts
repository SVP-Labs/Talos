import { describe, expect, it } from 'vitest';
import { atFloor, parseTypeCoverage, typecovArgs, typecovFindings } from './typecov.js';
import { EngineError } from '../../../core/check.js';

/** Recorded from type-coverage 2.30.4 --strict --detail --json-output. */
const RECORDED = {
  succeeded: true,
  details: [
    { character: 18, filePath: '/repo/src/a.ts', line: 0, text: 'x' },
    { character: 9, filePath: '/repo/src/a.ts', line: 2, text: 'y!' },
  ],
  atLeastFailed: false,
  correctCount: 16,
  percent: 88.88,
  percentString: '88.88',
  totalCount: 18,
};

const toRepo = (file: string): string => file.replace('/repo/', '');

describe('typecovFindings', () => {
  it('makes each untyped identifier a standard finding under the floor', () => {
    const findings = typecovFindings(parseTypeCoverage(RECORDED), toRepo);
    expect(findings).toEqual([
      {
        rule: 'typecov/untyped',
        message: 'x is not precisely typed (any, an as cast, or a non-null assertion).',
        location: { file: 'src/a.ts', line: 1, column: 19 },
      },
      {
        rule: 'typecov/untyped',
        message: 'y! is not precisely typed (any, an as cast, or a non-null assertion).',
        location: { file: 'src/a.ts', line: 3, column: 10 },
      },
    ]);
  });

  it('reports the same identifiers as info at or above the floor', () => {
    const covered = { ...RECORDED, correctCount: 199, totalCount: 200 };
    expect(typecovFindings(parseTypeCoverage(covered), toRepo).map((f) => f.policy)).toEqual([
      'info',
      'info',
    ]);
  });

  it('refuses output that is not type-coverage’s JSON', () => {
    expect(() => parseTypeCoverage({ succeeded: false, error: 'boom' })).toThrow(EngineError);
  });
});

describe('atFloor', () => {
  it('holds a package to 99.5%, with nothing to count counting as typed', () => {
    expect(atFloor({ correctCount: 995, totalCount: 1000 })).toBe(true);
    expect(atFloor({ correctCount: 994, totalCount: 1000 })).toBe(false);
    expect(atFloor({ correctCount: 0, totalCount: 0 })).toBe(true);
  });
});

describe('typecovArgs', () => {
  it('overrides every loosening option and leaves test code out', () => {
    const args = typecovArgs(['e2e-full/**']);
    expect(args.slice(0, 3)).toEqual(['-p', 'tsconfig.json', '--strict']);
    expect(args).toContain('--no-ignore-as-assertion');
    expect(args).toContain('--no-update');
    expect(args.slice(-2)).toEqual(['--ignore-files', 'e2e-full/**']);
  });
});

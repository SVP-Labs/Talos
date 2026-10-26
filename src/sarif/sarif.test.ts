import { describe, expect, it } from 'vitest';
import { toSarif } from './sarif.js';
import type { Judged } from '../core/compare.js';

function judged(overrides: Partial<Judged> = {}): Judged {
  return {
    rule: 'eslint/complexity',
    message: 'Too complex.',
    location: { file: 'src/a.ts', line: 4 },
    check: 'ts/lint',
    fingerprint: 'fp-1',
    policy: 'standard',
    isNew: true,
    blocking: true,
    why: 'new',
    ...overrides,
  };
}

describe('toSarif', () => {
  it('makes one run per check, naming each rule once with its documentation', () => {
    const log = toSarif(
      [
        judged({ docs: 'https://eslint.org/docs/latest/rules/complexity' }),
        judged({ fingerprint: 'fp-2' }),
        judged({ rule: 'eslint/max-depth', fingerprint: 'fp-3' }),
        judged({ check: 'py/lint', rule: 'ruff/E501', fingerprint: 'fp-4' }),
      ],
      '1.2.3',
    );
    expect(log.version).toBe('2.1.0');
    expect(log.runs.map((run) => run.tool.driver.name)).toEqual(['talos ts/lint', 'talos py/lint']);
    const [ts] = log.runs;
    expect(ts?.tool.driver.version).toBe('1.2.3');
    expect(ts?.tool.driver.rules).toEqual([
      { id: 'eslint/complexity', helpUri: 'https://eslint.org/docs/latest/rules/complexity' },
      { id: 'eslint/max-depth' },
    ]);
    expect(ts?.results).toHaveLength(3);
  });

  it('carries the place, the fingerprint and how the gate judged the finding', () => {
    const [run] = toSarif(
      [judged({ location: { file: 'src/b.ts', line: 2, endLine: 5, column: 9 } })],
      '1.0.0',
    ).runs;
    expect(run?.results[0]).toEqual({
      ruleId: 'eslint/complexity',
      level: 'error',
      message: { text: 'Too complex.' },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: 'src/b.ts' },
            region: { startLine: 2, endLine: 5, startColumn: 9 },
          },
        },
      ],
      partialFingerprints: { 'talos/v1': 'fp-1' },
      properties: { check: 'ts/lint', policy: 'standard', new: true, blocking: true, why: 'new' },
    });
  });

  it('warns for what does not block, notes what only informs, and places nothing without a file', () => {
    const { location: _location, ...unplaced } = judged();
    const results = toSarif(
      [
        { ...unplaced, blocking: false, why: 'existing' },
        judged({ policy: 'info', blocking: false, why: 'info', fingerprint: 'fp-2' }),
      ],
      '1.0.0',
    ).runs[0]?.results;
    expect(results?.map((r) => r.level)).toEqual(['warning', 'note']);
    expect(results?.[0]).not.toHaveProperty('locations');
    expect(results?.[1]?.locations?.[0]?.physicalLocation.region).toEqual({ startLine: 4 });
  });

  it('is an empty log when nothing was found', () => {
    expect(toSarif([], '1.0.0').runs).toEqual([]);
  });
});

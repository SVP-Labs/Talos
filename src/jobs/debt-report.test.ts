import { describe, expect, it } from 'vitest';
import {
  compactDebt,
  DEBT_SCHEMA,
  debtCheckIds,
  debtReport,
  debtText,
  mutationCheckIds,
  parseDebtReport,
} from './debt-report.js';
import { finding, outcome, result } from './test/findings.js';
import type { Check } from '../core/check.js';
import type { Pack } from '../core/pack.js';

const NOW = new Date('2026-10-26T03:17:00Z');

describe('debtReport', () => {
  it('lists every finding, counted by rule and by file, most first', () => {
    const report = debtReport(
      result([
        outcome('ts/lint', [
          finding('eslint/complexity', 'src/b.ts'),
          finding('eslint/complexity', 'src/a.ts'),
          finding('eslint/max-depth', 'src/a.ts', { message: 'x'.repeat(300) }),
        ]),
        outcome('supply/advisories', [
          finding('osv/GHSA-1', undefined, { key: 'lodash@1 GHSA-1', policy: 'always' }),
        ]),
        outcome('ts/types', [], { status: 'error', reason: 'tsc crashed' }),
        outcome('lua/tests', [], { status: 'error', component: 'mods', reason: 'r'.repeat(300) }),
      ]),
      { repo: 'o/r', now: NOW },
    );
    expect(report).toMatchObject({
      schema: DEBT_SCHEMA,
      talos: '1.2.3',
      repo: 'o/r',
      createdAt: '2026-10-26T03:17:00.000Z',
      counts: { total: 4, rules: 3, files: 2, faults: 2 },
      byRule: [
        { rule: 'eslint/complexity', count: 2 },
        { rule: 'eslint/max-depth', count: 1 },
        { rule: 'osv/GHSA-1', count: 1 },
      ],
      byFile: [
        { file: 'src/a.ts', count: 2 },
        { file: 'src/b.ts', count: 1 },
      ],
      truncated: false,
    });
    expect(report.findings[2]?.message).toHaveLength(200);
    expect(report.findings[3]).toMatchObject({
      file: null,
      line: null,
      key: 'lodash@1 GHSA-1',
      policy: 'always',
    });
    expect(report.faults).toEqual([
      { check: 'ts/types', reason: 'tsc crashed' },
      { check: 'lua/tests@mods', reason: expect.stringMatching(/^r+…$/) },
    ]);
  });

  it('is empty for a clean run, with no repository named locally', () => {
    const report = debtReport(result([outcome('ts/lint', [])]), { now: NOW });
    expect(report.repo).toBeNull();
    expect(report.counts).toEqual({ total: 0, rules: 0, files: 0, faults: 0 });
  });
});

describe('compactDebt', () => {
  it('caps every list at 20 and says so', () => {
    const many = Array.from({ length: 25 }, (_, i) => finding(`r/${i}`, `src/f${i}.ts`));
    const compact = compactDebt(debtReport(result([outcome('ts/lint', many)]), { now: NOW }));
    expect(compact.byRule).toHaveLength(20);
    expect(compact.byFile).toHaveLength(20);
    expect(compact.findings).toHaveLength(20);
    expect(compact.counts.total).toBe(25);
    expect(compact.truncated).toBe(true);
  });

  it('leaves a small report whole', () => {
    const report = debtReport(result([outcome('ts/lint', [finding('r/1', 'a.ts')])]), { now: NOW });
    expect(compactDebt(report)).toEqual(report);
  });
});

describe('parseDebtReport', () => {
  it('reads back what debtReport wrote', () => {
    const report = debtReport(result([outcome('ts/lint', [finding('r/1', 'a.ts')])]), { now: NOW });
    expect(parseDebtReport(JSON.stringify(report))).toEqual(report);
  });

  it('refuses anything else', () => {
    expect(() => parseDebtReport('{"schema":"talos.debt/2"}')).toThrow();
    expect(() => parseDebtReport('not json')).toThrow();
  });
});

describe('debtText', () => {
  it('summarises counts, rules, files and engine errors', () => {
    const report = debtReport(
      result([
        outcome('ts/lint', [finding('eslint/complexity', 'src/a.ts')]),
        outcome('ts/types', [], { status: 'error', reason: 'boom' }),
      ]),
      { now: NOW },
    );
    const text = debtText(report);
    expect(text).toContain('1 finding(s) at aaaaaaaaaaaa in 1 file(s), 1 rule(s)');
    expect(text).toContain('     1  eslint/complexity');
    expect(text).toContain('     1  src/a.ts');
    expect(text).toContain('ENGINE ERROR ts/types: boom');
  });
});

describe('check ids', () => {
  const check = (id: string): Check => ({
    id,
    tier: 'head',
    scope: 'repo',
    title: id,
    applies: () => ({ applies: true }),
    run: () => Promise.resolve([]),
  });
  const packs: Pack[] = [
    { name: 'ts', checks: [check('ts/lint'), check('ts/mutation')] },
    { name: 'py', checks: [check('py/mutation'), check('py/tests')] },
  ];

  it('runs every check but mutation for the debt list', () => {
    expect(debtCheckIds(packs)).toEqual(['ts/lint', 'py/tests']);
    expect(mutationCheckIds(packs)).toEqual(['ts/mutation', 'py/mutation']);
  });
});

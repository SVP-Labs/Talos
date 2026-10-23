import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type AnalyzeDeps,
  DEBT_FILE,
  debtRun,
  MUTATION_FILE,
  mutationMarkdown,
  mutationReport,
  mutationSummary,
} from './analyze.js';
import { parseDebtReport } from './debt-report.js';
import { testContext } from './test/context.js';
import { finding, outcome, result } from './test/findings.js';
import type { RunResult } from '../core/result.js';
import { FakeGitHub } from '../ticket/test/fake-github.js';

function deps(
  run: RunResult,
  mutation: string[] = ['ts/mutation'],
): AnalyzeDeps & { summaries: string[]; asked: string[][] } {
  const summaries: string[] = [];
  const asked: string[][] = [];
  return {
    summaries,
    asked,
    checks: { debt: ['ts/lint'], mutation },
    run: (only) => {
      asked.push([...only]);
      return Promise.resolve(run);
    },
    summary: (markdown) => {
      summaries.push(markdown);
      return Promise.resolve();
    },
  };
}

const survived = (file: string): ReturnType<typeof finding> =>
  finding('mutation/survived', file, {
    check: 'ts/mutation',
    policy: 'info',
    fingerprint: `m:${file}`,
  });

describe('debtRun', () => {
  it('writes the debt list for the act phase', async () => {
    const ctx = await testContext(new FakeGitHub(), { phase: 'analyze' });
    const d = deps(result([outcome('ts/lint', [finding('r/1', 'src/a.ts')])]));
    expect(await debtRun(ctx, d)).toEqual({
      job: 'debt-run',
      result: 'done',
      detail: '1 finding(s) in 1 file(s)',
    });
    expect(d.asked).toEqual([['ts/lint']]);
    const report = parseDebtReport(await readFile(join(ctx.workdir, DEBT_FILE), 'utf8'));
    expect(report.repo).toBe('o/r');
    expect(report.counts.total).toBe(1);
  });

  it('fails when a check had an engine error, and still writes what it found', async () => {
    const ctx = await testContext(new FakeGitHub(), { phase: 'analyze' });
    const d = deps(result([outcome('ts/lint', [], { status: 'error', reason: 'boom' })]));
    expect(await debtRun(ctx, d)).toMatchObject({
      result: 'failed',
      detail: '0 finding(s) in 0 file(s); 1 engine error(s)',
    });
    expect(
      parseDebtReport(await readFile(join(ctx.workdir, DEBT_FILE), 'utf8')).counts.faults,
    ).toBe(1);
  });
});

describe('mutationSummary', () => {
  it('counts surviving mutants per file, most first', () => {
    const summary = mutationSummary(
      result([
        outcome('ts/mutation', [survived('src/b.ts'), survived('src/a.ts'), survived('src/a.ts')]),
        outcome('ts/lint', [finding('mutation/survived', 'src/x.ts')]),
        outcome('py/mutation', [], { status: 'error', reason: 'x' }),
      ]),
    );
    expect(summary).toEqual({
      schema: 'talos.mutation/1',
      talos: '1.2.3',
      sha: 'a'.repeat(40),
      survived: 3,
      files: 2,
      faults: 1,
      byFile: [
        { file: 'src/a.ts', survived: 2 },
        { file: 'src/b.ts', survived: 1 },
      ],
    });
    expect(mutationMarkdown(summary)).toContain('| 2 | `src/a.ts` |');
  });
});

describe('mutationReport', () => {
  it('writes a report and a job summary, and files nothing', async () => {
    const fake = new FakeGitHub();
    const ctx = await testContext(fake, { phase: 'analyze' });
    const d = deps(result([outcome('ts/mutation', [survived('src/a.ts')])]));
    expect(await mutationReport(ctx, d)).toEqual({
      job: 'mutation-report',
      result: 'done',
      detail: '1 surviving mutant(s) in 1 file(s)',
    });
    expect(JSON.parse(await readFile(join(ctx.workdir, MUTATION_FILE), 'utf8'))).toMatchObject({
      survived: 1,
    });
    expect(d.summaries[0]).toContain('weekly mutation report');
    expect(fake.calls).toEqual([]);
  });

  it('skips when no pack has a mutation check, and fails on an engine error', async () => {
    const ctx = await testContext(new FakeGitHub(), { phase: 'analyze' });
    expect((await mutationReport(ctx, deps(result([]), []))).result).toBe('skipped');
    const broken = deps(result([outcome('ts/mutation', [], { status: 'error' })]));
    expect((await mutationReport(ctx, broken)).result).toBe('failed');
  });
});

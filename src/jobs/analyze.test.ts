import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type AnalyzeDeps,
  DEBT_FILE,
  debtRun,
  maskSecrets,
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
      errors: [{ check: 'py/mutation', reason: 'x' }],
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

  it("names a faulted mutation run's message in the detail, the report and the summary", async () => {
    const ctx = await testContext(new FakeGitHub(), { phase: 'analyze' });
    const reason = 'stryker exited 1 without a report:\n  Initial test run failed `x`  ';
    const d = deps(
      result([outcome('ts/mutation', [], { status: 'error', reason, component: 'web' })]),
    );
    expect(await mutationReport(ctx, d)).toEqual({
      job: 'mutation-report',
      result: 'failed',
      detail:
        '0 surviving mutant(s) in 0 file(s); 1 engine error(s): ts/mutation@web: ' +
        'stryker exited 1 without a report: Initial test run failed `x`',
    });
    expect(JSON.parse(await readFile(join(ctx.workdir, MUTATION_FILE), 'utf8'))).toMatchObject({
      faults: 1,
      errors: [
        {
          check: 'ts/mutation@web',
          reason: 'stryker exited 1 without a report: Initial test run failed `x`',
        },
      ],
    });
    expect(d.summaries[0]).toContain('### Engine errors (1)');
    expect(d.summaries[0]).toContain(
      "- **ts/mutation@web**: `stryker exited 1 without a report: Initial test run failed 'x'`",
    );
  });

  it('clips a long message and lists at most five faults, counting them all', () => {
    const outcomes = Array.from({ length: 7 }, (_, i) =>
      outcome('ts/mutation', [], {
        status: 'error',
        reason: `${i}`.repeat(300),
        component: `c${i}`,
      }),
    );
    const summary = mutationSummary(result(outcomes));
    expect(summary.faults).toBe(7);
    expect(summary.errors.map((f) => f.check)).toEqual([
      'ts/mutation@c0',
      'ts/mutation@c1',
      'ts/mutation@c2',
      'ts/mutation@c3',
      'ts/mutation@c4',
    ]);
    expect(summary.errors[0]?.reason).toBe(`${'0'.repeat(199)}…`);
  });

  it('masks a secret in the detail, the report and the summary', async () => {
    const ctx = await testContext(new FakeGitHub(), { phase: 'analyze' });
    const token = ['ghp', 'Q7x'.repeat(12)].join('_');
    const reason = `npm ERR! 401 fetching with ${token}\nstryker exited 1`;
    const d = deps(result([outcome('ts/mutation', [], { status: 'error', reason })]));
    const said = 'ts/mutation: npm ERR! 401 fetching with *** stryker exited 1';
    expect((await mutationReport(ctx, d)).detail).toBe(
      `0 surviving mutant(s) in 0 file(s); 1 engine error(s): ${said}`,
    );
    const written = await readFile(join(ctx.workdir, MUTATION_FILE), 'utf8');
    expect(written).not.toContain(token);
    expect(JSON.parse(written)).toMatchObject({
      errors: [{ check: 'ts/mutation', reason: 'npm ERR! 401 fetching with *** stryker exited 1' }],
    });
    expect(d.summaries[0]).not.toContain(token);
    expect(d.summaries[0]).toContain('`npm ERR! 401 fetching with *** stryker exited 1`');
  });

  it('masks a secret before clipping, so a cut leaves no part of it', () => {
    const token = ['github', 'pat', 'Z9'.repeat(40)].join('_');
    const reason = `${'x'.repeat(180)} ${token}`;
    const [fault] = mutationSummary(
      result([outcome('ts/mutation', [], { status: 'error', reason })]),
    ).errors;
    expect(fault?.reason).toBe(`${'x'.repeat(180)} ***`);
  });
});

describe('maskSecrets', () => {
  const join2 = (...parts: string[]): string => parts.join('');

  it.each([
    ['a GitHub token', `use ${join2('gh', 's_', 'k'.repeat(36))} now`, 'use *** now'],
    ['an AWS key id', `id ${join2('AK', 'IA', 'ABCDEFGH12345678')}.`, 'id ***.'],
    ['a Slack token', `hook ${join2('xox', 'b-', '1234567890-abc')}`, 'hook ***'],
    ['an npm token', `auth ${join2('npm', '_', 'a'.repeat(36))}`, 'auth ***'],
    [
      'a JWT',
      `jwt ${join2('eyJ', 'h'.repeat(10), '.', 'p'.repeat(10), '.', 's'.repeat(10))}`,
      'jwt ***',
    ],
    [
      'URL credentials',
      'git clone https://me:hunter2pass@example.com/r',
      'git clone https://***@example.com/r',
    ],
    ['a bearer header', `Authorization: Bearer ${'t'.repeat(30)}`, 'Authorization: Bearer ***'],
    ['a named value', `DB_PASSWORD=${'p'.repeat(12)} next`, 'DB_PASSWORD=*** next'],
    ['a quoted named value', `"api_key": "${'k'.repeat(20)}"`, '"api_key": "***"'],
    [
      'a private key',
      join2('-----BEGIN RSA ', 'PRIVATE KEY-----\nbody\n-----END RSA ', 'PRIVATE KEY----- after'),
      '*** after',
    ],
  ])('masks %s', (_, text, masked) => {
    expect(maskSecrets(text)).toBe(masked);
  });

  it('leaves ordinary tool output alone', () => {
    const text = 'Ran 2496 tests in 3 minutes; 41784 mutants, tokens: 55 (src/a.ts:12)';
    expect(maskSecrets(text)).toBe(text);
  });
});

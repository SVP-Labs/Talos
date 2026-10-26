import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RawTestRun, TestRequest } from './protocol.js';
import { junitXml, scriptedRunner, testContext } from './test/context.js';
import { testChecks } from './tests.js';
import type { Check, CheckContext } from '../core/check.js';
import type { Finding } from '../core/finding.js';
import { parseDiff } from '../repo/changes.js';

type Case = Parameters<typeof junitXml>[0][number];

let reports = 0;

/** A run whose JUnit report holds these cases, with LCOV coverage when asked. */
async function run(ctx: CheckContext, cases: readonly Case[], lcov?: string): Promise<RawTestRun> {
  reports += 1;
  const name = `run-${reports}`;
  const junit = join(ctx.scratch, `${name}.xml`);
  await writeFile(junit, junitXml(cases));
  const failed = cases.some((test) => test.status === 'failed' || test.status === 'errored');
  if (lcov === undefined) {
    return { exitCode: failed ? 1 : 0, output: '', junit: [{ path: junit, base: ctx.root }] };
  }
  const coverage = join(ctx.scratch, `${name}.lcov`);
  await writeFile(coverage, lcov);
  return {
    exitCode: failed ? 1 : 0,
    output: '',
    junit: [{ path: junit, base: ctx.root }],
    coverage: { path: coverage, base: ctx.root, format: 'lcov' },
  };
}

function checks(answer: Parameters<typeof scriptedRunner>[0]) {
  const runner = scriptedRunner(answer);
  const [tests, coverage] = testChecks('ts', runner);
  if (tests === undefined || coverage === undefined) throw new Error('two checks expected');
  return { runner, tests, coverage };
}

function rules(findings: readonly Finding[]): string[] {
  return findings.map(
    (finding) => `${finding.rule} ${finding.key ?? finding.location?.file ?? ''}`,
  );
}

const SOURCE = { 'src/a.ts': 'one\ntwo\nthree\n', 'src/a.test.ts': '' };
const LCOV = 'SF:src/a.ts\nDA:1,1\nDA:2,1\nDA:3,0\n';

describe('testChecks', () => {
  it('gives a language a per-commit tests check and a head coverage check', () => {
    const { tests, coverage } = checks(() => ({ exitCode: 0, output: '', junit: [] }));
    const shape = (check: Check) => [check.id, check.tier, check.scope, check.langs];
    expect(shape(tests)).toEqual(['ts/tests', 'commit', 'component', ['ts']]);
    expect(shape(coverage)).toEqual(['ts/coverage', 'head', 'component', ['ts']]);
  });

  it('runs every test once for both checks, and reports each failure once', async () => {
    const ctx = await testContext({ files: SOURCE });
    const { runner, tests, coverage } = checks((request) =>
      run(
        ctx,
        request.files === undefined
          ? [
              { name: 'broken', file: 'src/a.test.ts', status: 'failed' },
              { name: 'shaky', file: 'src/a.test.ts', status: 'failed' },
            ]
          : [
              { name: 'broken', file: 'src/a.test.ts', status: 'failed' },
              { name: 'shaky', file: 'src/a.test.ts' },
            ],
        LCOV,
      ),
    );
    expect(tests.applies(ctx)).toEqual({ applies: true });
    expect(coverage.applies(ctx)).toEqual({ applies: true });
    const [fromTests, fromCoverage] = await Promise.all([tests.run(ctx), coverage.run(ctx)]);
    expect(runner.requests).toEqual<TestRequest[]>([
      { suite: 'all', coverage: true },
      { suite: 'all', coverage: true, files: ['src/a.test.ts'] },
    ]);
    expect(rules(fromTests)).toEqual([
      'tests/failed src/a.test.ts::broken',
      'tests/flaky src/a.test.ts::shaky',
    ]);
    expect(rules(fromCoverage)).toEqual(['coverage/uncovered src/a.ts']);
    expect(fromCoverage[0]).toMatchObject({ location: { file: 'src/a.ts', line: 3 } });
  });

  it('leaves tests.full to the coverage check, which reports only what the tests check didn’t', async () => {
    const ctx = await testContext({
      files: SOURCE,
      yml: 'name: T\nprefix: T\ntests: { full: [e2e] }\n',
    });
    const { runner, tests, coverage } = checks((request) =>
      request.suite === 'commit'
        ? run(ctx, [{ name: 'unit', file: 'src/a.test.ts', status: 'failed' }])
        : run(
            ctx,
            [
              { name: 'unit', file: 'src/a.test.ts', status: 'failed' },
              { name: 'journey', file: 'e2e/b.test.ts', status: 'failed' },
            ],
            LCOV,
          ),
    );
    expect(rules(await tests.run(ctx))).toEqual(['tests/failed src/a.test.ts::unit']);
    expect(rules(await coverage.run(ctx))).toEqual([
      'tests/failed e2e/b.test.ts::journey',
      'coverage/uncovered src/a.ts',
    ]);
    expect(runner.requests.map((request) => request.suite)).toEqual([
      'commit',
      'commit',
      'all',
      'all',
    ]);
  });

  it('reports its own failures when the commit tier isn’t run, or its run broke', async () => {
    const failing = [{ name: 'unit', file: 'src/a.test.ts', status: 'failed' } as const];
    const headOnly = await testContext({ files: SOURCE, tiers: ['head'] });
    const alone = checks(() => run(headOnly, failing, LCOV));
    expect(rules(await alone.coverage.run(headOnly))).toContain('tests/failed src/a.test.ts::unit');

    const broken = await testContext({
      files: SOURCE,
      yml: 'name: T\nprefix: T\ntests: { full: [e2e] }\n',
    });
    const crashing = checks((request) =>
      request.suite === 'commit'
        ? { exitCode: 3, output: 'segfault', junit: [] }
        : run(broken, failing, LCOV),
    );
    await expect(crashing.tests.run(broken)).rejects.toThrow('segfault');
    expect(rules(await crashing.coverage.run(broken))).toContain(
      'tests/failed src/a.test.ts::unit',
    );
  });

  it('holds a change’s lines to 90% on the head side only', async () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,3 @@',
      ' one',
      '+two',
      '+three',
      '',
    ].join('\n');
    const passing = [{ name: 'unit', file: 'src/a.test.ts' }];
    for (const side of ['head', 'base', 'alone'] as const) {
      const ctx = await testContext({ files: SOURCE, side, changes: parseDiff(diff) });
      const { coverage } = checks(() => run(ctx, passing, LCOV));
      const found = rules(await coverage.run(ctx));
      expect(found.includes('coverage/changed-lines src/a.ts:3')).toBe(side === 'head');
    }
  });

  it('reports no coverage for a component without tests', async () => {
    const ctx = await testContext({ files: SOURCE });
    const { coverage } = checks(() => ({ exitCode: 0, output: '', junit: [] }));
    expect(await coverage.run(ctx)).toEqual([]);
  });
});

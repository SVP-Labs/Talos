import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RawTestRun } from './protocol.js';
import { FULL_SUITE, runSuite, sharedSuite, testsRequest } from './suite.js';
import { junitXml, scriptedRunner, testContext } from './test/context.js';
import { EngineError } from '../core/check.js';

const COMMIT = { suite: 'commit', coverage: false } as const;

async function report(dir: string, name: string, text: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, text);
  return path;
}

describe('runSuite', () => {
  it('runs once when every test passes', async () => {
    const ctx = await testContext({ files: { 'a.test.ts': '' } });
    const junit = await report(ctx.scratch, 'j.xml', junitXml([{ name: 'ok', file: 'a.test.ts' }]));
    const runner = scriptedRunner(() => ({
      exitCode: 0,
      output: '',
      junit: [{ path: junit, base: ctx.root }],
    }));
    expect(await runSuite(ctx, runner, COMMIT)).toEqual({ verdicts: [], coverage: new Map() });
    expect(runner.requests).toEqual([COMMIT]);
  });

  it('reruns the failing tests’ files once and judges both runs', async () => {
    const ctx = await testContext();
    const first = await report(
      ctx.scratch,
      'first.xml',
      junitXml([
        { name: 'steady', file: 'tests/a.py', status: 'failed', message: 'broken' },
        { name: 'shaky', file: 'tests/b.py', status: 'failed' },
        { name: 'fine', file: 'tests/b.py' },
      ]),
    );
    const second = await report(
      ctx.scratch,
      'second.xml',
      junitXml([
        { name: 'steady', file: 'tests/a.py', status: 'failed', message: 'still broken' },
        { name: 'shaky', file: 'tests/b.py' },
        { name: 'fine', file: 'tests/b.py' },
      ]),
    );
    const runner = scriptedRunner((_request, call) => ({
      exitCode: 1,
      output: '',
      junit: [{ path: call === 1 ? first : second, base: ctx.root }],
    }));
    const run = await runSuite(ctx, runner, COMMIT);
    expect(runner.requests).toEqual([COMMIT, { ...COMMIT, files: ['tests/a.py', 'tests/b.py'] }]);
    expect(run.verdicts.map((v) => [v.test.id, v.kind, v.test.message])).toEqual([
      ['tests/a.py::steady', 'failed', 'still broken'],
      ['tests/b.py::shaky', 'flaky', 'boom'],
    ]);
  });

  it('reruns everything when a failing test names no file', async () => {
    const ctx = await testContext();
    const junit = await report(ctx.scratch, 'j.xml', junitXml([{ name: 'x', status: 'errored' }]));
    const runner = scriptedRunner(() => ({
      exitCode: 1,
      output: '',
      junit: [{ path: junit, base: ctx.root }],
    }));
    const run = await runSuite(ctx, runner, COMMIT);
    expect(runner.requests).toEqual([COMMIT, COMMIT]);
    expect(run.verdicts.map((v) => v.kind)).toEqual(['failed']);
  });

  it('calls a non-zero exit with no failing test an engine error, with the output’s tail', async () => {
    const ctx = await testContext();
    const junit = await report(ctx.scratch, 'j.xml', junitXml([{ name: 'ok' }]));
    const output = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n');
    const runner = scriptedRunner(() => ({
      exitCode: 2,
      output,
      junit: [{ path: junit, base: ctx.root }],
    }));
    const failure = runSuite(ctx, runner, COMMIT);
    await expect(failure).rejects.toThrow(EngineError);
    await expect(failure).rejects.toThrow(
      /^the tests exited 2 on their run with no failing test in their JUnit report:\nline 11\n/,
    );
    await expect(failure).rejects.not.toThrow(/line 10\n/);
  });

  it('calls a rerun that exits non-zero with no failing test an engine error too', async () => {
    const ctx = await testContext();
    const failing = await report(ctx.scratch, 'f.xml', junitXml([{ name: 'x', status: 'failed' }]));
    const runner = scriptedRunner((_request, call) => ({
      exitCode: 1,
      output: 'crashed',
      junit: call === 1 ? [{ path: failing, base: ctx.root }] : [],
    }));
    await expect(runSuite(ctx, runner, COMMIT)).rejects.toThrow(
      'the tests exited 1 on their rerun with no failing test in their JUnit report:\ncrashed',
    );
  });

  it('reads coverage when asked, both runs’ together', async () => {
    const ctx = await testContext({ files: { 'src/a.ts': '', 'src/a.test.ts': '' } });
    const failing = junitXml([{ name: 't', file: 'src/a.test.ts', status: 'failed' }]);
    const passing = junitXml([{ name: 't', file: 'src/a.test.ts' }]);
    const first: RawTestRun = {
      exitCode: 1,
      output: '',
      junit: [{ path: await report(ctx.scratch, '1.xml', failing), base: ctx.root }],
      coverage: {
        path: await report(ctx.scratch, '1.lcov', 'SF:src/a.ts\nDA:1,1\nDA:2,0\nDA:3,0\n'),
        base: ctx.root,
        format: 'lcov',
      },
    };
    const second: RawTestRun = {
      exitCode: 0,
      output: '',
      junit: [{ path: await report(ctx.scratch, '2.xml', passing), base: ctx.root }],
      coverage: {
        path: await report(ctx.scratch, '2.lcov', 'SF:src/a.ts\nDA:1,1\nDA:2,1\nDA:3,0\n'),
        base: ctx.root,
        format: 'lcov',
      },
    };
    const runner = scriptedRunner((_request, call) => (call === 1 ? first : second));
    const run = await runSuite(ctx, runner, FULL_SUITE);
    expect(run.verdicts.map((v) => v.kind)).toEqual(['flaky']);
    expect(run.coverage.get('src/a.ts')).toEqual({
      executable: new Set([1, 2, 3]),
      covered: new Set([1, 2]),
    });
  });

  it('needs a coverage report from a run with tests, and none from a run without', async () => {
    const ctx = await testContext();
    const junit = await report(ctx.scratch, 'j.xml', junitXml([{ name: 'ok' }]));
    const withTests = scriptedRunner(() => ({
      exitCode: 0,
      output: '',
      junit: [{ path: junit, base: ctx.root }],
    }));
    await expect(runSuite(ctx, withTests, FULL_SUITE)).rejects.toThrow(
      'the tests ran 1 test cases but wrote no coverage report',
    );
    const empty = scriptedRunner(() => ({ exitCode: 0, output: '', junit: [] }));
    expect(await runSuite(ctx, empty, FULL_SUITE)).toEqual({ verdicts: [], coverage: new Map() });
  });
});

describe('testsRequest', () => {
  const api = { lang: 'py', root: 'apps/api', os: ['linux'] } as const;

  it('shares the head tier’s run when no tests.full entry concerns the component', async () => {
    expect(testsRequest(await testContext())).toBe(FULL_SUITE);
    const elsewhere = await testContext({
      yml: 'name: T\nprefix: T\ntests: { full: [apps/web/e2e] }\n',
      component: api,
    });
    expect(testsRequest(elsewhere)).toBe(FULL_SUITE);
  });

  it('runs the per-commit suite alone when tests.full applies or the head tier doesn’t run', async () => {
    const full = await testContext({
      yml: 'name: T\nprefix: T\ntests: { full: [apps/api/e2e] }\n',
      component: api,
    });
    expect(testsRequest(full)).toEqual(COMMIT);
    expect(testsRequest(await testContext({ tiers: ['commit'] }))).toEqual(COMMIT);
  });
});

describe('sharedSuite', () => {
  it('runs a suite once per language, component and request', async () => {
    const ctx = await testContext({ component: { lang: 'ts', root: 'web', os: ['linux'] } });
    const runner = scriptedRunner(() => ({ exitCode: 0, output: '', junit: [] }));
    await sharedSuite('ts', runner, ctx, COMMIT);
    await sharedSuite('ts', runner, ctx, COMMIT);
    await sharedSuite('ts', runner, ctx, FULL_SUITE);
    expect(runner.requests).toEqual([COMMIT, FULL_SUITE]);
    expect(ctx.memoKeys).toEqual([
      'quality:ts:web:commit:false',
      'quality:ts:web:commit:false',
      'quality:ts:web:all:true',
    ]);
  });

  it('keys the root component as `.`', async () => {
    const ctx = await testContext();
    const runner = scriptedRunner(() => ({ exitCode: 0, output: '', junit: [] }));
    await sharedSuite('py', runner, ctx, COMMIT);
    expect(ctx.memoKeys).toEqual(['quality:py:.:commit:false']);
  });
});

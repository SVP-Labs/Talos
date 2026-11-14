import { describe, expect, it } from 'vitest';
import {
  failingTests,
  judgeTests,
  rerunFiles,
  testFindings,
  type TestResult,
  type TestVerdict,
} from './verdicts.js';

function result(id: string, status: TestResult['status'], fields: Partial<TestResult> = {}) {
  return { id, name: id, status, ...fields };
}

function inA(name: string, status: TestResult['status'], fields: Partial<TestResult> = {}) {
  return result(`a.test.ts::${name}`, status, { file: 'a.test.ts', ...fields });
}

describe('failingTests', () => {
  it('keeps one result per failing test id, errors included', () => {
    const results = [
      result('a', 'passed'),
      result('b', 'failed', { message: 'first' }),
      result('b', 'failed', { message: 'second' }),
      result('c', 'errored'),
      result('d', 'skipped'),
    ];
    expect(failingTests(results)).toEqual([
      result('b', 'failed', { message: 'first' }),
      result('c', 'errored'),
    ]);
  });

  it('counts a test as failed if any of its cases failed, whatever the order', () => {
    const passedFirst = [result('p', 'passed'), result('p', 'failed')];
    const skippedFirst = [result('s', 'skipped'), result('s', 'passed'), result('s', 'errored')];
    expect(failingTests(passedFirst).map((test) => test.id)).toEqual(['p']);
    expect(failingTests(skippedFirst).map((test) => test.id)).toEqual(['s']);
    expect(failingTests([result('x', 'failed'), result('x', 'passed')])).toHaveLength(1);
    expect(failingTests([result('y', 'passed'), result('y', 'passed')])).toEqual([]);
    expect(failingTests([result('y', 'passed'), result('y', 'skipped')])).toEqual([]);
    expect(failingTests([result('f', 'failed'), result('f', 'skipped')])).toEqual([
      result('f', 'failed'),
    ]);
  });
});

describe('rerunFiles', () => {
  it('lists the failing tests’ files once each, sorted', () => {
    const failing = [
      result('a', 'failed', { file: 'tests/b.py' }),
      result('b', 'failed', { file: 'tests/a.py' }),
      result('c', 'failed', { file: 'tests/b.py' }),
    ];
    expect(rerunFiles(failing)).toEqual(['tests/a.py', 'tests/b.py']);
  });

  it('reruns everything when a failing test’s file is unknown', () => {
    expect(
      rerunFiles([result('a', 'failed', { file: 'a.py' }), result('b', 'failed')]),
    ).toBeUndefined();
  });
});

describe('judgeTests', () => {
  it('calls a test that failed and then passed flaky, and one that failed twice failed', () => {
    const first = [result('a', 'failed'), result('b', 'failed'), result('c', 'passed')];
    const rerun = [result('a', 'passed'), result('b', 'failed', { message: 'again' })];
    expect(judgeTests(first, rerun)).toEqual([
      { kind: 'flaky', test: result('a', 'failed'), first: 'failed', rerun: 'passed' },
      {
        kind: 'failed',
        test: result('b', 'failed', { message: 'again' }),
        first: 'failed',
        rerun: 'failed',
      },
    ]);
  });

  it('fails a test the rerun skipped or didn’t run', () => {
    const verdicts = judgeTests(
      [result('a', 'failed'), result('b', 'errored')],
      [result('a', 'skipped')],
    );
    expect(verdicts).toEqual([
      { kind: 'failed', test: result('a', 'failed'), first: 'failed', rerun: 'missing' },
      { kind: 'failed', test: result('b', 'errored'), first: 'failed', rerun: 'missing' },
    ]);
  });

  it('fails a test with a file that the rerun skipped, however the file’s other tests fared', () => {
    const plain = inA('merged > judges', 'failed', { message: 'expected 1 to be 2' });
    const first = [plain, inA('other > runs', 'passed')];
    const rerun = [inA('merged > judges', 'skipped'), inA('other > runs', 'passed')];
    expect(judgeTests(first, rerun)).toEqual([
      { kind: 'failed', test: plain, first: 'failed', rerun: 'missing' },
    ]);
  });

  it('judges a suite whose hook failed by its file’s tests on the rerun', () => {
    const hook = inA('merged', 'failed', { message: 'Hook timed out in 10000ms' });
    const first = [
      inA('merged > judges', 'skipped'),
      inA('merged > reports', 'skipped'),
      inA('other > runs', 'passed'),
      hook,
    ];
    const passing = [
      inA('merged > judges', 'passed'),
      inA('merged > reports', 'passed'),
      inA('other > runs', 'passed'),
      result('b.test.ts::merged > runs', 'failed', { file: 'b.test.ts' }),
    ];
    expect(judgeTests(first, passing)).toEqual([
      { kind: 'flaky', test: hook, first: 'failed', rerun: 'passed' },
    ]);
    const broken = inA('merged > reports', 'failed', { message: 'broken' });
    expect(judgeTests(first, [inA('merged > judges', 'passed'), broken])).toEqual([
      { kind: 'failed', test: broken, first: 'failed', rerun: 'failed' },
    ]);
    const elsewhere = inA('other > runs', 'failed');
    expect(judgeTests(first, [inA('merged > judges', 'passed'), elsewhere])).toEqual([
      { kind: 'failed', test: hook, first: 'failed', rerun: 'failed' },
      { kind: 'flaky', test: elsewhere, first: 'passed', rerun: 'failed' },
    ]);
    expect(judgeTests(first, [inA('merged > judges', 'skipped')])).toEqual([
      { kind: 'failed', test: hook, first: 'failed', rerun: 'missing' },
    ]);
  });

  it('never hands a suite a rerun failure that has a verdict of its own', () => {
    const hook = inA('merged', 'failed', { message: 'Hook timed out in 10000ms' });
    const twice = inA('other > runs', 'failed', { message: 'again' });
    const first = [inA('merged > judges', 'skipped'), inA('other > runs', 'failed'), hook];
    const verdicts = judgeTests(first, [inA('merged > judges', 'passed'), twice]);
    expect(verdicts.map((verdict) => [verdict.kind, verdict.test.id])).toEqual([
      ['failed', 'a.test.ts::merged'],
      ['failed', 'a.test.ts::other > runs'],
    ]);
  });

  it('never hands one rerun failure to two suites of a file', () => {
    const first = [
      inA('merged > judges', 'skipped'),
      inA('compared > compares', 'skipped'),
      inA('merged', 'failed', { message: 'Hook timed out in 10000ms' }),
      inA('compared', 'failed', { message: 'Hook timed out in 10000ms' }),
    ];
    const broken = inA('merged > judges', 'failed', { message: 'broken' });
    const verdicts = judgeTests(first, [broken, inA('compared > compares', 'passed')]);
    expect(verdicts.map((verdict) => [verdict.kind, verdict.test.id])).toEqual([
      ['failed', 'a.test.ts::compared'],
      ['failed', 'a.test.ts::merged > judges'],
    ]);
  });

  it('calls a test that passed and then failed on the rerun flaky', () => {
    const verdicts = judgeTests(
      [result('a', 'failed'), result('z', 'passed')],
      [result('a', 'failed'), result('z', 'failed')],
    );
    expect(verdicts).toEqual([
      { kind: 'failed', test: result('a', 'failed'), first: 'failed', rerun: 'failed' },
      { kind: 'flaky', test: result('z', 'failed'), first: 'passed', rerun: 'failed' },
    ]);
  });

  it('counts a test as passed if any case passed, whatever its skipped cases', () => {
    const rerun = [result('s', 'failed'), result('k', 'failed')];
    const skippedFirst = [result('s', 'skipped'), result('s', 'passed')];
    const skippedLast = [result('k', 'passed'), result('k', 'skipped')];
    expect(judgeTests([...skippedFirst, ...skippedLast], rerun)).toEqual([
      { kind: 'flaky', test: result('k', 'failed'), first: 'passed', rerun: 'failed' },
      { kind: 'flaky', test: result('s', 'failed'), first: 'passed', rerun: 'failed' },
    ]);
  });

  it('orders the verdicts by test id', () => {
    const verdicts = judgeTests(
      [result('m', 'failed'), result('c', 'passed'), result('b', 'failed')],
      [result('m', 'failed'), result('c', 'failed'), result('b', 'failed')],
    );
    expect(verdicts.map((verdict) => verdict.test.id)).toEqual(['b', 'c', 'm']);
  });

  it('ignores a test the first run only skipped', () => {
    expect(judgeTests([result('s', 'skipped')], [result('s', 'failed')])).toEqual([]);
  });

  it('ignores tests only the rerun ran', () => {
    expect(
      judgeTests([result('a', 'failed')], [result('a', 'passed'), result('n', 'failed')]),
    ).toHaveLength(1);
  });
});

describe('testFindings', () => {
  const test = result('tests/a.py::test_x', 'failed', {
    name: 'test_x',
    file: 'tests/a.py',
    line: 12,
    message: 'assert 3 == 4',
  });

  it('reports a test that failed twice at its file, keyed by its id', () => {
    const verdict: TestVerdict = { kind: 'failed', test, first: 'failed', rerun: 'failed' };
    expect(testFindings([verdict])).toEqual([
      {
        rule: 'tests/failed',
        message: 'Test "test_x" failed, and failed again when rerun: assert 3 == 4',
        key: 'tests/a.py::test_x',
        location: { file: 'tests/a.py', line: 12 },
      },
    ]);
  });

  it('reports a flaky test as information only', () => {
    const flaky: TestVerdict = { kind: 'flaky', test, first: 'failed', rerun: 'passed' };
    const late: TestVerdict = { kind: 'flaky', test, first: 'passed', rerun: 'failed' };
    expect(testFindings([flaky, late])).toEqual([
      expect.objectContaining({
        rule: 'tests/flaky',
        policy: 'info',
        message: 'Test "test_x" failed, then passed when rerun, so it is flaky: assert 3 == 4',
      }),
      expect.objectContaining({
        message: 'Test "test_x" passed, then failed when rerun, so it is flaky: assert 3 == 4',
      }),
    ]);
  });

  it('reports a test with no file without a location, and one the rerun missed', () => {
    const bare = result('demo::adds', 'failed', { name: 'adds' });
    const missed: TestVerdict = { kind: 'failed', test: bare, first: 'failed', rerun: 'missing' };
    expect(testFindings([missed])).toStrictEqual([
      {
        rule: 'tests/failed',
        message: 'Test "adds" failed, and its rerun did not run it: no message',
        key: 'demo::adds',
      },
    ]);
    const atTop = result('t', 'failed', { file: 'a.lua', line: 0 });
    expect(
      testFindings([{ kind: 'failed', test: atTop, first: 'failed', rerun: 'failed' }])[0]
        ?.location,
    ).toEqual({ file: 'a.lua', line: 1 });
  });
});

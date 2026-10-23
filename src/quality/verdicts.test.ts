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
    expect(verdicts.map((verdict) => [verdict.test.id, verdict.kind, verdict.rerun])).toEqual([
      ['a', 'failed', 'missing'],
      ['b', 'failed', 'missing'],
    ]);
  });

  it('calls a test that passed and then failed on the rerun flaky', () => {
    const verdicts = judgeTests(
      [result('a', 'failed'), result('z', 'passed')],
      [result('a', 'failed'), result('z', 'failed')],
    );
    expect(verdicts.map((verdict) => [verdict.test.id, verdict.kind, verdict.first])).toEqual([
      ['a', 'failed', 'failed'],
      ['z', 'flaky', 'passed'],
    ]);
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
    expect(testFindings([missed])).toEqual([
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

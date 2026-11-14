import type { TestStatus } from './junit.js';
import { clip } from './text.js';
import type { Finding, Location } from '../core/finding.js';

const NEVER_BLOCKING: Pick<Finding, 'policy'> = { policy: 'info' };

/** A test case of a run, its file made repository-relative. */
export type TestResult = {
  /** Stable across runs and commits: see `testId`. */
  readonly id: string;
  readonly name: string;
  /** Repository-relative, when the report names the test's file. */
  readonly file?: string;
  readonly line?: number;
  readonly status: TestStatus;
  readonly message?: string;
};

export type TestVerdict = {
  /** `failed`: failed and didn't pass on the rerun; `flaky`: the two runs disagreed. */
  readonly kind: 'failed' | 'flaky';
  /** The result whose message explains the failure. */
  readonly test: TestResult;
  /** How the test fared the first time. */
  readonly first: 'passed' | 'failed';
  /** How the test fared on the rerun; `missing` when the rerun didn't run it. */
  readonly rerun: 'passed' | 'failed' | 'missing';
};

type Summary = { readonly state: 'passed' | 'failed'; readonly result: TestResult };

function isFailure(status: TestStatus): boolean {
  return status === 'failed' || status === 'errored';
}

/** One summary per test id: failed if any case with the id failed, passed if any passed. */
function summarise(results: readonly TestResult[]): Map<string, Summary> {
  const summaries = new Map<string, Summary>();
  for (const result of results) {
    const known = summaries.get(result.id);
    if (isFailure(result.status)) {
      if (known?.state !== 'failed') summaries.set(result.id, { state: 'failed', result });
    } else if (result.status === 'passed' && known === undefined) {
      summaries.set(result.id, { state: 'passed', result });
    }
  }
  return summaries;
}

/** The failing tests of a run, one result per test id. */
export function failingTests(results: readonly TestResult[]): TestResult[] {
  return [...summarise(results).values()]
    .filter((summary) => summary.state === 'failed')
    .map((summary) => summary.result);
}

/** The files to rerun, or undefined when a failing test's file is unknown (rerun everything). */
export function rerunFiles(failing: readonly TestResult[]): string[] | undefined {
  const files = new Set<string>();
  for (const test of failing) {
    if (test.file === undefined) return undefined;
    files.add(test.file);
  }
  return [...files].sort((a, b) => a.localeCompare(b));
}

/**
 * Whether a failed case is a suite whose hook failed: the run skipped tests inside it, named
 * `<suite> > <test>`. Any other failed test the rerun didn't report still counts as failed.
 */
function isSuite(id: string, first: readonly TestResult[]): boolean {
  return first.some((result) => result.status === 'skipped' && result.id.startsWith(`${id} > `));
}

/**
 * How a suite's file fared on the rerun, for a suite the rerun didn't report. When a suite's hook
 * fails, Vitest reports one failed case named after the suite and skips its tests; a rerun whose
 * hook passes reports those tests and no case for the suite. A failure in the file is taken over
 * only once, and only when it has no verdict of its own: one test, one finding.
 */
function fileRerun(
  test: TestResult,
  before: ReadonlyMap<string, Summary>,
  after: ReadonlyMap<string, Summary>,
  taken: Set<string>,
): Summary | undefined {
  if (test.file === undefined) return undefined;
  const inFile = [...after.values()].filter((summary) => summary.result.file === test.file);
  const failed = inFile.filter((summary) => summary.state === 'failed');
  if (failed.length === 0) return inFile[0];
  const own = failed.find(
    (summary) => !before.has(summary.result.id) && !taken.has(summary.result.id),
  );
  if (own === undefined) return { state: 'failed', result: test };
  taken.add(own.result.id);
  return own;
}

function afterFailure(failed: TestResult, rerun: Summary | undefined): TestVerdict {
  if (rerun?.state === 'passed') {
    return { kind: 'flaky', test: failed, first: 'failed', rerun: 'passed' };
  }
  if (rerun?.state === 'failed') {
    return { kind: 'failed', test: rerun.result, first: 'failed', rerun: 'failed' };
  }
  return { kind: 'failed', test: failed, first: 'failed', rerun: 'missing' };
}

/**
 * Judges a run and its rerun of the failures: a test that failed and then passed is flaky, one
 * that failed and didn't pass again failed; a test that passed and then failed on the rerun is
 * flaky too. A suite whose hook failed, which the rerun doesn't report, is judged by its file:
 * flaky when the file's tests passed on the rerun, failed when one of them failed.
 */
export function judgeTests(
  first: readonly TestResult[],
  rerun: readonly TestResult[],
): TestVerdict[] {
  const before = summarise(first);
  const after = summarise(rerun);
  const verdicts: TestVerdict[] = [];
  const taken = new Set<string>();
  for (const [id, summary] of before) {
    if (summary.state !== 'failed') continue;
    let again = after.get(id);
    if (again === undefined && isSuite(id, first)) {
      again = fileRerun(summary.result, before, after, taken);
    }
    verdicts.push(afterFailure(summary.result, again));
  }
  for (const [id, summary] of after) {
    if (summary.state === 'failed' && before.get(id)?.state === 'passed') {
      verdicts.push({ kind: 'flaky', test: summary.result, first: 'passed', rerun: 'failed' });
    }
  }
  return verdicts.sort((a, b) => a.test.id.localeCompare(b.test.id));
}

function locationOf(test: TestResult): Location | undefined {
  return test.file === undefined
    ? undefined
    : { file: test.file, line: Math.max(1, test.line ?? 1) };
}

function describe(verdict: TestVerdict): string {
  const name = `Test "${clip(verdict.test.name, 80)}"`;
  const reason = verdict.test.message ?? 'no message';
  if (verdict.kind === 'flaky') {
    return verdict.first === 'failed'
      ? `${name} failed, then passed when rerun, so it is flaky: ${reason}`
      : `${name} passed, then failed when rerun, so it is flaky: ${reason}`;
  }
  return verdict.rerun === 'failed'
    ? `${name} failed, and failed again when rerun: ${reason}`
    : `${name} failed, and its rerun did not run it: ${reason}`;
}

/** `tests/failed` for a test that failed twice, `tests/flaky` (never blocking) for a flaky one. */
export function testFindings(verdicts: readonly TestVerdict[]): Finding[] {
  return verdicts.map((verdict) => {
    const location = locationOf(verdict.test);
    return {
      rule: verdict.kind === 'failed' ? 'tests/failed' : 'tests/flaky',
      message: describe(verdict),
      key: verdict.test.id,
      ...(location === undefined ? {} : { location }),
      ...(verdict.kind === 'flaky' ? NEVER_BLOCKING : {}),
    };
  });
}

import { type LineCoverage, mergeCoverage } from './coverage.js';
import { overlaps } from './paths.js';
import type { RawTestRun, TestRequest, TestRunner } from './protocol.js';
import { readCoverage, readTests } from './reports.js';
import { lastLines } from './text.js';
import {
  failingTests,
  judgeTests,
  rerunFiles,
  type TestResult,
  type TestVerdict,
} from './verdicts.js';
import { type CheckContext, EngineError, type Lang } from '../core/check.js';

/** A suite's run, with the one rerun of its failures already judged. */
export type SuiteRun = {
  readonly verdicts: readonly TestVerdict[];
  /** Both runs' coverage together, when coverage was asked for. */
  readonly coverage?: LineCoverage;
};

/** Every test, with coverage: the head tier's run. */
export const FULL_SUITE: TestRequest = { suite: 'all', coverage: true };

/** Every test outside `tests.full`, without coverage: the per-commit run. */
const COMMIT_SUITE: TestRequest = { suite: 'commit', coverage: false };

/**
 * The run `<lang>/tests` judges. When this run also executes the head tier and no `tests.full`
 * entry concerns the component, the per-commit suite is every test, so it is the head tier's run,
 * shared rather than run twice.
 */
export function testsRequest(ctx: CheckContext): TestRequest {
  const full = ctx.config.tests.full.some((entry) => overlaps(ctx.component, entry));
  return ctx.tiers.includes('head') && !full ? FULL_SUITE : COMMIT_SUITE;
}

function explain(run: RawTestRun, failing: readonly TestResult[], which: string): void {
  if (run.exitCode === 0 || failing.length > 0) return;
  const tail = lastLines(run.output);
  throw new EngineError(
    `the tests exited ${run.exitCode} on ${which} with no failing test in their JUnit report:
${tail}`,
  );
}

async function coverageOf(
  ctx: CheckContext,
  request: TestRequest,
  run: RawTestRun,
  tests: number,
): Promise<LineCoverage | undefined> {
  if (!request.coverage) return undefined;
  if (run.coverage !== undefined) return readCoverage(ctx, run.coverage);
  if (tests === 0) return new Map();
  throw new EngineError(`the tests ran ${tests} test cases but wrote no coverage report`);
}

/**
 * Runs the suite; when tests fail, reruns them once (only their files, when every failing test
 * names its file) and judges both runs. A non-zero exit with no failing test is an engine error.
 */
export async function runSuite(
  ctx: CheckContext,
  runner: TestRunner,
  request: TestRequest,
): Promise<SuiteRun> {
  const first = await runner.run(ctx, request);
  const firstTests = await readTests(ctx, first.junit);
  const failing = failingTests(firstTests);
  explain(first, failing, 'their run');
  const coverage = await coverageOf(ctx, request, first, firstTests.length);
  if (failing.length === 0) return { verdicts: [], ...(coverage ? { coverage } : {}) };
  const files = rerunFiles(failing);
  const second = await runner.run(ctx, { ...request, ...(files === undefined ? {} : { files }) });
  const secondTests = await readTests(ctx, second.junit);
  explain(second, failingTests(secondTests), 'their rerun');
  const again = await coverageOf(ctx, request, second, secondTests.length);
  const verdicts = judgeTests(firstTests, secondTests);
  if (coverage === undefined || again === undefined) return { verdicts };
  return { verdicts, coverage: mergeCoverage(coverage, again) };
}

/** One run per language, component and request, however many checks of a run ask for it. */
export function sharedSuite(
  lang: Lang,
  runner: TestRunner,
  ctx: CheckContext,
  request: TestRequest,
): Promise<SuiteRun> {
  const component = ctx.component?.root ?? '.';
  const key = `quality:${lang}:${component}:${request.suite}:${String(request.coverage)}`;
  return ctx.memo(key, () => runSuite(ctx, runner, request));
}

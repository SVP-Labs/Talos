import { join } from 'node:path';
import type { CheckContext } from '../../../core/check.js';
import type { RawTestRun, TestRequest, TestRunner } from '../../../quality/index.js';
import { playwrightSuites, suiteImports } from '../checks/e2e.js';
import { fullTestsHere, inComponent, rootOf } from '../files.js';
import { componentDir, exists, nodeTool, runTool, tail } from '../node.js';

export type VitestPlan = {
  readonly junit: string;
  readonly coverageDir: string;
  /** Directories left out of the run, relative to the component's root. */
  readonly excluded: readonly string[];
  /** Test files to run, relative to the component's root; all of them when absent. */
  readonly files?: readonly string[];
  readonly coverage: boolean;
};

/** The arguments for one Vitest run: JUnit and, when asked, LCOV coverage, both into scratch. */
export function vitestArgs(plan: VitestPlan): string[] {
  const coverage = plan.coverage
    ? [
        '--coverage.enabled',
        '--coverage.provider=v8',
        '--coverage.reporter=lcovonly',
        `--coverage.reportsDirectory=${plan.coverageDir}`,
        '--coverage.reportOnFailure',
      ]
    : ['--coverage.enabled=false'];
  return [
    'run',
    '--reporter=junit',
    `--outputFile=${plan.junit}`,
    '--passWithNoTests',
    '--allowOnly=false',
    ...plan.excluded.flatMap((dir) => ['--exclude', `${dir}/**`]),
    ...coverage,
    ...(plan.files ?? []),
  ];
}

/** The suites Playwright runs, which Vitest never should (component-relative). */
async function playwrightDirs(ctx: CheckContext): Promise<string[]> {
  const root = rootOf(ctx.component);
  const dirs: string[] = [];
  for (const suite of playwrightSuites(ctx)) {
    if ((await suiteImports(ctx, suite)).playwright) dirs.push(inComponent(root, suite.path));
  }
  return dirs;
}

async function excludedFor(ctx: CheckContext, request: TestRequest): Promise<string[]> {
  const e2e = await playwrightDirs(ctx);
  if (request.suite === 'all') return e2e;
  const full = fullTestsHere(ctx.config.tests.full, rootOf(ctx.component));
  return [...new Set([...full, ...e2e])];
}

/** Distinct per request, so a rerun never reads the first run's reports. */
function runName(request: TestRequest): string {
  const kind = request.files === undefined ? 'run' : 'rerun';
  return `${request.suite}-${kind}${request.coverage ? '-coverage' : ''}`;
}

/**
 * Vitest for the shared test checks: the commit suite leaves `tests.full` out, the full suite
 * leaves out only what Playwright runs; a rerun names its files.
 */
export const vitestRunner: TestRunner = {
  async run(ctx: CheckContext, request: TestRequest): Promise<RawTestRun> {
    const root = rootOf(ctx.component);
    const dir = componentDir(ctx);
    const name = runName(request);
    const plan: VitestPlan = {
      junit: join(ctx.scratch, `vitest-${name}.xml`),
      coverageDir: join(ctx.scratch, `coverage-${name}`),
      excluded: await excludedFor(ctx, request),
      coverage: request.coverage,
      ...(request.files === undefined
        ? {}
        : { files: request.files.map((file) => inComponent(root, file)) }),
    };
    const tool = await nodeTool(ctx, 'vitest', 'vitest');
    const result = await runTool(ctx, tool, vitestArgs(plan), { timeoutMs: 60 * 60 * 1000 });
    const lcov = join(plan.coverageDir, 'lcov.info');
    const covered = request.coverage && (await exists(lcov));
    return {
      exitCode: result.code,
      output: tail(result, 40),
      junit: (await exists(plan.junit)) ? [{ path: plan.junit, base: dir }] : [],
      ...(covered ? { coverage: { path: lcov, base: dir, format: 'lcov' } } : {}),
    };
  },
};

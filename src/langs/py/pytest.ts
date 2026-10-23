import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { componentDir, fileExists, inComponent } from './paths.js';
import { type Bound, bind, failed, runTool } from './run.js';
import type { CheckContext } from '../../core/check.js';
import type { RawTestRun, TestRequest, TestRunner } from '../../quality/protocol.js';

/**
 * pytest's arguments for a request: `files` (the rerun) as given, otherwise the suite, leaving
 * out `tests.full` for the per-commit suite. Paths come in repository-relative and go out
 * relative to the component. xunit1 JUnit carries each test's file, which the rerun needs.
 */
export function pytestArgs(
  request: TestRequest,
  ctx: { readonly root: string; readonly full: readonly string[]; readonly junit: string },
): string[] {
  const own = (paths: readonly string[]): string[] =>
    paths.flatMap((path) => inComponent(ctx.root, path) ?? []);
  const ignored = request.suite === 'commit' ? own(ctx.full).map((path) => `--ignore=${path}`) : [];
  const selection = request.files === undefined ? ignored : own(request.files);
  return [
    '-p',
    'no:cacheprovider',
    '--rootdir=.',
    '--strict-markers',
    '-o',
    'strict_xfail=true',
    '-o',
    'junit_family=xunit1',
    `--junitxml=${ctx.junit}`,
    '-q',
    '--color=no',
    ...selection,
  ];
}

/**
 * Coverage of every Python file in the component that isn't a test, with lines that can never
 * run (type-checking imports, overload stubs) left out. The project's own coverage settings
 * don't apply, so they can't exclude code from the measure.
 */
export function coverageRc(dataFile: string): string {
  return [
    '[run]',
    `data_file = ${dataFile}`,
    'source = .',
    'relative_files = true',
    'omit =',
    ...['.venv/*', 'tests/*', 'test/*', '*/tests/*', '*/test/*'].map((glob) => `    ${glob}`),
    ...['*/test_*.py', '*_test.py', '*/conftest.py', 'conftest.py'].map((glob) => `    ${glob}`),
    '',
    '[report]',
    'exclude_also =',
    '    if TYPE_CHECKING:',
    '    @(typing\\.)?overload',
    '',
  ].join('\n');
}

async function lcov(ctx: Bound, dir: string, rc: string): Promise<string> {
  const out = join(dir, 'coverage.lcov');
  const args = ['-m', 'coverage', 'lcov', `--rcfile=${rc}`, '-o', out];
  const result = await runTool(ctx, 'python', args);
  if (result.code === 0) return out;
  if (!`${result.stdout}${result.stderr}`.includes('No data to report')) {
    throw failed('coverage lcov', result);
  }
  await writeFile(out, '');
  return out;
}

async function run(context: CheckContext, request: TestRequest): Promise<RawTestRun> {
  const ctx = bind(context);
  const dir = await mkdtemp(join(ctx.scratch, 'pytest-'));
  const junit = join(dir, 'junit.xml');
  const rc = join(dir, 'coveragerc');
  const full = ctx.config.tests.full;
  const args = pytestArgs(request, { root: ctx.component.root, full, junit });
  if (request.coverage) await writeFile(rc, coverageRc(join(dir, 'coverage.data')));
  const command = request.coverage
    ? ['-m', 'coverage', 'run', `--rcfile=${rc}`, '-m', 'pytest', ...args]
    : ['-m', 'pytest', ...args];
  const result = await runTool(ctx, 'python', command, { timeoutMs: 2 * 60 * 60 * 1000 });
  if (!(await fileExists(junit))) throw failed('pytest, which wrote no JUnit report,', result);
  const base = componentDir(ctx);
  return {
    exitCode: result.code,
    output: `${result.stdout}${result.stderr}`,
    junit: [{ path: junit, base }],
    ...(request.coverage
      ? { coverage: { path: await lcov(ctx, dir, rc), base, format: 'lcov' } }
      : {}),
  };
}

/** pytest, under coverage.py when coverage is asked for. */
export const pytestRunner: TestRunner = { run };

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { componentDir, fileExists, inComponent, phpFiles, shippedFiles } from './paths.js';
import { bind, type Bound, runVendorTool, tail } from './run.js';
import { topLevel } from './scope.js';
import type { CheckContext } from '../../core/check.js';
import { EngineError } from '../../core/check.js';
import type { RawTestRun, TestRequest, TestRunner } from '../../quality/protocol.js';

/**
 * Pest's JUnit names each test's `file` as `path::test name`; the protocol wants the path alone,
 * as PHPUnit writes it.
 */
export function normalizeJunit(xml: string): string {
  return xml.replaceAll(/ file="([^"]*)"/g, (_match, file: string) => {
    const [path = file] = file.split('::');
    return ` file="${path}"`;
  });
}

/** Whether a component-relative path is one of `full` (component-relative) or under it. */
function under(path: string, full: readonly string[]): boolean {
  return full.some((entry) => {
    let end = entry.length;
    while (end > 0 && entry[end - 1] === '/') end -= 1;
    const dir = entry.slice(0, end);
    return path === dir || path.startsWith(`${dir}/`);
  });
}

/**
 * The test files a request names, relative to the component: the rerun's files, or for the
 * per-commit suite every `*Test.php` outside `tests.full`. Undefined means the whole suite as
 * phpunit.xml declares it; an empty list means nothing to run.
 */
export function testPaths(
  ctx: Pick<Bound, 'facts' | 'component' | 'config'>,
  request: TestRequest,
): string[] | undefined {
  const root = ctx.component.root;
  const local = (paths: readonly string[]): string[] =>
    paths
      .map((path) => inComponent(root, path))
      .filter((path): path is string => path !== undefined);
  if (request.files !== undefined) return local(request.files);
  const full = local(ctx.config.tests.full);
  if (request.suite === 'all' || full.length === 0) return undefined;
  return phpFiles(ctx).filter((file) => file.endsWith('Test.php') && !under(file, full));
}

/**
 * Coverage of shipped code only: each top-level directory holding shipped PHP is a coverage
 * filter, whatever phpunit.xml's `<source>` says (config-strength reports its exclusions).
 */
export function coverageArgs(ctx: Pick<Bound, 'facts' | 'component'>, clover: string): string[] {
  const { dirs } = topLevel(shippedFiles(ctx));
  return ['--coverage-clover', clover, ...dirs.flatMap((dir) => ['--coverage-filter', dir])];
}

async function run(ctx: CheckContext, request: TestRequest): Promise<RawTestRun> {
  const bound = bind(ctx);
  const paths = testPaths(bound, request);
  if (paths?.length === 0) return { exitCode: 0, output: '', junit: [] };
  const dir = await mkdtemp(join(ctx.scratch, 'pest-'));
  const junit = join(dir, 'junit.xml');
  const clover = join(dir, 'clover.xml');
  const base = componentDir(bound);
  const args = ['--colors=never', '--do-not-cache-result', '--log-junit', junit];
  const result = await runVendorTool(
    bound,
    'pest',
    [
      ...args,
      ...(request.coverage ? coverageArgs(bound, clover) : ['--no-coverage']),
      ...(paths ?? []),
    ],
    {
      env: { XDEBUG_MODE: request.coverage ? 'coverage' : 'off' },
      ini: request.coverage
        ? { 'pcov.enabled': '1', 'pcov.directory': base }
        : { 'pcov.enabled': '0' },
    },
  );
  if (!(await fileExists(junit))) {
    throw new EngineError(`pest wrote no JUnit report (exit ${result.code}):\n${tail(result)}`);
  }
  await writeFile(junit, normalizeJunit(await readFile(junit, 'utf8')));
  const output = `${result.stdout}\n${result.stderr}`;
  if (!request.coverage) return { exitCode: result.code, output, junit: [{ path: junit, base }] };
  if (!(await fileExists(clover))) {
    throw new EngineError('pest wrote no coverage report: the PHP running it needs pcov or Xdebug');
  }
  return {
    exitCode: result.code,
    output,
    junit: [{ path: junit, base }],
    coverage: { path: clover, base, format: 'clover' },
  };
}

/** Pest, which runs PHPUnit tests too, for the shared tests and coverage checks. */
export const pestRunner: TestRunner = { run };

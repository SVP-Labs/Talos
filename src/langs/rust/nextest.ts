import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cargoTests, type DocRun } from './cargo-test.js';
import { junitXml, withFiles } from './junit.js';
import { rewriteLcov } from './lcov.js';
import { type Workspace, workspace } from './metadata.js';
import { componentDir, fileExists, inComponent, isInside, relativeTo, rustFiles } from './paths.js';
import { type Bound, bind, cargoTool, HOUR, pathWith, type RunOptions } from './run.js';
import { isTestCode, shapes } from './shapes.js';
import { filterFor, testFile } from './testfiles.js';
import type { CheckContext } from '../../core/check.js';
import { EngineError } from '../../core/check.js';
import type { ExecResult } from '../../exec/exec.js';
import type { RawTestRun, Report, TestRequest, TestRunner } from '../../quality/protocol.js';

const PROFILE = 'talos';

/** nextest exits 101 when the tests don't build. */
const BUILD_FAILED = 101;

/**
 * Talos's nextest profile, as a tool config the repository's own config sits above: the
 * repository may set timeouts and test groups, while retries, fail-fast and the default filter
 * are overridden on the command line, so a flaky test reaches the shared rerun.
 */
export function nextestConfig(store: string): string {
  return [
    '[store]',
    `dir = ${JSON.stringify(store.replaceAll('\\', '/'))}`,
    '',
    `[profile.${PROFILE}.junit]`,
    'path = "junit.xml"',
    'store-success-output = false',
    'store-failure-output = true',
    '',
  ].join('\n');
}

/**
 * Which tests a request runs, as a nextest filterset over files relative to the component:
 * the rerun's files, or everything but `tests.full`. `undefined` runs every test; `null` none.
 */
type Local = { readonly files?: readonly string[]; readonly full: readonly string[] };

export function selection(
  ws: Workspace,
  request: TestRequest,
  local: Local,
): string | undefined | null {
  if (local.files !== undefined) return filterFor(ws, local.files) ?? null;
  if (request.suite === 'commit' && local.full.length > 0) {
    const full = filterFor(ws, local.full);
    return full === undefined ? undefined : `not (${full})`;
  }
  return undefined;
}

export function nextestArgs(config: string, filter: string | undefined): string[] {
  return [
    '--workspace',
    '--all-features',
    '--locked',
    '--no-fail-fast',
    '--retries',
    '0',
    '--ignore-default-filter',
    '--no-tests',
    'pass',
    '--color',
    'never',
    '--tool-config-file',
    `talos:${config}`,
    '--profile',
    PROFILE,
    ...(filter === undefined ? [] : ['-E', filter]),
  ];
}

/** The one failing case a run that couldn't build its tests stands for. */
export function buildFailure(result: ExecResult): string {
  const error = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .find((line) => line.startsWith('error'));
  return junitXml('cargo', [
    {
      name: 'the tests build',
      classname: 'cargo',
      file: 'Cargo.toml',
      failure: (error ?? 'cargo could not build the tests').slice(0, 200),
    },
  ]);
}

type Run = { readonly dir: string; readonly ws: Workspace; readonly filter: string | undefined };

async function nextest(ctx: Bound, run: Run, coverage: boolean): Promise<ExecResult> {
  const config = join(run.dir, 'nextest.toml');
  await writeFile(config, nextestConfig(join(run.dir, 'store')));
  const runner = await ctx.tools.path('cargo-nextest');
  const options: RunOptions = { env: pathWith(process.env, [runner]), timeoutMs: 2 * HOUR };
  const args = nextestArgs(config, run.filter);
  if (!coverage) {
    return cargoTool(ctx, { path: runner, subcommand: 'nextest' }, ['run', ...args], options);
  }
  const llvmCov = await ctx.tools.path('cargo-llvm-cov');
  const lcov = ['--lcov', '--output-path', join(run.dir, 'raw.lcov')];
  return cargoTool(
    ctx,
    { path: llvmCov, subcommand: 'llvm-cov' },
    ['nextest', ...args, ...lcov],
    options,
  );
}

async function junitReport(ctx: Bound, run: Run, result: ExecResult): Promise<Report> {
  const raw = join(run.dir, 'store', PROFILE, 'junit.xml');
  const out = join(run.dir, 'junit.xml');
  const base = componentDir(ctx);
  if (await fileExists(raw)) {
    const own = new Set(rustFiles(ctx));
    const xml = withFiles(await readFile(raw, 'utf8'), (test) =>
      testFile(run.ws, test, (f) => own.has(f)),
    );
    await writeFile(out, xml);
  } else if (result.code === BUILD_FAILED) {
    await writeFile(out, buildFailure(result));
  } else {
    throw new EngineError(`cargo-nextest wrote no JUnit report (exit ${String(result.code)})`);
  }
  return { path: out, base };
}

async function coverageReport(ctx: Bound, run: Run): Promise<Report & { format: 'lcov' }> {
  const base = componentDir(ctx);
  const raw = join(run.dir, 'raw.lcov');
  const text = (await fileExists(raw)) ? await readFile(raw, 'utf8') : '';
  const all = await shapes(ctx);
  const own = new Set(rustFiles(ctx));
  const place = (file: string): string | undefined => {
    const local = relativeTo(base, base, file);
    return isInside(local) && own.has(local) && !all.testFiles.has(local) ? local : undefined;
  };
  const path = join(run.dir, 'coverage.lcov');
  await writeFile(
    path,
    rewriteLcov(text, place, (file) => (line) => isTestCode(all, file, line)),
  );
  return { path, base, format: 'lcov' };
}

type Part = { readonly code: number; readonly output: string; readonly junit: Report };

async function docPart(dir: string, doc: DocRun | undefined): Promise<Part | undefined> {
  if (doc === undefined) return undefined;
  const path = join(dir, 'doctests.xml');
  await writeFile(path, junitXml('doctests', doc.cases));
  return { code: doc.code, output: doc.output, junit: { path, base: doc.base } };
}

function combine(
  parts: readonly (Part | undefined)[],
  coverage?: RawTestRun['coverage'],
): RawTestRun {
  const ran = parts.filter((part): part is Part => part !== undefined);
  return {
    exitCode: ran.find((part) => part.code !== 0)?.code ?? 0,
    output: ran.map((part) => part.output).join(''),
    junit: ran.map((part) => part.junit),
    ...(coverage === undefined ? {} : { coverage }),
  };
}

/** The request's paths relative to the component: `tests.full`, and the rerun's files. */
function localPaths(ctx: Bound, request: TestRequest): Local {
  const own = (paths: readonly string[]): string[] =>
    paths.flatMap((path) => inComponent(ctx.component.root, path) ?? []);
  return {
    full: own(ctx.config.tests.full),
    ...(request.files === undefined ? {} : { files: own(request.files) }),
  };
}

async function run(context: CheckContext, request: TestRequest): Promise<RawTestRun> {
  const ctx = bind(context);
  const ws = await workspace(ctx);
  const local = localPaths(ctx, request);
  const filter = selection(ws, request, local);
  const dir = await mkdtemp(join(ctx.scratch, 'nextest-'));
  const docs = await docPart(dir, await cargoTests(ctx, ws, local, request.suite));
  if (filter === null) return combine([docs]);
  const plan: Run = { dir, ws, filter };
  const result = await nextest(ctx, plan, request.coverage);
  const junit = await junitReport(ctx, plan, result);
  const tests: Part = { code: result.code, output: `${result.stdout}${result.stderr}`, junit };
  return combine([tests, docs], request.coverage ? await coverageReport(ctx, plan) : undefined);
}

/**
 * cargo-nextest for the shared test checks, under cargo-llvm-cov when coverage is asked for,
 * and doctests through `cargo test --doc`, which nextest doesn't run.
 */
export const nextestRunner: TestRunner = { run };

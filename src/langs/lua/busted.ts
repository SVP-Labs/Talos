import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  componentDir,
  fileExists,
  inComponent,
  inRepo,
  luaFiles,
  sourceFiles,
  specFiles,
  withoutTrailingSlashes,
} from './paths.js';
import { type Bound, bind, chunks, failed, runScript, runTree } from './run.js';
import { LCOV_SCRIPT } from './scripts/lcov.js';
import type { CheckContext } from '../../core/check.js';
import type { RawTestRun, TestRequest, TestRunner } from '../../quality/protocol.js';

const TWO_HOURS = 2 * 60 * 60 * 1000;

/** Whether a repository-relative path is one of `paths` or under one. */
function under(path: string, paths: readonly string[]): boolean {
  return paths.some((p) => path === p || path.startsWith(`${withoutTrailingSlashes(p)}/`));
}

/**
 * The spec files a request runs, relative to the component: the rerun's files as given, the
 * per-commit suite without `tests.full`, or every spec.
 */
export function selectSpecs(
  request: TestRequest,
  ctx: {
    readonly root: string;
    readonly specs: readonly string[];
    readonly full: readonly string[];
  },
): string[] {
  if (request.files !== undefined) {
    return request.files.flatMap((file) => inComponent(ctx.root, file) ?? []);
  }
  if (request.suite === 'all') return [...ctx.specs];
  return ctx.specs.filter((spec) => !under(inRepo(ctx.root, spec), ctx.full));
}

export type BustedPlan = {
  readonly config: string;
  readonly junit: string;
  /** luacov's settings file, when coverage is measured. */
  readonly coverage?: string;
  readonly specs: readonly string[];
};

/**
 * busted's arguments: Talos's empty settings file instead of the project's `.busted` (whose
 * tags and patterns could skip tests), JUnit into a file (tests may print), and the spec files.
 */
export function bustedArgs(plan: BustedPlan): string[] {
  return [
    `--config-file=${plan.config}`,
    '--output=junit',
    '-Xoutput',
    plan.junit,
    ...(plan.coverage === undefined
      ? []
      : ['--coverage', `--coverage-config-file=${plan.coverage}`]),
    '--',
    ...plan.specs,
  ];
}

function escapeAttribute(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&#39;')
    .replaceAll('"', '&quot;');
}

/**
 * busted names a test's class after its file, as `dir.file_spec_lua:line` (the file name's dots
 * made underscores), which can't be read back alone; matched against the files it ran, it can.
 */
export function specOf(classname: string, specs: readonly string[]): string | undefined {
  const name = classname.replace(/:\d+$/, '');
  return specs.find((spec) => {
    const slash = spec.lastIndexOf('/');
    const base = spec.slice(slash + 1).replaceAll('.', '_');
    return (slash < 0 ? base : `${spec.slice(0, slash)}.${base}`) === name;
  });
}

/** busted's JUnit with each test's file (relative to the component) as a `file` attribute. */
export function withFiles(xml: string, specs: readonly string[]): string {
  return xml.replaceAll(/<testcase\b[^>]*>/g, (tag) => {
    const classname = /\bclassname=(['"])(.*?)\1/.exec(tag)?.[2];
    const spec = classname === undefined ? undefined : specOf(classname, specs);
    if (spec === undefined || /\bfile=/.test(tag)) return tag;
    const end = tag.endsWith('/>') ? tag.length - 2 : tag.length - 1;
    return `${tag.slice(0, end)} file='${escapeAttribute(spec)}'${tag.slice(end)}`;
  });
}

/** luacov's settings: statistics into the scratch directory, no report of its own. */
export function luacovConfig(stats: string): string {
  return `return { statsfile = ${JSON.stringify(stats)}, runreport = false, deletestats = false }\n`;
}

type Batch = { readonly junit: string; readonly output: string; readonly code: number };

async function runBatch(ctx: Bound, plan: BustedPlan): Promise<Batch> {
  const result = await runTree(ctx, 'busted', bustedArgs(plan), { timeoutMs: TWO_HOURS });
  if (!(await fileExists(plan.junit))) throw failed('busted, which wrote no JUnit report,', result);
  await writeFile(plan.junit, withFiles(await readFile(plan.junit, 'utf8'), plan.specs));
  const output = `${result.stdout}${result.stderr}`.trim().split('\n').slice(-40).join('\n');
  return { junit: plan.junit, output, code: result.code };
}

/** One busted run per batch of specs, one after another, all into one luacov statistics file. */
async function runBatches(
  ctx: Bound,
  dir: string,
  specs: readonly string[],
  coverage: string | undefined,
): Promise<Batch[]> {
  const config = join(dir, 'busted.lua');
  await writeFile(config, 'return {}\n');
  const done: Batch[] = [];
  for (const [index, group] of chunks(specs).entries()) {
    const junit = join(dir, `junit-${index}.xml`);
    const plan = { config, junit, specs: group, ...(coverage === undefined ? {} : { coverage }) };
    done.push(await runBatch(ctx, plan));
  }
  return done;
}

async function lcov(ctx: Bound, dir: string, stats: string): Promise<string> {
  const list = join(dir, 'sources.txt');
  const out = join(dir, 'coverage.lcov');
  await writeFile(list, `${sourceFiles(luaFiles(ctx)).join('\n')}\n`);
  await runScript(ctx, LCOV_SCRIPT, [stats, out, list]);
  return out;
}

async function run(context: CheckContext, request: TestRequest): Promise<RawTestRun> {
  const ctx = bind(context);
  const dir = await mkdtemp(join(ctx.scratch, 'busted-'));
  const specs = selectSpecs(request, {
    root: ctx.component.root,
    specs: specFiles(luaFiles(ctx)),
    full: ctx.config.tests.full,
  });
  const stats = join(dir, 'luacov.stats.out');
  const coverage = request.coverage ? join(dir, 'luacov.lua') : undefined;
  if (coverage !== undefined) await writeFile(coverage, luacovConfig(stats));
  const batches = await runBatches(ctx, dir, specs, coverage);
  const base = componentDir(ctx);
  return {
    exitCode: batches.find((b) => b.code !== 0)?.code ?? 0,
    output: batches.map((b) => b.output).join('\n'),
    junit: batches.map((b) => ({ path: b.junit, base })),
    ...(coverage === undefined
      ? {}
      : { coverage: { path: await lcov(ctx, dir, stats), base, format: 'lcov' } }),
  };
}

/**
 * busted for the shared test checks, under luacov when coverage is asked for. Coverage comes
 * back as LCOV: luacov's statistics hold hit counts only, so Talos's script asks luacov which
 * lines can run and writes every source, loaded by a test or not.
 */
export const bustedRunner: TestRunner = { run };

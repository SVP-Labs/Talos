import { cp, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parse as parseToml, stringify } from 'smol-toml';
import { z } from 'zod';
import {
  type MutmutMutant,
  type MutmutReport,
  MUTMUT_REPORT,
  mutmutStatus,
} from './mutmut-report.js';
import { componentDir, inComponent } from './paths.js';
import { type Bound, bind, failed, runTool } from './run.js';
import { type FileSpans, readSpans } from './spans.js';
import type { CheckContext } from '../../core/check.js';
import { EngineError } from '../../core/check.js';
import type { MutationRunner, Report } from '../../quality/protocol.js';

/** mutmut's module name for a component-relative file: dotted, without `src.` or `__init__`. */
export function mutmutModule(file: string): string {
  const dotted = file
    .replace(/\.py$/, '')
    .replaceAll('/', '.')
    .replace(/^src\./, '');
  return dotted.replace(/(^|\.)__init__$/, '');
}

/** The function a mutant changes: its module, its class (`''` at module level) and its name. */
export function mutantTarget(
  name: string,
): { module: string; owner: string; fn: string } | undefined {
  const mangled = name.split('__mutmut_')[0] ?? '';
  const dot = mangled.lastIndexOf('.');
  const module = mangled.slice(0, Math.max(0, dot));
  const last = mangled.slice(dot + 1);
  const parts = last.split('ǁ');
  if (parts.length === 3 && parts[0] === 'x') {
    return { module, owner: parts[1] ?? '', fn: parts[2] ?? '' };
  }
  return last.startsWith('x_') ? { module, owner: '', fn: last.slice(2) } : undefined;
}

/** `mutmut results --all true`: one `name: status` line per mutant. */
export function parseMutmutResults(text: string): { name: string; status: string }[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const match = /^\s+(\S+__mutmut_\d+): (.+)$/.exec(line);
    return match?.[1] === undefined || match[2] === undefined
      ? []
      : [{ name: match[1], status: match[2].trim() }];
  });
}

/**
 * Where mutmut's text of a function starts: its first decorator, or the comments directly above
 * it, which mutmut keeps with the function.
 */
export function functionTextStart(lines: readonly string[], start: number): number {
  let first = start;
  for (let line = start - 1; line >= 1; line -= 1) {
    const text = (lines[line - 1] ?? '').trim();
    if (text.startsWith('#')) first = line;
    else if (text !== '') break;
  }
  return first;
}

const SKIPPED = new Set(['.venv', '.git', 'mutants', 'node_modules', '__pycache__', '.talos']);

type Target = { readonly file: string; readonly spans?: FileSpans; readonly lines: string[] };

function functionLine(target: Target | undefined, name: string): number {
  const fn = mutantTarget(name);
  if (fn === undefined) return 0;
  const span = target?.spans?.functions.find((f) => f.owner === fn.owner && f.name === fn.fn);
  return span === undefined || target === undefined
    ? 0
    : functionTextStart(target.lines, span.start);
}

async function mutants(
  ctx: Bound,
  work: string,
  targets: ReadonlyMap<string, Target>,
): Promise<MutmutMutant[]> {
  const listed = await runTool(ctx, 'mutmut', ['results', '--all', 'true'], { cwd: work });
  if (listed.code !== 0) throw failed('mutmut results', listed);
  const found: MutmutMutant[] = [];
  for (const { name, status } of parseMutmutResults(listed.stdout)) {
    const target = targets.get(mutantTarget(name)?.module ?? '');
    if (target === undefined) continue;
    const shown =
      mutmutStatus(status) === 'killed'
        ? undefined
        : await runTool(ctx, 'mutmut', ['show', name], { cwd: work });
    const diff = shown?.stdout.split('\n').slice(1).join('\n') ?? '';
    found.push({ name, file: target.file, status, functionLine: functionLine(target, name), diff });
  }
  return found;
}

async function readTargets(ctx: Bound, files: readonly string[]): Promise<Map<string, Target>> {
  const spans = await readSpans(ctx, files);
  const dir = componentDir(ctx);
  const entries = await Promise.all(
    files.map(async (file): Promise<[string, Target]> => {
      const lines = (await readFile(join(dir, file), 'utf8')).split(/\r?\n/);
      const found = spans.get(file);
      return [mutmutModule(file), { file, lines, ...(found ? { spans: found } : {}) }];
    }),
  );
  return new Map(entries);
}

/** What mutmut should mutate when the project doesn't say: `src`, or each file's top directory. */
export function sourcePaths(files: readonly string[]): string[] {
  return [
    ...new Set(files.map((file) => (file.includes('/') ? (file.split('/')[0] ?? file) : file))),
  ];
}

const table = z.record(z.string(), z.unknown());

/**
 * The copy's pyproject.toml with `[tool.mutmut] source_paths` set, since mutmut otherwise guesses
 * from the directory's name, which in the copy means nothing. Undefined when the project
 * configures mutmut itself or its pyproject.toml can't be read.
 */
export function withSourcePaths(
  pyproject: string | undefined,
  paths: readonly string[],
): string | undefined {
  try {
    const parsed = pyproject === undefined ? {} : parseToml(pyproject);
    const tool = table.safeParse(parsed.tool ?? {});
    if (!tool.success || 'mutmut' in tool.data) return undefined;
    return stringify({ ...parsed, tool: { ...tool.data, mutmut: { source_paths: [...paths] } } });
  } catch {
    return undefined;
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function configure(work: string, targets: ReadonlyMap<string, Target>): Promise<void> {
  if ((await readOptional(join(work, 'setup.cfg')))?.includes('[mutmut]') === true) return;
  const path = join(work, 'pyproject.toml');
  const files = [...targets.values()].map((target) => target.file);
  const patched = withSourcePaths(await readOptional(path), sourcePaths(files));
  if (patched !== undefined) await writeFile(path, patched);
}

async function mutate(ctx: Bound, targets: ReadonlyMap<string, Target>): Promise<MutmutMutant[]> {
  const patterns = [...targets.keys()].flatMap((module) => [`${module}.x_*`, `${module}.xǁ*`]);
  if (patterns.length === 0) return [];
  const work = join(ctx.scratch, 'work');
  const filter = (path: string): boolean => !SKIPPED.has(basename(path));
  await cp(componentDir(ctx), work, { recursive: true, filter });
  await configure(work, targets);
  const timeoutMs = 3 * 60 * 60 * 1000;
  const result = await runTool(ctx, 'mutmut', ['run', ...patterns], { cwd: work, timeoutMs });
  if (`${result.stdout}${result.stderr}`.includes('nothing matches')) return [];
  if (result.code !== 0) throw failed('mutmut run', result);
  return mutants(ctx, work, targets);
}

/**
 * mutmut on the requested files, in a copy of the component so its `mutants/` directory never
 * meets a concurrent test run. mutmut forks its workers, so it runs on Linux and macOS only.
 */
async function run(
  context: CheckContext,
  files: readonly string[],
): Promise<Report & { format: 'mutmut' }> {
  const ctx = bind(context);
  if (ctx.os === 'windows') throw new EngineError('mutmut runs on Linux and macOS only');
  const own = files.flatMap((file) => inComponent(ctx.component.root, file) ?? []);
  const targets = await readTargets(
    ctx,
    own.filter((file) => file.endsWith('.py')),
  );
  const report: MutmutReport = { format: MUTMUT_REPORT, mutants: await mutate(ctx, targets) };
  const out = join(ctx.scratch, 'mutmut-report.json');
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  return { path: out, base: componentDir(ctx), format: 'mutmut' };
}

export const mutmutRunner: MutationRunner = { run };

import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type CheckContext, EngineError } from '../../../core/check.js';
import type { MutationRunner, Report } from '../../../quality/index.js';
import { STRYKER_BASE } from '../configs/stryker.js';
import { inComponent, rootOf } from '../files.js';
import { withoutGenerated } from '../generated.js';
import { componentDir, exists, nodeTool, runTool, tail } from '../node.js';

/** One glob for the files, as `mutate` takes them: a brace list with a single entry is literal. */
function anyOf(files: readonly string[]): string {
  return files.length === 1 ? (files[0] ?? '') : `{${files.join(',')}}`;
}

export type WrapperOptions = {
  /**
   * A tsconfig file that doesn't exist, set when the component's tsconfig chain stays inside it:
   * Stryker then has nothing to rewrite there, and leaves the files as they are.
   */
  readonly noTsconfig?: string;
};

/**
 * A config in scratch that takes the component's rendered base and narrows it to the given
 * files, with only the JSON report, written into scratch. Stryker by default prefixes every
 * JavaScript and TypeScript file of its sandbox with `// @ts-nocheck`, and writes the tsconfig
 * chain back reformatted, which fails any test that reads one of those files, a rendered config
 * for one; only the mutated files need the prefix.
 */
export function strykerWrapper(
  base: string,
  files: readonly string[],
  report: string,
  options: WrapperOptions = {},
): string {
  const tsconfig =
    options.noTsconfig === undefined
      ? []
      : [`  tsconfigFile: base.tsconfigFile ?? ${JSON.stringify(options.noTsconfig)},`];
  return [
    `import base from ${JSON.stringify(base)};`,
    '',
    'export default {',
    '  ...base,',
    `  mutate: ${JSON.stringify(files)},`,
    `  disableTypeChecks: base.disableTypeChecks === false ? false : ${JSON.stringify(anyOf(files))},`,
    ...tsconfig,
    "  reporters: ['json'],",
    `  jsonReporter: { fileName: ${JSON.stringify(report)} },`,
    '  incremental: false,',
    '};',
    '',
  ].join('\n');
}

const STRING = /"(?:[^"\\\n]|\\.)*"/g;

/** The string literals of a JSON or JSONC text, comments' included. */
function strings(text: string): string[] {
  return [...text.matchAll(STRING)].flatMap((match) => {
    try {
      const value: unknown = JSON.parse(match[0]);
      return typeof value === 'string' ? [value] : [];
    } catch {
      return [];
    }
  });
}

/** A path up and out, or an absolute one; `//`, the key generated JSON files carry, is neither. */
function leaves(path: string): boolean {
  return /^(?:\/(?!\/)|[A-Za-z]:[\\/])/.test(path) || path.split(/[\\/]/).includes('..');
}

/**
 * Whether Stryker must rewrite the component's tsconfig chain because some path in it points
 * outside the component, which its sandbox doesn't hold. Read as text, every string counts and
 * every relative one is followed as a further tsconfig, so a doubt leaves Stryker's rewrite on.
 */
export async function tsconfigLeaves(dir: string): Promise<boolean> {
  const pending = ['tsconfig.json'];
  const seen = new Set<string>();
  let file = pending.pop();
  while (file !== undefined) {
    const text = seen.has(file) ? undefined : await readFile(join(dir, file), 'utf8').catch(noFile);
    seen.add(file);
    const values = strings(text ?? '');
    if (values.some(leaves)) return true;
    pending.push(...values.flatMap(tsconfigsAt(file)));
    file = pending.pop();
  }
  return false;
}

function noFile(): undefined {
  return undefined;
}

/** The files a relative path in `file` may name: a tsconfig, or a directory holding one. */
function tsconfigsAt(file: string): (value: string) => string[] {
  return (value) => {
    if (!value.startsWith('./')) return [];
    const next = posix.join(posix.dirname(file), value);
    return [next.endsWith('.json') ? next : `${next}.json`, posix.join(next, 'tsconfig.json')];
  };
}

/** Stryker's report format with no file in it, for a run with nothing to mutate. */
const EMPTY_REPORT = '{"schemaVersion":"1.0","thresholds":{"high":80,"low":60},"files":{}}\n';

/**
 * The component's files among those given (repository-relative), relative to its root. A file the
 * change deleted has nothing left to mutate, and a file Talos renders is left out: the project's
 * tests compare it with what Talos renders, so the copy Stryker instruments fails them all.
 */
export async function strykerTargets(
  repoRoot: string,
  root: string,
  dir: string,
  files: readonly string[],
): Promise<string[]> {
  const here = files.filter((file) => root === '.' || file.startsWith(`${root}/`));
  const present = await Promise.all(here.map((file) => exists(join(repoRoot, file))));
  const mine = here.filter((_, index) => present[index]).map((file) => inComponent(root, file));
  return withoutGenerated(dir, mine);
}

/** Stryker through Vitest, on {@link strykerTargets}. */
export const strykerRunner: MutationRunner = {
  async run(ctx: CheckContext, files: readonly string[]): Promise<Report & { format: 'stryker' }> {
    const dir = componentDir(ctx);
    const mine = await strykerTargets(ctx.root, rootOf(ctx.component), dir, files);
    const report = join(ctx.scratch, 'mutation.json');
    if (mine.length === 0) {
      await writeFile(report, EMPTY_REPORT);
      return { path: report, base: dir, format: 'stryker' };
    }
    const config = join(ctx.scratch, 'stryker.talos.mjs');
    const base = pathToFileURL(join(dir, STRYKER_BASE)).href;
    const options = (await tsconfigLeaves(dir))
      ? {}
      : { noTsconfig: join(ctx.scratch, 'no-tsconfig.json') };
    await rm(report, { force: true });
    await writeFile(config, strykerWrapper(base, mine, report, options));
    const tool = await nodeTool(ctx, '@stryker-mutator/core', 'stryker');
    const result = await runTool(ctx, tool, ['run', config, '--logLevel', 'warn'], {
      timeoutMs: 3 * 60 * 60 * 1000,
    });
    if (!(await exists(report))) {
      throw new EngineError(`stryker exited ${result.code} without a report:\n${tail(result)}`);
    }
    return { path: report, base: dir, format: 'stryker' };
  },
};

import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { type CheckContext, EngineError } from '../../../core/check.js';
import type { MutationRunner, Report } from '../../../quality/index.js';
import { GENERATED_PATHS } from '../configs/index.js';
import { STRYKER_BASE } from '../configs/stryker.js';
import { inComponent, rootOf } from '../files.js';
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

/**
 * Whether a path, read from the directory `from` (relative to the component's root), points
 * outside the component: up and out of it, or absolute. `//`, the key generated JSON files
 * carry, is neither.
 */
function leavesFrom(from: string): (path: string) => boolean {
  return (path) => {
    if (/^(?:\/(?!\/)|[A-Za-z]:[\\/])/.test(path)) return true;
    const resolved = posix.join(from, path.replaceAll('\\', '/'));
    return resolved === '..' || resolved.startsWith('../');
  };
}

/** JSONC without its comments; strings are kept whole, whatever they hold. */
function withoutComments(text: string): string {
  return text.replaceAll(
    /("(?:[^"\\\n]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (_, kept?: string) => kept ?? ' ',
  );
}

/** JSON without the trailing commas JSONC allows; strings are kept whole. */
function withoutTrailingCommas(text: string): string {
  return text.replaceAll(/("(?:[^"\\\n]|\\.)*")|,(?=\s*[}\]])/g, (_, kept?: string) => kept ?? '');
}

/** What of a tsconfig names further tsconfigs; anything else in it is free. */
const tsconfigLinks = z.looseObject({
  extends: z.union([z.string(), z.array(z.string())]).optional(),
  references: z.array(z.looseObject({ path: z.string() })).optional(),
});

type TsconfigLinks = z.infer<typeof tsconfigLinks>;

/** A tsconfig's links, or undefined when it isn't JSONC of a shape Talos can read. */
function parseTsconfig(text: string): TsconfigLinks | undefined {
  let value: unknown;
  try {
    value = JSON.parse(withoutTrailingCommas(withoutComments(text)));
  } catch {
    return undefined;
  }
  const parsed = tsconfigLinks.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The tsconfigs a tsconfig at `file` extends or references, by their path from the component's
 * root. An `extends` that starts with `.` is a path, a bare one a package, as TypeScript reads
 * them, and `./base` may name `./base.json`; a reference's path is always relative, and one that
 * doesn't end in `.json` names the `tsconfig.json` in that directory.
 */
function linked(file: string, config: TsconfigLinks): string[] {
  const from = posix.dirname(file);
  const extended = config.extends ?? [];
  const bases = (typeof extended === 'string' ? [extended] : extended).filter((base) =>
    base.startsWith('.'),
  );
  return [
    ...bases.flatMap((base) => {
      const path = posix.join(from, base);
      return path.endsWith('.json') ? [path] : [path, `${path}.json`];
    }),
    ...(config.references ?? []).map(({ path: reference }) => {
      const path = posix.join(from, reference);
      return path.endsWith('.json') ? path : posix.join(path, 'tsconfig.json');
    }),
  ];
}

/**
 * Whether Stryker must rewrite the component's tsconfig chain because some path in it points
 * outside the component, which its sandbox doesn't hold. Every string in each file counts as a
 * path from that file's directory, and every tsconfig it extends or references is read in turn;
 * a tsconfig Talos can't read leaves Stryker's rewrite on.
 */
export async function tsconfigLeaves(dir: string): Promise<boolean> {
  const pending = ['tsconfig.json'];
  const seen = new Set<string>();
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    if (leavesFrom('.')(file)) return true;
    const text = await readFile(join(dir, file), 'utf8').catch(noFile);
    if (text === undefined) continue;
    const config = parseTsconfig(text);
    if (config === undefined || strings(text).some(leavesFrom(posix.dirname(file)))) return true;
    pending.push(...linked(file, config));
  }
  return false;
}

function noFile(): undefined {
  return undefined;
}

/** Stryker's report format with no file in it, for a run with nothing to mutate. */
const EMPTY_REPORT = '{"schemaVersion":"1.0","thresholds":{"high":80,"low":60},"files":{}}\n';

/**
 * The component's files among those given (repository-relative), relative to its root. A file the
 * change deleted has nothing left to mutate, and a file this pack renders is left out by its path:
 * the project's tests may compare it with what Talos renders, which the copy Stryker instruments
 * fails. No other pack renders a JavaScript or TypeScript file.
 */
export async function strykerTargets(
  repoRoot: string,
  root: string,
  files: readonly string[],
): Promise<string[]> {
  const here = files.filter((file) => root === '.' || file.startsWith(`${root}/`));
  const present = await Promise.all(here.map((file) => exists(join(repoRoot, file))));
  const mine = here.filter((_, index) => present[index]).map((file) => inComponent(root, file));
  return mine.filter((file) => !GENERATED_PATHS.includes(file));
}

/** Stryker through Vitest, on {@link strykerTargets}. */
export const strykerRunner: MutationRunner = {
  async run(ctx: CheckContext, files: readonly string[]): Promise<Report & { format: 'stryker' }> {
    const dir = componentDir(ctx);
    const mine = await strykerTargets(ctx.root, rootOf(ctx.component), files);
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

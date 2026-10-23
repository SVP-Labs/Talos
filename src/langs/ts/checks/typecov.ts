import { join, posix, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { TalosConfig } from '../../../config/schema.js';
import { type Check, type CheckContext, EngineError, skip, APPLIES } from '../../../core/check.js';
import type { Finding, Policy } from '../../../core/finding.js';
import { reachesTypeFloor } from '../../../quality/index.js';
import { excludeGlobs } from '../configs/shared.js';
import { excludedHere, inComponent, rootOf, TEST_GLOBS, tsconfigs } from '../files.js';
import { nodeTool, parseJson, runTool, tail } from '../node.js';

const report = z.object({
  correctCount: z.number(),
  totalCount: z.number(),
  details: z
    .array(
      z.object({
        filePath: z.string(),
        line: z.number(),
        character: z.number(),
        text: z.string(),
      }),
    )
    .default([]),
});

export type TypeCoverage = z.infer<typeof report>;

export function atFloor(coverage: Pick<TypeCoverage, 'correctCount' | 'totalCount'>): boolean {
  return reachesTypeFloor(coverage.correctCount, coverage.totalCount);
}

/**
 * Each untyped identifier (`any`, an `as` cast, a `!`) in a file the run judges: a `standard`
 * finding while the package is under the floor, so no new one lands; `info` once it is at or
 * above it.
 */
export function typecovFindings(
  coverage: TypeCoverage,
  toRepo: (file: string) => string,
  judged: ReadonlySet<string>,
): Finding[] {
  const policy: Policy = atFloor(coverage) ? 'info' : 'standard';
  return coverage.details.flatMap((detail): Finding[] => {
    const file = toRepo(detail.filePath);
    if (!judged.has(file)) return [];
    return [
      {
        rule: 'typecov/untyped',
        message: `${detail.text} is not precisely typed (any, an as cast, or a non-null assertion).`,
        location: { file, line: detail.line + 1, column: detail.character + 1 },
        ...(policy === 'standard' ? {} : { policy }),
      },
    ];
  });
}

export function parseTypeCoverage(json: unknown): TypeCoverage {
  const parsed = report.safeParse(json);
  if (!parsed.success) throw new EngineError('type-coverage wrote JSON Talos cannot read');
  return parsed.data;
}

/** Every option a package.json `typeCoverage` entry could use to count less is switched back. */
const STRICT_FLAGS = [
  '--strict',
  '--detail',
  '--json-output',
  '--no-ignore-catch',
  '--no-ignore-unread',
  '--no-ignore-nested',
  '--no-ignore-as-assertion',
  '--no-ignore-type-assertion',
  '--no-ignore-non-null-assertion',
  '--no-ignore-object',
  '--no-ignore-empty-type',
  '--no-at-least',
  '--no-is',
  '--no-update',
  '--no-update-if-higher',
  '--no-cache',
  '--no-history-file',
];

/**
 * What type-coverage leaves out besides test code, as globs relative to a tsconfig's directory
 * (`dir`, repository-relative, in the component at `root`): `tests.full`, and `talos.yml`'s
 * exclude, which no check judges.
 */
export function typecovIgnored(
  config: Pick<TalosConfig, 'exclude' | 'tests'>,
  root: string,
  dir: string,
): string[] {
  const here = (paths: readonly string[]): string[] =>
    excludedHere(paths, root).flatMap((path) => {
      const relative = posix.relative(inComponent(root, dir), path);
      return relative === '' || relative.startsWith('..') ? [] : [relative];
    });
  return [
    ...here(config.tests.full).map((path) => `${path}/**`),
    ...here(config.exclude).flatMap((entry) => excludeGlobs(entry)),
  ];
}

/** Test code is free to assert; `ignored` globs are relative to the tsconfig's directory. */
export function typecovArgs(ignored: readonly string[]): string[] {
  return [
    '-p',
    'tsconfig.json',
    ...STRICT_FLAGS,
    ...[...TEST_GLOBS, ...ignored].flatMap((glob) => ['--ignore-files', glob]),
  ];
}

async function run(ctx: CheckContext): Promise<Finding[]> {
  const tool = await nodeTool(ctx, 'type-coverage', 'type-coverage');
  const root = rootOf(ctx.component);
  const findings: Finding[] = [];
  const judged = new Set(ctx.facts.files);
  for (const tsconfig of tsconfigs(ctx)) {
    const dir = posix.dirname(tsconfig);
    const cwd = join(ctx.root, dir);
    const args = typecovArgs(typecovIgnored(ctx.config, root, dir));
    const result = await runTool(ctx, tool, args, { cwd });
    if (!result.stdout.trimStart().startsWith('{')) {
      throw new EngineError(`type-coverage -p ${tsconfig} exited ${result.code}:\n${tail(result)}`);
    }
    const toRepo = (file: string): string =>
      relative(ctx.root, resolve(cwd, file)).split(sep).join('/');
    findings.push(
      ...typecovFindings(
        parseTypeCoverage(parseJson('type-coverage', result.stdout)),
        toRepo,
        judged,
      ),
    );
  }
  return findings;
}

export const typecovCheck: Check = {
  id: 'ts/typecov',
  tier: 'head',
  scope: 'component',
  langs: ['ts'],
  title: 'Type coverage',
  applies: (ctx) => (tsconfigs(ctx).length > 0 ? APPLIES : skip('no tsconfig.json')),
  run,
};

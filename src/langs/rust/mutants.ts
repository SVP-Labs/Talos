import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workspace } from './metadata.js';
import { componentDir, fileExists, inComponent, relativeTo } from './paths.js';
import { bind, cargoTool, failed, HOUR, pathWith } from './run.js';
import type { CheckContext } from '../../core/check.js';
import { EngineError } from '../../core/check.js';
import type { MutationRunner, Report } from '../../quality/protocol.js';

/**
 * cargo-mutants' exit codes for a run that judged its mutants: all caught, some missed, some
 * timed out, or the tests failing before any mutation (then rust/tests reports them).
 */
const RAN = new Set([0, 2, 3, 4]);

/** cargo-mutants' arguments to mutate only `files` (relative to the workspace root). */
export function mutantsArgs(files: readonly string[], output: string): string[] {
  return [
    '--no-config',
    '--no-shuffle',
    '--colors',
    'never',
    '--output',
    output,
    '--test-tool',
    'nextest',
    '--test-workspace',
    'true',
    '--cap-lints',
    'true',
    '--all-features',
    '--jobs',
    '2',
    '--cargo-test-arg=--retries=0',
    '--cargo-test-arg=--no-tests=pass',
    '--cargo-test-arg=--ignore-default-filter',
    ...files.flatMap((file) => ['--file', file]),
  ];
}

/** The outcomes file of a run that had nothing to mutate. */
const EMPTY = `${JSON.stringify({ outcomes: [], total_mutants: 0 })}\n`;

/**
 * cargo-mutants on the requested files, in its own copy of the tree, with nextest running the
 * whole workspace's tests against each mutant. `.cargo/mutants.toml` is ignored: what to skip
 * isn't the project's to configure.
 */
async function run(
  context: CheckContext,
  files: readonly string[],
): Promise<Report & { format: 'cargo-mutants' }> {
  const ctx = bind(context);
  const ws = await workspace(ctx);
  const dir = componentDir(ctx);
  const own = files
    .flatMap((file) => inComponent(ctx.component.root, file) ?? [])
    .filter((file) => file.endsWith('.rs'))
    .map((file) => relativeTo(ws.root, dir, file));
  const out = join(ctx.scratch, 'mutants');
  const outcomes = join(out, 'mutants.out', 'outcomes.json');
  if (own.length === 0) {
    await mkdir(join(out, 'mutants.out'), { recursive: true });
    await writeFile(outcomes, EMPTY);
    return { path: outcomes, base: ws.root, format: 'cargo-mutants' };
  }
  const mutants = await ctx.tools.path('cargo-mutants');
  const nextest = await ctx.tools.path('cargo-nextest');
  const result = await cargoTool(
    ctx,
    { path: mutants, subcommand: 'mutants' },
    mutantsArgs(own, out),
    {
      env: pathWith(process.env, [nextest]),
      timeoutMs: 3 * HOUR,
    },
  );
  if (!RAN.has(result.code)) throw failed('cargo mutants', result);
  if (!(await fileExists(outcomes))) {
    throw new EngineError(`cargo-mutants wrote no outcomes.json (exit ${String(result.code)})`);
  }
  return { path: outcomes, base: ws.root, format: 'cargo-mutants' };
}

export const mutantsRunner: MutationRunner = { run };

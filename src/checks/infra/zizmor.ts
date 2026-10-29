import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { parseJson, sentence, toolFailed } from './report.js';
import { EngineError } from '../../core/check.js';
import type { CheckContext } from '../../core/check.js';
import type { Finding, Location } from '../../core/finding.js';

/**
 * zizmor's settings for the gate, which replace any `zizmor.yml` in the repository. Dependabot
 * waits one day before proposing a release, the minimum age for any dependency across
 * SVP-Labs, where zizmor's default asks for seven.
 */
export const ZIZMOR_CONFIG = [
  'rules:',
  '  dependabot-cooldown:',
  '    config:',
  '      days: 1',
  '',
].join('\n');

/**
 * Pedantic, offline (the online audits need a GitHub token, which a job running repository
 * code never holds), and exiting 0 whatever it finds, so any other exit is a failure.
 */
function zizmorArgs(config: string): string[] {
  return [
    '--persona',
    'pedantic',
    '--format',
    'json',
    '--offline',
    '--config',
    config,
    '--no-progress',
    '--no-exit-codes',
    '--color',
    'never',
  ];
}

const point = z.object({ row: z.number().int(), column: z.number().int() });

/** A step of a route: a mapping's key or a sequence's index. */
const routePart = z.union([
  z.object({ Key: z.string() }).transform((part) => part.Key),
  z.object({ Index: z.number().int() }).transform((part) => part.Index),
  z.unknown().transform(() => undefined),
]);

const location = z.object({
  symbolic: z.object({
    key: z.object({ Local: z.object({ verbatim_path: z.string() }).optional() }),
    annotation: z.string(),
    kind: z.string(),
    route: z.object({ route: z.array(routePart) }).optional(),
  }),
  concrete: z.object({ location: z.object({ start_point: point, end_point: point }) }),
});

const result = z.object({
  ident: z.string(),
  desc: z.string(),
  url: z.string(),
  locations: z.array(location),
  ignored: z.boolean().default(false),
});

type ZizmorLocation = z.infer<typeof location>;

/** Rows are 0-based and the end is exclusive: a span ending at column 0 ends on the row before. */
function toLocation(at: ZizmorLocation): Location | undefined {
  const file = at.symbolic.key.Local?.verbatim_path;
  if (file === undefined) return undefined;
  const { start_point: start, end_point: end } = at.concrete.location;
  const line = start.row + 1;
  const last = end.column === 0 && end.row > start.row ? end.row : end.row + 1;
  return { file, line, column: start.column + 1, ...(last > line ? { endLine: last } : {}) };
}

function toFinding(r: z.infer<typeof result>): Finding {
  const primary = r.locations.find((l) => l.symbolic.kind === 'Primary') ?? r.locations[0];
  const where = primary === undefined ? undefined : toLocation(primary);
  const detail = primary === undefined ? '' : `: ${primary.symbolic.annotation}`;
  return {
    rule: `zizmor/${r.ident}`,
    message: sentence(`${r.desc}${detail}`),
    ...(where === undefined ? { key: r.ident } : { location: where }),
    docs: r.url,
  };
}

/** The step of a workflow job a finding is in: the job's id and the step's index. */
export type StepAt = { readonly job: string; readonly index: number };

/** A zizmor finding, and the step it is in when it is in one. */
export type ZizmorResult = { readonly finding: Finding; readonly step?: StepAt };

/** `jobs.<id>.steps[<n>]` at the start of a route: the step it reaches. */
function stepOf(at: ZizmorLocation | undefined): StepAt | undefined {
  const [jobs, job, steps, index] = at?.symbolic.route?.route ?? [];
  if (jobs !== 'jobs' || typeof job !== 'string' || steps !== 'steps') return undefined;
  return typeof index === 'number' ? { job, index } : undefined;
}

function toResult(r: z.infer<typeof result>): ZizmorResult {
  const primary = r.locations.find((l) => l.symbolic.kind === 'Primary') ?? r.locations[0];
  const step = stepOf(primary);
  return { finding: toFinding(r), ...(step === undefined ? {} : { step }) };
}

/** zizmor's JSON output, each finding with its step; ignored findings are left out. */
export function parseZizmorResults(stdout: string): ZizmorResult[] {
  const parsed = z.array(result).safeParse(parseJson(stdout, 'zizmor'));
  if (!parsed.success) throw new EngineError('zizmor printed JSON Talos cannot read');
  return parsed.data.filter((r) => !r.ignored).map(toResult);
}

/** zizmor's JSON output as findings; findings an ignore comment covers are left out. */
export function parseZizmor(stdout: string): Finding[] {
  return parseZizmorResults(stdout).map((r) => r.finding);
}

/** zizmor over the workflows, the action definitions and Dependabot's config. */
export async function zizmor(
  ctx: CheckContext,
  inputs: readonly string[],
): Promise<ZizmorResult[]> {
  if (inputs.length === 0) return [];
  const tool = await ctx.tools.path('zizmor');
  const config = join(ctx.scratch, 'zizmor.yml');
  await writeFile(config, ZIZMOR_CONFIG);
  const run = await ctx.exec(tool, [...zizmorArgs(config), '--', ...inputs], { cwd: ctx.root });
  if (run.code !== 0) throw toolFailed('zizmor', run);
  return parseZizmorResults(run.stdout);
}

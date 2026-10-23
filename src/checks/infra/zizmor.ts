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

const location = z.object({
  symbolic: z.object({
    key: z.object({ Local: z.object({ verbatim_path: z.string() }).optional() }),
    annotation: z.string(),
    kind: z.string(),
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

/** zizmor's JSON output as findings; findings an ignore comment covers are left out. */
export function parseZizmor(stdout: string): Finding[] {
  const parsed = z.array(result).safeParse(parseJson(stdout, 'zizmor'));
  if (!parsed.success) throw new EngineError('zizmor printed JSON Talos cannot read');
  return parsed.data.filter((r) => !r.ignored).map(toFinding);
}

/** zizmor over the workflows, the action definitions and Dependabot's config. */
export async function zizmor(ctx: CheckContext, inputs: readonly string[]): Promise<Finding[]> {
  if (inputs.length === 0) return [];
  const tool = await ctx.tools.path('zizmor');
  const config = join(ctx.scratch, 'zizmor.yml');
  await writeFile(config, ZIZMOR_CONFIG);
  const run = await ctx.exec(tool, [...zizmorArgs(config), '--', ...inputs], { cwd: ctx.root });
  if (run.code !== 0) throw toolFailed('zizmor', run);
  return parseZizmor(run.stdout);
}

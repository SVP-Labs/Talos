import { z } from 'zod';
import { jsonFrom } from './run.js';
import { EngineError } from '../../core/check.js';

/** SonarSource's cognitive complexity limit, which ruff can't measure. */
export const MAX_COGNITIVE = 15;

const result = z.object({
  ruleId: z.string(),
  message: z.object({ text: z.string() }),
  locations: z
    .array(
      z.object({
        physicalLocation: z.object({
          artifactLocation: z.object({ uri: z.string() }),
          region: z.object({ startLine: z.number().int(), endLine: z.number().int().optional() }),
        }),
        logicalLocations: z.array(z.object({ name: z.string() })).optional(),
      }),
    )
    .min(1),
});

const sarif = z.object({ runs: z.array(z.object({ results: z.array(result) })) });

export type ComplexFunction = {
  readonly rule: string;
  readonly file: string;
  readonly line: number;
  readonly endLine: number;
  readonly name: string;
  readonly complexity: number;
};

/** Reads complexipy's SARIF: one result per function above the limit. */
export function parseComplexipySarif(text: string): ComplexFunction[] {
  const parsed = sarif.safeParse(jsonFrom(text, 'complexipy'));
  if (!parsed.success) throw new EngineError('complexipy printed SARIF of an unknown shape');
  return parsed.data.runs.flatMap((run) => run.results.map((r) => toFunction(r)));
}

type Place = { file: string; line: number; endLine: number; name: string };

function place(where: z.infer<typeof result>['locations'][number] | undefined): Place {
  if (where === undefined) return { file: '', line: 1, endLine: 1, name: 'function' };
  const { region, artifactLocation } = where.physicalLocation;
  return {
    file: decodeURI(artifactLocation.uri).replace(/^file:\/\//, ''),
    line: region.startLine,
    endLine: Math.max(region.startLine, region.endLine ?? region.startLine),
    name: where.logicalLocations?.[0]?.name ?? 'function',
  };
}

function toFunction(r: z.infer<typeof result>): ComplexFunction {
  const complexity = /complexity of (\d+)/.exec(r.message.text)?.[1];
  return { rule: r.ruleId, ...place(r.locations[0]), complexity: Number(complexity ?? Number.NaN) };
}

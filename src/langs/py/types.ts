import { join } from 'node:path';
import { z } from 'zod';
import { pyrightConfigFile } from './configs.js';
import { fromTool, pythonFiles, venvTool } from './paths.js';
import { sentence } from './ruff.js';
import { type Bound, failed, jsonFrom, runTool } from './run.js';
import { EngineError } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';

const position = z.object({ line: z.number().int(), character: z.number().int() });

const diagnostic = z.object({
  file: z.string(),
  severity: z.string(),
  message: z.string(),
  range: z.object({ start: position, end: position }).optional(),
  rule: z.string().optional(),
});

const output = z.object({ generalDiagnostics: z.array(diagnostic) });

export type TypeDiagnostic = {
  readonly file: string;
  readonly rule: string;
  readonly message: string;
  readonly line: number;
  readonly endLine: number;
  readonly column: number;
};

/**
 * Reads `basedpyright --outputjson`. Every error and warning counts; an information-level note
 * counts only when a rule produced it (`reveal_type` output has none).
 */
export function parseBasedpyright(text: string): TypeDiagnostic[] {
  const parsed = output.safeParse(jsonFrom(text, 'basedpyright'));
  if (!parsed.success) throw new EngineError('basedpyright printed JSON of an unknown shape');
  return parsed.data.generalDiagnostics
    .filter((d) => d.severity !== 'information' || d.rule !== undefined)
    .map((d) => {
      const line = (d.range?.start.line ?? 0) + 1;
      return {
        file: d.file,
        rule: d.rule ?? 'error',
        message: d.message,
        line,
        endLine: Math.max(line, (d.range?.end.line ?? 0) + 1),
        column: (d.range?.start.character ?? 0) + 1,
      };
    });
}

/**
 * basedpyright on every tracked Python file, with the project's config (which extends the
 * generated base) and the component's interpreter. A baseline file would hide errors, so the
 * gate points basedpyright at one that doesn't exist.
 */
export async function types(ctx: Bound): Promise<Finding[]> {
  const files = pythonFiles(ctx);
  if (files.length === 0) throw new EngineError('py/types ran on a component with no Python files');
  const args = [
    '--outputjson',
    '--project',
    await pyrightConfigFile(ctx),
    '--pythonpath',
    await venvTool(ctx, 'python'),
    '--baselinefile',
    join(ctx.scratch, 'no-baseline.json'),
  ];
  const result = await runTool(ctx, 'basedpyright', [...args, ...files]);
  if (result.code > 1) throw failed('basedpyright', result);
  return parseBasedpyright(result.stdout).map((d) => ({
    rule: `basedpyright/${d.rule}`,
    message: sentence(d.message),
    location: { file: fromTool(ctx, d.file), line: d.line, endLine: d.endLine, column: d.column },
  }));
}

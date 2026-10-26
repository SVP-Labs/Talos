import { z } from 'zod';
import { EngineError } from '../../core/check.js';

const mismatch = z.object({
  original_start_line: z.number().int().nonnegative(),
  original_end_line: z.number().int().nonnegative(),
});

const fileLine = z.object({ file: z.string(), mismatches: z.array(mismatch) });
const errorLine = z.object({ type: z.string(), message: z.string() });

/** One stretch of a file StyLua would write differently; lines are 1-based. */
export type Unformatted = {
  readonly file: string;
  readonly line: number;
  readonly endLine: number;
};

function parseLine(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    throw new EngineError(`stylua printed a line that isn't JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * `stylua --check --output-format Json` prints one JSON object per line for each file it would
 * change, with 0-based line numbers, or an error object. A file it can't parse goes to standard
 * error and is left to lua/lint, which reports the syntax error.
 */
export function parseStylua(stdout: string): Unformatted[] {
  return stdout
    .split(/\r?\n/)
    .filter((text) => text.trim() !== '')
    .flatMap((text) => {
      const value = parseLine(text);
      const failure = errorLine.safeParse(value);
      if (failure.success) throw new EngineError(`stylua: ${failure.data.message}`);
      const parsed = fileLine.safeParse(value);
      if (!parsed.success) {
        throw new EngineError(`stylua printed an unknown shape: ${text.slice(0, 200)}`);
      }
      return parsed.data.mismatches.map((m) => ({
        file: parsed.data.file,
        line: m.original_start_line + 1,
        endLine: Math.max(m.original_start_line, m.original_end_line) + 1,
      }));
    });
}

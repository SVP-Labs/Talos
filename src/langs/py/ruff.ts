import { z } from 'zod';
import { EngineError } from '../../core/check.js';

const position = z.object({ row: z.number().int(), column: z.number().int() });

const diagnostic = z.object({
  code: z.string().nullable(),
  name: z.string().nullable().optional(),
  message: z.string(),
  filename: z.string(),
  location: position.nullable(),
  end_location: position.nullable(),
  url: z.string().nullable().optional(),
});

/** One problem `ruff check` or `ruff format --check` reported, with the tool's own path. */
export type RuffDiagnostic = {
  /** The rule code; `unformatted` from the formatter; `invalid-syntax` when ruff couldn't parse. */
  readonly code: string;
  readonly message: string;
  readonly file: string;
  readonly line: number;
  readonly endLine: number;
  readonly column: number;
  readonly url?: string;
};

/** Reads ruff's `--output-format json`, which both `ruff check` and `ruff format --check` print. */
export function parseRuffJson(text: string): RuffDiagnostic[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim() === '' ? '[]' : text);
  } catch {
    throw new EngineError(`ruff printed no readable JSON: ${text.trim().slice(0, 200)}`);
  }
  const parsed = z.array(diagnostic).safeParse(raw);
  if (!parsed.success) throw new EngineError('ruff printed JSON of an unknown shape');
  return parsed.data.map((d) => {
    const line = d.location?.row ?? 1;
    return {
      code: d.code ?? d.name ?? 'invalid-syntax',
      message: d.message,
      file: d.filename,
      line: Math.max(1, line),
      endLine: Math.max(line, d.end_location?.row ?? line),
      column: d.location?.column ?? 1,
      ...(d.url ? { url: d.url } : {}),
    };
  });
}

/** The first line of a tool's message, without a trailing full stop doubled later. */
export function sentence(message: string, limit = 200): string {
  const first = message.split('\n')[0]?.trim() ?? '';
  const clipped = first.length > limit ? `${first.slice(0, limit - 1)}…` : first;
  return /[.!?]$/.test(clipped) ? clipped : `${clipped}.`;
}

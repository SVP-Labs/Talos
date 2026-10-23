import { z } from 'zod';
import { EngineError } from '../../core/check.js';

/** The value of the report's `format` field. */
export const MUTMUT_REPORT = 'talos-mutmut/1';

const mutant = z.object({
  name: z.string(),
  file: z.string(),
  status: z.string(),
  functionLine: z.number().int().min(0),
  diff: z.string(),
});

const report = z.object({ format: z.literal(MUTMUT_REPORT), mutants: z.array(mutant) });

export type MutmutMutant = z.infer<typeof mutant>;
export type MutmutReport = z.infer<typeof report>;

export type MutantStatus = 'killed' | 'survived' | 'no-coverage' | 'timeout' | 'ignored' | 'error';

export type Mutant = {
  /** Relative to the report's base directory, the component's root. */
  readonly file: string;
  readonly line: number;
  /** mutmut's name for the mutant, which `mutmut show` and `mutmut apply` take. */
  readonly mutator: string;
  readonly original: string;
  readonly replacement: string;
  readonly status: MutantStatus;
};

const STATUS: Readonly<Record<string, MutantStatus>> = {
  killed: 'killed',
  'caught by type check': 'killed',
  survived: 'survived',
  'no tests': 'no-coverage',
  timeout: 'timeout',
  suspicious: 'timeout',
  segfault: 'error',
  skipped: 'ignored',
  'not checked': 'ignored',
  'check was interrupted by user': 'ignored',
};

/** mutmut's status words as Talos's: `survived` and `no-coverage` are surviving mutants. */
export function mutmutStatus(word: string): MutantStatus {
  return STATUS[word] ?? 'error';
}

export type Change = {
  /** The changed line's number within the function's text, 1-based. */
  readonly offset: number;
  readonly original: string;
  readonly replacement: string;
};

/** The first changed line of a `mutmut show` diff, whose line numbers count from the function. */
export function firstChange(diff: string): Change | undefined {
  const lines = diff.split(/\r?\n/);
  const hunk = lines.findIndex((line) => line.startsWith('@@ '));
  const start = /^@@ -(\d+)/.exec(lines[hunk] ?? '')?.[1];
  if (hunk < 0 || start === undefined) return undefined;
  let old = Number(start);
  let original: string | undefined;
  for (const line of lines.slice(hunk + 1)) {
    if (line.startsWith('+')) {
      return { offset: old, original: original ?? '', replacement: line.slice(1).trim() };
    }
    if (line.startsWith('-')) original ??= line.slice(1).trim();
    else if (original === undefined) old += 1;
    else break;
  }
  return original === undefined ? undefined : { offset: old, original, replacement: '' };
}

function toMutant(entry: MutmutMutant): Mutant {
  const change = firstChange(entry.diff);
  const line = Math.max(1, entry.functionLine + (change?.offset ?? 1) - 1);
  return {
    file: entry.file,
    line,
    mutator: entry.name,
    original: change?.original ?? '',
    replacement: change?.replacement ?? '',
    status: mutmutStatus(entry.status),
  };
}

/**
 * Reads the report Talos's mutmut runner writes (see the pack's README): every mutant of the
 * requested files with its fate, and for each one not killed its diff, located in the file
 * through the line its function's text starts on.
 */
export function parseMutmutReport(text: string): Mutant[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new EngineError('the mutmut report is not JSON');
  }
  const parsed = report.safeParse(raw);
  if (!parsed.success) throw new EngineError(`the mutmut report is not a ${MUTMUT_REPORT} report`);
  return parsed.data.mutants.map((entry) => toMutant(entry));
}

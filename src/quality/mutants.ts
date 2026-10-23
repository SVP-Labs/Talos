import { createHash } from 'node:crypto';
import { z } from 'zod';
import { clip } from './text.js';
import { EngineError } from '../core/check.js';
import type { Finding } from '../core/finding.js';
import { normalise } from '../core/fingerprint.js';
import { parseMutmutReport } from '../langs/py/mutmut-report.js';

type MutantStatus = 'survived' | 'no-coverage' | 'other';

/** A mutant as a mutation tool reports it, in the shared shape. */
export type Mutant = {
  /** As the report names it: relative to the report's base, or absolute. */
  readonly file: string;
  readonly line: number;
  readonly endLine?: number;
  /** The kind of mutation; part of the mutant's identity. */
  readonly mutator: string;
  /** How the message names the mutant, when not by its mutator (mutmut's mutant name). */
  readonly label?: string;
  readonly original: string;
  readonly replacement: string;
  readonly status: MutantStatus;
};

type Position = { readonly line: number; readonly column: number };

/** The text between two 1-based positions, the end exclusive (Stryker's and cargo-mutants'). */
export function sliceSpan(source: string, start: Position, end: Position): string {
  const lines = source.split(/\r?\n/);
  const line = (number: number): string => lines[number - 1] ?? '';
  if (start.line === end.line) return line(start.line).slice(start.column - 1, end.column - 1);
  return [
    line(start.line).slice(start.column - 1),
    ...lines.slice(start.line, end.line - 1),
    line(end.line).slice(0, end.column - 1),
  ].join('\n');
}

function json(text: string, tool: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new EngineError(`the ${tool} report is not JSON`);
  }
}

const position = z.object({ line: z.number().int(), column: z.number().int() });
const span = z.object({ start: position, end: position });

const strykerReport = z.looseObject({
  schemaVersion: z.string(),
  files: z.record(
    z.string(),
    z.looseObject({
      source: z.string(),
      mutants: z.array(
        z.looseObject({
          mutatorName: z.string(),
          replacement: z.string().optional(),
          status: z.string(),
          location: span,
        }),
      ),
    }),
  ),
});

const STRYKER_STATUS: Readonly<Record<string, MutantStatus>> = {
  Survived: 'survived',
  NoCoverage: 'no-coverage',
};

/** Stryker's JSON report (the mutation-testing-report-schema): files keyed by path. */
export function parseStryker(text: string): Mutant[] {
  const parsed = strykerReport.safeParse(json(text, 'Stryker'));
  if (!parsed.success) throw new EngineError('the Stryker report is not a mutation-testing report');
  return Object.entries(parsed.data.files).flatMap(([file, result]) =>
    result.mutants.map((mutant): Mutant => ({
      file,
      line: mutant.location.start.line,
      endLine: mutant.location.end.line,
      mutator: mutant.mutatorName,
      original: sliceSpan(result.source, mutant.location.start, mutant.location.end),
      replacement: mutant.replacement ?? '',
      status: STRYKER_STATUS[mutant.status] ?? 'other',
    })),
  );
}

const infectionEntry = z.looseObject({
  mutator: z.looseObject({
    mutatorName: z.string(),
    originalFilePath: z.string(),
    originalStartLine: z.number().int(),
    originalEndLine: z.number().int().optional(),
  }),
  diff: z.string(),
});

const infectionLog = z.looseObject({
  stats: z.looseObject({}),
  escaped: z.array(infectionEntry).default([]),
  uncovered: z.array(infectionEntry).default([]),
});

/** The removed and added lines of Infection's diff, after its `@@ @@` header. */
export function diffSides(diff: string): { original: string; replacement: string } {
  const lines = diff.split(/\r?\n/);
  const body = lines.slice(lines.findIndex((line) => line.startsWith('@@')) + 1);
  const side = (sign: string): string =>
    body
      .filter((line) => line.startsWith(sign))
      .map((line) => line.slice(1).trim())
      .join('\n');
  return { original: side('-'), replacement: side('+') };
}

/** Infection's JSON log: its `escaped` mutants survived, its `uncovered` ones no test ran. */
export function parseInfection(text: string): Mutant[] {
  const parsed = infectionLog.safeParse(json(text, 'Infection'));
  if (!parsed.success) throw new EngineError('the Infection report is not an Infection JSON log');
  const read =
    (status: MutantStatus) =>
    (entry: z.infer<typeof infectionEntry>): Mutant => ({
      file: entry.mutator.originalFilePath,
      line: entry.mutator.originalStartLine,
      ...(entry.mutator.originalEndLine === undefined
        ? {}
        : { endLine: entry.mutator.originalEndLine }),
      mutator: entry.mutator.mutatorName,
      ...diffSides(entry.diff),
      status,
    });
  return [
    ...parsed.data.escaped.map(read('survived')),
    ...parsed.data.uncovered.map(read('no-coverage')),
  ];
}

const cargoMutant = z.looseObject({
  name: z.string(),
  file: z.string(),
  span: span.optional(),
  replacement: z.string(),
  genre: z.string(),
});

const cargoOutcomes = z.looseObject({
  outcomes: z.array(
    z.looseObject({
      scenario: z.union([z.string(), z.looseObject({ Mutant: cargoMutant })]),
      summary: z.string(),
    }),
  ),
});

/** The line and what cargo-mutants says it does, from a name like `src/a.rs:6:5: replace …`. */
function fromName(name: string): { line: number; description: string } {
  const match = /:(\d+):\d+: (.*)$/.exec(name);
  return { line: Number(match?.[1] ?? 1), description: match?.[2] ?? name };
}

/**
 * cargo-mutants' `mutants.out/outcomes.json`: a `MissedMutant` survived. The report holds no
 * original code, so it comes from the source (`source` returns a file's text by the report's
 * name for it), or else from the mutant's description.
 */
export function parseCargoMutants(
  text: string,
  source: (file: string) => string | undefined,
): Mutant[] {
  const parsed = cargoOutcomes.safeParse(json(text, 'cargo-mutants'));
  if (!parsed.success) throw new EngineError('the cargo-mutants report is not an outcomes.json');
  return parsed.data.outcomes.flatMap(({ scenario, summary }): Mutant[] => {
    if (typeof scenario === 'string') return [];
    const mutant = scenario.Mutant;
    const named = fromName(mutant.name);
    const code = source(mutant.file);
    const original =
      mutant.span === undefined || code === undefined
        ? named.description
        : sliceSpan(code, mutant.span.start, mutant.span.end);
    return [
      {
        file: mutant.file,
        line: mutant.span?.start.line ?? named.line,
        ...(mutant.span === undefined ? {} : { endLine: mutant.span.end.line }),
        mutator: mutant.genre,
        original,
        replacement: mutant.replacement,
        status: summary === 'MissedMutant' ? 'survived' : 'other',
      },
    ];
  });
}

/**
 * The report Talos's mutmut runner writes, read by the Python pack's parser. mutmut's mutant
 * names carry the module and a counter, so they name the mutant in the message but not in its
 * identity.
 */
export function parseMutmut(text: string): Mutant[] {
  return parseMutmutReport(text).map((mutant) => ({
    file: mutant.file,
    line: mutant.line,
    mutator: 'mutmut',
    label: mutant.mutator,
    original: mutant.original,
    replacement: mutant.replacement,
    status:
      mutant.status === 'survived' || mutant.status === 'no-coverage' ? mutant.status : 'other',
  }));
}

/** Code for an identity: whitespace collapsed, and a long text shortened to a prefix and a hash. */
function compact(code: string): string {
  const text = normalise(code);
  if (text.length <= 80) return text;
  return `${text.slice(0, 60)}…#${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
}

/** What identifies a mutant wherever its code moves: the mutation and the code it changes. */
export function mutantKey(mutant: Mutant): string {
  return `${mutant.mutator}: ${compact(mutant.original)} → ${compact(mutant.replacement)}`;
}

function describe(mutant: Mutant): string {
  const label = mutant.label ?? mutant.mutator;
  const original = clip(mutant.original, 60);
  const replacement = clip(mutant.replacement, 60);
  const change = replacement === '' ? 'is removed' : `becomes \`${replacement}\``;
  if (original === '') return `No test fails when this ${label} mutant is applied.`;
  return mutant.status === 'no-coverage'
    ? `No test runs \`${original}\`, so nothing fails when it ${change} (${label}).`
    : `No test fails when \`${original}\` ${change} (${label}).`;
}

/** `mutation/survived` for a mutant no test killed, at its repository-relative file. */
export function mutantFinding(mutant: Mutant, file: string): Finding {
  const line = Math.max(1, mutant.line);
  const endLine =
    mutant.endLine !== undefined && mutant.endLine > line ? { endLine: mutant.endLine } : {};
  return {
    rule: 'mutation/survived',
    message: describe(mutant),
    location: { file, line, ...endLine },
    key: mutantKey(mutant),
  };
}

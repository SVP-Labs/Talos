import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobContext, JobOutcome } from './context.js';
import { debtReport } from './debt-report.js';
import type { RunResult } from '../core/result.js';
import { clip } from '../quality/text.js';

/**
 * The analyze phase's jobs. They run the default branch's code (its tests, its configs) and hold
 * no token; what they find goes into the work directory, which the act phase reads as data.
 */
export type AnalyzeDeps = {
  /** Runs the engine at the default branch's checkout, with nothing to compare (`alone`). */
  run(only: readonly string[]): Promise<RunResult>;
  readonly checks: { readonly debt: readonly string[]; readonly mutation: readonly string[] };
  /** Appends Markdown to the job summary. */
  summary(markdown: string): Promise<void>;
};

export const DEBT_FILE = 'debt.json';
export const MUTATION_FILE = 'mutation.json';
const MUTATION_SCHEMA = 'talos.mutation/1';

const LISTED = 20;
const FAULTS = 5;
const MESSAGE = 200;

export async function debtRun(ctx: JobContext, deps: AnalyzeDeps): Promise<JobOutcome> {
  const report = debtReport(await deps.run(deps.checks.debt), { repo: ctx.repo, now: ctx.now });
  await writeFile(join(ctx.workdir, DEBT_FILE), JSON.stringify(report));
  const { total, files, faults } = report.counts;
  const found = `${total} finding(s) in ${files} file(s)`;
  return faults > 0
    ? { job: 'debt-run', result: 'failed', detail: `${found}; ${faults} engine error(s)` }
    : { job: 'debt-run', result: 'done', detail: found };
}

type MutationFault = { readonly check: string; readonly reason: string };

export type MutationSummary = {
  readonly schema: typeof MUTATION_SCHEMA;
  readonly talos: string;
  readonly sha: string;
  readonly survived: number;
  readonly files: number;
  readonly faults: number;
  readonly byFile: readonly { readonly file: string; readonly survived: number }[];
  /** What each engine error said, at most {@link FAULTS} of them. */
  readonly errors: readonly MutationFault[];
};

const MASK = '***';

/**
 * Secret-shaped text a tool may print: tokens with a known prefix, private keys, JWTs, the
 * credentials of a URL or an `Authorization` header, and the value after a name that says secret.
 * Each replacement keeps what precedes the secret itself.
 */
const SECRETS: readonly (readonly [RegExp, string])[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  [/\b(?:gh[opr-u]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/g, MASK],
  [/\b(?:AKI|ASI)A[0-9A-Z]{16}\b/g, MASK],
  [/\b(?:xox)[a-bpr-s]-[\w-]{10,}/g, MASK],
  [/\b(?:npm|gl(?:pat)|sk|pk|rk)[_-][A-Za-z0-9_-]{16,}/g, MASK],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, MASK],
  [/(\/\/)[^/\s:@]+:[^/\s@]+@/g, `$1${MASK}@`],
  [/\b(Bearer|Basic|token)(\s+)[\w.~+/=-]{12,}/gi, `$1$2${MASK}`],
  [
    /\b([\w-]*(?:password|passwd|secret|token|api[_-]?key|credential)s?)(["']?\s*[=:]\s*["']?)[^\s"',;]{8,}/gi,
    `$1$2${MASK}`,
  ],
];

/** The text with every {@link SECRETS} match masked. */
export function maskSecrets(text: string): string {
  return SECRETS.reduce((masked, [pattern, by]) => masked.replaceAll(pattern, by), text);
}

/**
 * Each engine error as the check (at its component) and what it said, masked, then clipped to
 * one line: masking first, so a cut never leaves part of a secret behind unmasked.
 */
function faultsOf(result: RunResult): MutationFault[] {
  const faulted = result.outcomes.filter(({ status }) => status === 'error');
  return faulted.map(({ check, component, reason }) => {
    const where = component === undefined ? '' : `@${component}`;
    return { check: `${check}${where}`, reason: clip(maskSecrets(reason ?? ''), MESSAGE) };
  });
}

/** The weekly whole-codebase mutation run, as counts of surviving mutants per file. */
export function mutationSummary(result: RunResult): MutationSummary {
  const survivors = result.outcomes
    .filter((o) => o.check.endsWith('/mutation'))
    .flatMap((o) => o.findings)
    .filter((f) => f.rule === 'mutation/survived');
  const counts = new Map<string, number>();
  for (const f of survivors) {
    const file = f.location?.file ?? '(no file)';
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  const byFile = [...counts]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([file, survived]) => ({ file, survived }));
  const faults = faultsOf(result);
  return {
    schema: MUTATION_SCHEMA,
    talos: result.talos,
    sha: result.sha,
    survived: survivors.length,
    files: byFile.length,
    faults: faults.length,
    byFile: byFile.slice(0, LISTED),
    errors: faults.slice(0, FAULTS),
  };
}

function code(text: string): string {
  return `\`${text.replaceAll('`', "'")}\``;
}

export function mutationMarkdown(summary: MutationSummary): string {
  const rows = summary.byFile.map((f) => `| ${f.survived} | ${code(f.file)} |`);
  const errors = summary.errors.map((f) => `- **${f.check}**: ${code(f.reason)}`);
  return [
    '## Talos: weekly mutation report',
    '',
    `${summary.survived} surviving mutant(s) in ${summary.files} file(s) at ` +
      `${summary.sha.slice(0, 12)}. A report only: nothing is filed.`,
    '',
    ...(errors.length > 0 ? [`### Engine errors (${summary.faults})`, '', ...errors, ''] : []),
    ...(rows.length > 0 ? ['| survived | file |', '| --- | --- |', ...rows, ''] : []),
  ].join('\n');
}

export async function mutationReport(ctx: JobContext, deps: AnalyzeDeps): Promise<JobOutcome> {
  if (deps.checks.mutation.length === 0) {
    return { job: 'mutation-report', result: 'skipped', detail: 'no mutation check' };
  }
  const summary = mutationSummary(await deps.run(deps.checks.mutation));
  await writeFile(join(ctx.workdir, MUTATION_FILE), JSON.stringify(summary));
  await deps.summary(mutationMarkdown(summary));
  const detail = `${summary.survived} surviving mutant(s) in ${summary.files} file(s)`;
  if (summary.faults === 0) return { job: 'mutation-report', result: 'done', detail };
  const said = summary.errors.map((f) => `${f.check}: ${f.reason}`).join('; ');
  return {
    job: 'mutation-report',
    result: 'failed',
    detail: `${detail}; ${summary.faults} engine error(s): ${said}`,
  };
}

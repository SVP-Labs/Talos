import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobContext, JobOutcome } from './context.js';
import { debtReport } from './debt-report.js';
import type { RunResult } from '../core/result.js';

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
export const MUTATION_SCHEMA = 'talos.mutation/1';

const LISTED = 20;

export async function debtRun(ctx: JobContext, deps: AnalyzeDeps): Promise<JobOutcome> {
  const report = debtReport(await deps.run(deps.checks.debt), { repo: ctx.repo, now: ctx.now });
  await writeFile(join(ctx.workdir, DEBT_FILE), JSON.stringify(report));
  const { total, files, faults } = report.counts;
  const found = `${total} finding(s) in ${files} file(s)`;
  return faults > 0
    ? { job: 'debt-run', result: 'failed', detail: `${found}; ${faults} engine error(s)` }
    : { job: 'debt-run', result: 'done', detail: found };
}

export type MutationSummary = {
  readonly schema: typeof MUTATION_SCHEMA;
  readonly talos: string;
  readonly sha: string;
  readonly survived: number;
  readonly files: number;
  readonly faults: number;
  readonly byFile: readonly { readonly file: string; readonly survived: number }[];
};

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
  return {
    schema: MUTATION_SCHEMA,
    talos: result.talos,
    sha: result.sha,
    survived: survivors.length,
    files: byFile.length,
    faults: result.outcomes.filter((o) => o.status === 'error').length,
    byFile: byFile.slice(0, LISTED),
  };
}

export function mutationMarkdown(summary: MutationSummary): string {
  const rows = summary.byFile.map((f) => `| ${f.survived} | \`${f.file.replaceAll('`', "'")}\` |`);
  return [
    '## Talos: weekly mutation report',
    '',
    `${summary.survived} surviving mutant(s) in ${summary.files} file(s) at ` +
      `${summary.sha.slice(0, 12)}. A report only: nothing is filed.`,
    '',
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
  return summary.faults > 0
    ? {
        job: 'mutation-report',
        result: 'failed',
        detail: `${detail}; ${summary.faults} engine error(s)`,
      }
    : { job: 'mutation-report', result: 'done', detail };
}

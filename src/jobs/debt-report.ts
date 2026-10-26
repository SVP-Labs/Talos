import { z } from 'zod';
import type { Pack } from '../core/pack.js';
import type { RunResult } from '../core/result.js';

/**
 * The debt list: every finding on the default branch, from one run of the engine with nothing
 * to compare against (`talos debt`, and the weekly run that files debt issues from it).
 */
export const DEBT_SCHEMA = 'talos.debt/1';

const LISTED = 20;
const MESSAGE = 200;
const FAULTS = 5;

const policy = z.enum(['standard', 'always', 'lost', 'info']);

const debtFinding = z.object({
  rule: z.string().min(1),
  check: z.string().min(1),
  policy,
  file: z.string().nullable(),
  line: z.number().int().nullable(),
  key: z.string().nullable(),
  message: z.string(),
  fingerprint: z.string(),
});

export type DebtFinding = z.infer<typeof debtFinding>;

const debtReportSchema = z.object({
  schema: z.literal(DEBT_SCHEMA),
  talos: z.string(),
  repo: z.string().nullable(),
  sha: z.string(),
  createdAt: z.string(),
  counts: z.object({
    total: z.number().int(),
    rules: z.number().int(),
    files: z.number().int(),
    faults: z.number().int(),
  }),
  byRule: z.array(z.object({ rule: z.string(), count: z.number().int() })),
  byFile: z.array(z.object({ file: z.string(), count: z.number().int() })),
  faults: z.array(z.object({ check: z.string(), reason: z.string() })),
  findings: z.array(debtFinding).max(200_000),
  truncated: z.boolean(),
});

export type DebtReport = z.infer<typeof debtReportSchema>;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Each key with how often it occurs, most frequent first, then by name. */
function tally(keys: readonly string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
}

export function debtReport(
  result: RunResult,
  meta: { readonly repo?: string; readonly now: Date },
): DebtReport {
  const findings: DebtFinding[] = result.outcomes.flatMap((outcome) =>
    outcome.findings.map((f) => ({
      rule: f.rule,
      check: f.check,
      policy: f.policy,
      file: f.location?.file ?? null,
      line: f.location?.line ?? null,
      key: f.key ?? null,
      message: clip(f.message, MESSAGE),
      fingerprint: f.fingerprint,
    })),
  );
  const faults = result.outcomes
    .filter((o) => o.status === 'error')
    .map((o) => ({
      check: o.component === undefined ? o.check : `${o.check}@${o.component}`,
      reason: clip(o.reason ?? '', MESSAGE),
    }));
  const byRule = tally(findings.map((f) => f.rule)).map(([rule, count]) => ({ rule, count }));
  const byFile = tally(findings.flatMap((f) => (f.file === null ? [] : [f.file]))).map(
    ([file, count]) => ({ file, count }),
  );
  return {
    schema: DEBT_SCHEMA,
    talos: result.talos,
    repo: meta.repo ?? null,
    sha: result.sha,
    createdAt: meta.now.toISOString(),
    counts: {
      total: findings.length,
      rules: byRule.length,
      files: byFile.length,
      faults: faults.length,
    },
    byRule,
    byFile,
    faults,
    findings,
    truncated: false,
  };
}

/** The report as `--json` prints it: every count, and at most 20 entries in each list. */
export function compactDebt(report: DebtReport): DebtReport {
  const truncated =
    report.byRule.length > LISTED ||
    report.byFile.length > LISTED ||
    report.findings.length > LISTED ||
    report.faults.length > FAULTS;
  return {
    ...report,
    byRule: report.byRule.slice(0, LISTED),
    byFile: report.byFile.slice(0, LISTED),
    faults: report.faults.slice(0, FAULTS),
    findings: report.findings.slice(0, LISTED),
    truncated: truncated || report.truncated,
  };
}

/** Reads a report back. The analyze phase ran repository code to write it, so it is data. */
export function parseDebtReport(text: string): DebtReport {
  return debtReportSchema.parse(JSON.parse(text));
}

/** The plain-text summary a person reads in a terminal. */
export function debtText(report: DebtReport): string {
  const lines = [
    `${report.counts.total} finding(s) at ${report.sha.slice(0, 12)} in ` +
      `${report.counts.files} file(s), ${report.counts.rules} rule(s)`,
    ...report.byRule.slice(0, LISTED).map((r) => `  ${String(r.count).padStart(6)}  ${r.rule}`),
    ...(report.byFile.length > 0 ? ['', 'Files with the most:'] : []),
    ...report.byFile.slice(0, LISTED).map((f) => `  ${String(f.count).padStart(6)}  ${f.file}`),
    ...report.faults.map((f) => `ENGINE ERROR ${f.check}: ${f.reason}`),
  ];
  return `${lines.join('\n')}\n`;
}

/** Every check but mutation: the debt list is the findings a PR would be held to. */
export function debtCheckIds(packs: readonly Pack[]): string[] {
  return packs.flatMap((p) => p.checks.map((c) => c.id)).filter((id) => !id.endsWith('/mutation'));
}

export function mutationCheckIds(packs: readonly Pack[]): string[] {
  return packs.flatMap((p) => p.checks.map((c) => c.id)).filter((id) => id.endsWith('/mutation'));
}

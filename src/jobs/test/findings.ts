import type { Reported } from '../../core/finding.js';
import type { Outcome, RunResult } from '../../core/result.js';
import { type DebtReport, debtReport } from '../debt-report.js';

export function finding(
  rule: string,
  file: string | undefined,
  extra: Partial<Reported> = {},
): Reported {
  return {
    rule,
    message: `${rule} here`,
    check: 'ts/lint',
    policy: 'standard',
    fingerprint: `${rule}:${file ?? 'none'}`,
    ...(file === undefined ? {} : { location: { file, line: 3 } }),
    ...extra,
  };
}

export function outcome(check: string, findings: Reported[], extra: Partial<Outcome> = {}): Outcome {
  return {
    check,
    tier: 'commit',
    status: findings.length > 0 ? 'findings' : 'passed',
    durationMs: 1,
    findings,
    ...extra,
  };
}

export function result(outcomes: Outcome[]): RunResult {
  return { talos: '1.2.3', sha: 'a'.repeat(40), tiers: ['commit', 'head'], os: 'linux', outcomes };
}

/** A debt report holding these findings, all from one check. */
export function reportOf(findings: Reported[]): DebtReport {
  return debtReport(result([outcome('ts/lint', findings)]), {
    repo: 'o/r',
    now: new Date('2026-10-26T03:17:00Z'),
  });
}

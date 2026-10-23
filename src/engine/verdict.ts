import type { Os, Tier } from '../core/check.js';
import { type Judged, judge } from '../core/compare.js';
import type { Reported } from '../core/finding.js';
import { type Outcome, type RunResult, findingsOf } from '../core/result.js';
import type { ChangeSet } from '../repo/changes.js';

/** One comparison the gate makes: a tier at `sha` against the same tier at `against`. */
export type Comparison = {
  readonly sha: string;
  readonly against: string;
  readonly tier: Tier;
  readonly changes: ChangeSet;
};

export type Located = Judged & { readonly sha: string };

export type EngineFault = Outcome & { readonly sha: string; readonly os: Os };

export type Verdict = {
  readonly findings: readonly Located[];
  readonly blocking: readonly Located[];
  readonly faults: readonly EngineFault[];
};

function resultFor(
  results: readonly RunResult[],
  sha: string,
  os: Os,
  tier: Tier,
): RunResult | undefined {
  return results.find((r) => r.sha === sha && r.os === os && r.tiers.includes(tier));
}

function dedupe(findings: readonly Located[]): Located[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = [f.sha, f.check, f.fingerprint, f.location?.file, f.location?.line, f.isNew].join(
      '|',
    );
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compareOne(results: readonly RunResult[], comparison: Comparison, os: Os): Located[] {
  const head = resultFor(results, comparison.sha, os, comparison.tier);
  if (head === undefined) return [];
  const base = resultFor(results, comparison.against, os, comparison.tier);
  const judged = judge(
    base === undefined ? [] : findingsOf(base, comparison.tier),
    findingsOf(head, comparison.tier),
    comparison.changes,
  );
  return judged.map((finding) => ({ ...finding, sha: comparison.sha }));
}

/** Judges every comparison on every OS, adds commit-level findings, and collects engine faults. */
export function decide(
  results: readonly RunResult[],
  comparisons: readonly Comparison[],
  commitFindings: readonly (Reported & { readonly sha: string })[],
): Verdict {
  const oses = [...new Set(results.map((r) => r.os))];
  const compared = comparisons.flatMap((c) => oses.flatMap((os) => compareOne(results, c, os)));
  const fromCommits: Located[] = commitFindings.map((f) => ({
    ...f,
    isNew: true,
    blocking: f.policy !== 'info',
    why: f.policy === 'info' ? 'info' : 'new',
  }));
  const findings = dedupe([...compared, ...fromCommits]);
  const faults = results.flatMap((r) =>
    r.outcomes.filter((o) => o.status === 'error').map((o) => ({ ...o, sha: r.sha, os: r.os })),
  );
  return { findings, blocking: findings.filter((f) => f.blocking), faults };
}

export type GateStatus = 'green' | 'red' | 'engine-error';

export function statusOf(verdict: Verdict): GateStatus {
  if (verdict.faults.length > 0) return 'engine-error';
  return verdict.blocking.length > 0 ? 'red' : 'green';
}

export const EXIT = { green: 0, findings: 1, engine: 2, usage: 3 } as const;

export function exitCode(verdict: Verdict): number {
  if (verdict.faults.length > 0) return EXIT.engine;
  return verdict.blocking.length > 0 ? EXIT.findings : EXIT.green;
}

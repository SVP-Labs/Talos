import type { DebtFinding, DebtReport } from './debt-report.js';
import {
  codeSpan,
  digest,
  fileIssue,
  type IssueDraft,
  marker,
  type TalosIssue,
  talosIssues,
} from './talos-issues.js';
import type { GitHub } from '../github/api.js';
import type { Identities } from '../github/identities.js';
import { LABEL } from '../ticket/labels.js';

/** New debt issues per weekly run; the rest wait for a later week. */
export const WEEKLY_BATCH = 5;

/** A stale generated copy is a sync chore, not a debt issue. */
export const DRIFT_CHECK = 'configs/drift';

const LISTED = 30;

const DEAD_CODE_RULE = /^(?:knip|vulture|cargo-machete)\/|^(?:rustc|clippy)\/dead_code$/;

/** Dead code: a `<lang>/dead-code` check's finding, or a rule of a dead-code tool. */
export function isDeadCode(finding: Pick<DebtFinding, 'rule' | 'check'>): boolean {
  return /\/dead-?code$/.test(finding.check) || DEAD_CODE_RULE.test(finding.rule);
}

/** A path an issue can name exactly, as `` - `path` `` under Affected areas. */
export function nameable(path: string): boolean {
  return /^[^\s`]+$/.test(path);
}

/**
 * Findings a debt issue can take: in a file, held to a PR's standard (an `always` finding blocks
 * every PR already and has its own issue; an `info` one never counts against a change), and not
 * a stale generated copy.
 */
export function issuable(finding: DebtFinding): finding is DebtFinding & { file: string } {
  return (
    finding.file !== null &&
    nameable(finding.file) &&
    (finding.policy === 'standard' || finding.policy === 'lost') &&
    finding.check !== DRIFT_CHECK
  );
}

export type DebtCandidate = {
  readonly file: string;
  readonly kind: 'dead-code' | 'other';
  readonly findings: readonly DebtFinding[];
  /** Which findings these are, so an issue the owner declined isn't filed again for them. */
  readonly digest: string;
};

/**
 * One candidate per file with findings: dead code first (cheap and safe to remove), then the
 * files with the most findings, then by path.
 */
export function debtCandidates(report: DebtReport): DebtCandidate[] {
  const byFile = new Map<string, DebtFinding[]>();
  for (const finding of report.findings.filter(issuable)) {
    byFile.set(finding.file, [...(byFile.get(finding.file) ?? []), finding]);
  }
  const candidates = [...byFile].map(([file, findings]): DebtCandidate => {
    const kind = findings.every(isDeadCode) ? 'dead-code' : 'other';
    const prints = findings.map((f) => f.fingerprint).sort((a, b) => a.localeCompare(b));
    return { file, kind, findings, digest: digest(prints.join('\n')) };
  });
  const rank = (c: DebtCandidate): number => (c.kind === 'dead-code' ? 0 : 1);
  return candidates.sort(
    (a, b) =>
      rank(a) - rank(b) || b.findings.length - a.findings.length || a.file.localeCompare(b.file),
  );
}

/**
 * The week's batch: files with no open Talos debt issue, skipping findings the owner closed as
 * not planned. A file whose findings changed since is filed again.
 */
export function pickDebtIssues(
  candidates: readonly DebtCandidate[],
  existing: readonly TalosIssue[],
  limit = WEEKLY_BATCH,
): DebtCandidate[] {
  const open = new Set(existing.filter((i) => i.state === 'open').map((i) => i.fields.file));
  const declined = new Set(
    existing
      .filter((i) => i.state === 'closed' && i.stateReason === 'not_planned')
      .map((i) => `${i.fields.file ?? ''}|${i.fields.findings ?? ''}`),
  );
  return candidates
    .filter((c) => !open.has(c.file) && !declined.has(`${c.file}|${c.digest}`))
    .slice(0, limit);
}

function findingRows(findings: readonly DebtFinding[]): string[] {
  const rows = findings
    .slice(0, LISTED)
    .map((f) => `| ${f.line ?? '—'} | ${codeSpan(f.rule, 80)} | ${codeSpan(f.message)} |`);
  const more = findings.length - LISTED;
  return [
    '| line | rule | message |',
    '| --- | --- | --- |',
    ...rows,
    ...(more > 0 ? ['', `And ${more} more: \`talos debt --out debt.json\` lists them all.`] : []),
  ];
}

/** The issue for one candidate: ready to claim, its Affected areas naming exactly its file. */
export function debtIssue(candidate: DebtCandidate): IssueDraft {
  const n = candidate.findings.length;
  const what = candidate.kind === 'dead-code' ? 'Dead code' : 'Debt';
  const file = `\`${candidate.file}\``;
  const body = [
    marker('debt', { file: candidate.file, findings: candidate.digest }),
    '### Goal',
    '',
    `Clear the ${n} finding(s) Talos reports in ${file} on the default branch, so the file ` +
      'leaves the debt list.',
    '',
    '### Acceptance criteria',
    '',
    `- [ ] \`talos check\` reports none of the findings below in ${file}`,
    '- [ ] Behaviour is unchanged: the existing tests pass, and none is removed or weakened',
    '',
    '### Out of scope',
    '',
    `Every file but ${file} and its tests. Findings elsewhere get issues of their own.`,
    '',
    '### Affected areas',
    '',
    `- ${file}`,
    '',
    '### Findings',
    '',
    ...findingRows(candidate.findings),
    '',
  ].join('\n');
  return {
    title: `${what} in ${candidate.file} (${n} finding${n === 1 ? '' : 's'})`,
    body,
    labels: [
      candidate.kind === 'dead-code' ? LABEL.deadCode : LABEL.debtOther,
      LABEL.ready,
      LABEL.eligible,
      LABEL.p3,
    ],
  };
}

export type DebtFiling = { readonly filed: number; readonly candidates: number };

/** Files the week's debt issues from the analyze phase's report, as the reviewer App. */
export async function fileDebtIssues(
  gh: GitHub,
  at: { readonly repo: string; readonly who: Identities },
  report: DebtReport,
): Promise<DebtFiling> {
  const existing = [
    ...(await talosIssues(gh, at, LABEL.deadCode, 'debt')),
    ...(await talosIssues(gh, at, LABEL.debtOther, 'debt')),
  ];
  const candidates = debtCandidates(report);
  const picks = pickDebtIssues(candidates, existing);
  for (const pick of picks) await fileIssue(gh, at.repo, debtIssue(pick));
  return { filed: picks.length, candidates: candidates.length };
}

/**
 * The label names the claim protocol, issue readiness and Talos's own issues use. Every one of
 * them is defined, with its meaning, in `assets/labels.yml`, which label sync applies.
 */
export const LABEL = {
  ready: 'status/ready',
  inProgress: 'status/in-progress',
  eligible: 'ai/eligible',
  claimed: 'ai/claimed',
  needsSpec: 'needs-spec',
  needsDecision: 'needs-decision',
  needsHuman: 'needs-human',
  blocked: 'blocked',
  legacy: 'legacy',
  decision: 'decision',
  epic: 'epic',
  bug: 'bug',
  chore: 'chore',
  deadCode: 'debt/dead-code',
  debtOther: 'debt/other',
  flaky: 'flaky',
  sync: 'sync',
  p2: 'priority/p2',
  p3: 'priority/p3',
} as const;

/** An issue carries exactly one of these. */
export const TYPE_LABELS: readonly string[] = [
  'feature',
  'bug',
  'chore',
  'refactor',
  'spike',
  LABEL.deadCode,
  LABEL.debtOther,
  LABEL.epic,
];

/** Labels that keep an issue out of every claim, whatever its status. */
export const CLAIM_BLOCKERS: readonly string[] = [
  LABEL.blocked,
  LABEL.legacy,
  LABEL.needsSpec,
  LABEL.needsDecision,
  LABEL.needsHuman,
  LABEL.epic,
];

const PRIORITY = /^priority\/p([0-3])$/;

/** The most urgent `priority/pN` an issue carries; an issue without one is `p3`. */
export function priorityOf(labels: readonly string[]): number {
  let best = 3;
  for (const label of labels) {
    const level = PRIORITY.exec(label)?.[1];
    if (level !== undefined) best = Math.min(best, Number(level));
  }
  return best;
}

export function typeLabelsOf(labels: readonly string[]): string[] {
  return labels.filter((label) => TYPE_LABELS.includes(label));
}

/** Whether the labels mirror a claim: its branch exists, or did when they were set. */
export function looksClaimed(labels: readonly string[]): boolean {
  return labels.includes(LABEL.inProgress) || labels.includes(LABEL.claimed);
}

import type { Reported } from './finding.js';
import { type ChangeSet, touches } from '../repo/changes.js';

type Why = 'new' | 'changed-line' | 'security' | 'lost' | 'existing' | 'info';

export type Judged = Reported & {
  /** More of this fingerprint at head than at base, and this occurrence is one of the extra. */
  readonly isNew: boolean;
  readonly blocking: boolean;
  readonly why: Why;
};

function countByFingerprint(findings: readonly Reported[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    counts.set(finding.fingerprint, (counts.get(finding.fingerprint) ?? 0) + 1);
  }
  return counts;
}

function verdict(
  finding: Reported,
  isNew: boolean,
  touched: boolean,
): Pick<Judged, 'blocking' | 'why'> {
  switch (finding.policy) {
    case 'always':
      return { blocking: true, why: 'security' };
    case 'info':
      return { blocking: false, why: 'info' };
    case 'lost':
      return isNew && !touched
        ? { blocking: true, why: 'lost' }
        : { blocking: false, why: 'existing' };
    case 'standard':
      if (isNew) return { blocking: true, why: 'new' };
      return touched
        ? { blocking: true, why: 'changed-line' }
        : { blocking: false, why: 'existing' };
  }
}

/**
 * Judges head's findings against base's. Fingerprints are compared by count, so copying a
 * violating line adds one; of several occurrences, those on changed lines count as the new ones.
 */
export function judge(
  base: readonly Reported[],
  head: readonly Reported[],
  changes: ChangeSet,
): Judged[] {
  const remaining = countByFingerprint(base);
  // Base occurrences are matched to untouched lines first, so those on changed lines are new.
  const ordered = head
    .map((finding, index) => ({ finding, index, touched: touches(changes, finding.location) }))
    .sort((a, b) => Number(a.touched) - Number(b.touched));
  const judged = ordered.map(({ finding, index, touched }) => {
    const left = remaining.get(finding.fingerprint) ?? 0;
    const isNew = left === 0;
    if (!isNew) remaining.set(finding.fingerprint, left - 1);
    return { index, judged: { ...finding, isNew, ...verdict(finding, isNew, touched) } };
  });
  return judged.toSorted((a, b) => a.index - b.index).map((entry) => entry.judged);
}

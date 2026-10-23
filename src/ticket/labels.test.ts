import { describe, expect, it } from 'vitest';
import {
  LABEL,
  looksClaimed,
  priorityOf,
  TYPE_LABELS,
  typeLabelsOf,
  CLAIM_BLOCKERS,
} from './labels.js';
import { shippedLabels } from '../jobs/label-sync.js';

describe('priorityOf', () => {
  it('reads the most urgent priority label', () => {
    expect(priorityOf(['priority/p2', 'bug', 'priority/p0'])).toBe(0);
    expect(priorityOf(['priority/p1'])).toBe(1);
  });

  it('counts an issue without one as p3', () => {
    expect(priorityOf([])).toBe(3);
    expect(priorityOf(['priority/p9', 'priority/high'])).toBe(3);
  });
});

describe('typeLabelsOf', () => {
  it('keeps only type labels', () => {
    expect(typeLabelsOf(['bug', 'status/ready', 'debt/other', 'decision'])).toEqual([
      'bug',
      'debt/other',
    ]);
  });
});

describe('looksClaimed', () => {
  it('is true for either claim label', () => {
    expect(looksClaimed(['status/in-progress'])).toBe(true);
    expect(looksClaimed(['ai/claimed'])).toBe(true);
    expect(looksClaimed(['status/ready', 'ai/eligible'])).toBe(false);
  });
});

describe('the shipped labels', () => {
  it('define every label the protocol and the jobs use, with a description', async () => {
    const shipped = new Map((await shippedLabels()).map((l) => [l.name, l]));
    const used = [
      ...Object.values(LABEL),
      ...TYPE_LABELS,
      ...CLAIM_BLOCKERS,
      'ai/go',
      'priority/p0',
    ];
    for (const name of used) expect(shipped.get(name)?.description, name).toBeTruthy();
  });

  it('drop the labels that mirrored state GitHub already holds', async () => {
    const names = (await shippedLabels()).map((l) => l.name);
    for (const gone of ['status/in-review', 'review/round-1', 'test-change', 'plan-required']) {
      expect(names).not.toContain(gone);
    }
  });
});

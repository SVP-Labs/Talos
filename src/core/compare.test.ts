import { describe, expect, it } from 'vitest';
import { judge } from './compare.js';
import type { Reported } from './finding.js';
import { parseDiff } from '../repo/changes.js';

function finding(
  fingerprint: string,
  line: number,
  policy: Reported['policy'] = 'standard',
): Reported {
  return {
    rule: 'r/x',
    message: 'm',
    check: 'c',
    fingerprint,
    policy,
    location: { file: 'a.ts', line },
  };
}

const changedLine3 = parseDiff(
  ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -3 +3 @@', '-old', '+new'].join(
    '\n',
  ),
);

describe('judge', () => {
  it('passes findings the base already had on untouched lines', () => {
    const [judged] = judge([finding('f', 9)], [finding('f', 20)], changedLine3);
    expect(judged).toMatchObject({ isNew: false, blocking: false, why: 'existing' });
  });

  it('blocks a finding the base did not have', () => {
    const [judged] = judge([], [finding('f', 20)], changedLine3);
    expect(judged).toMatchObject({ isNew: true, blocking: true, why: 'new' });
  });

  it('blocks a pre-existing finding on a line the change touched', () => {
    const [judged] = judge([finding('f', 3)], [finding('f', 3)], changedLine3);
    expect(judged).toMatchObject({ isNew: false, blocking: true, why: 'changed-line' });
  });

  it('compares counts, so a copy of a violating line is new', () => {
    const judged = judge([finding('f', 9)], [finding('f', 9), finding('f', 30)], changedLine3);
    expect(judged.filter((j) => j.isNew)).toHaveLength(1);
  });

  it('counts the occurrence on a changed line as the new one', () => {
    const judged = judge([finding('f', 9)], [finding('f', 9), finding('f', 3)], changedLine3);
    expect(judged.map((j) => j.isNew)).toEqual([false, true]);
  });

  it('always blocks security findings and never blocks informational ones', () => {
    const judged = judge(
      [finding('s', 1, 'always'), finding('i', 1, 'info')],
      [finding('s', 1, 'always'), finding('i', 2, 'info')],
      changedLine3,
    );
    expect(judged.map((j) => j.blocking)).toEqual([true, false]);
  });

  it('blocks lost coverage only off the changed lines', () => {
    const judged = judge([], [finding('u', 3, 'lost'), finding('v', 7, 'lost')], changedLine3);
    expect(judged.map((j) => [j.blocking, j.why])).toEqual([
      [false, 'existing'],
      [true, 'lost'],
    ]);
  });
});

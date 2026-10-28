import { describe, expect, it } from 'vitest';
import {
  decide,
  type DecisionInput,
  listed,
  type ReviewerState,
  reviewerCondition,
  type UnattendedFacts,
  unattendedConditions,
} from './conditions.js';

const META: UnattendedFacts = {
  closingCount: 1,
  issue: { number: 12, type: 'debt/other', setter: 'reviewer' },
  outside: [],
  guarded: [],
  integrity: { flagged: false, reasons: [] },
  protectedPaths: [],
  isTalos: false,
  onChannel: true,
};

const RULES = [
  { met: true, line: 'branch T-12 closes #12 and no other issue' },
  { met: true, line: 'the PR body has Problem, Discussion and Solution' },
];

function input(
  overrides: Partial<DecisionInput> = {},
  unattended: Partial<UnattendedFacts> = {},
): DecisionInput {
  return {
    rules: RULES,
    reviewer: { kind: 'approved', round: 1 },
    owner: { approved: false, line: 'the owner has not approved the head' },
    unattended: { ...META, ...unattended },
    ...overrides,
  };
}

const OWNER_OK = { approved: true, line: 'the owner approved: @SvenPGH on GitHub' } as const;

describe('decide', () => {
  it('passes debt work that meets every condition, without the owner', () => {
    const decision = decide(input());
    expect(decision.state).toBe('pass');
    expect(decision.title).toBe('Passes as debt or chore work, without the owner');
    expect(decision.unattended.every((c) => c.met)).toBe(true);
  });

  it('passes with the owner approval whatever the debt conditions say', () => {
    const decision = decide(
      input({ owner: OWNER_OK }, { closingCount: 0, issue: undefined, isTalos: true }),
    );
    expect(decision.state).toBe('pass');
    expect(decision.title).toBe('Passes: the owner approved');
    expect(decision.owner).toEqual({ met: true, line: OWNER_OK.line });
  });

  it('passes with the owner where the debt conditions also hold, naming the owner', () => {
    expect(decide(input({ owner: OWNER_OK })).title).toBe('Passes: the owner approved');
  });

  const flips: [string, Partial<UnattendedFacts>][] = [
    ['two closing issues', { closingCount: 2, issue: undefined }],
    ['no closing issue', { closingCount: 0, issue: undefined }],
    ['a feature issue', { issue: { number: 12, type: 'feature', setter: 'person' } }],
    ['an issue with no single type', { issue: { number: 12, type: undefined, setter: 'person' } }],
    ['a label set by another App', { issue: { number: 12, type: 'chore', setter: 'other' } }],
    ['a label with no record', { issue: { number: 12, type: 'chore', setter: 'unknown' } }],
    ['a file outside the issue', { outside: ['src/other.ts'] }],
    ['a guarded file', { guarded: ['package.json'] }],
    ['flagged test integrity', { integrity: { flagged: true, reasons: ['adds 1 skip markers'] } }],
    ['a protected path', { protectedPaths: ['src/review/job.ts'] }],
    ['the Talos repository', { isTalos: true }],
  ];

  it.each(flips)('waits for the owner on %s', (_name, facts) => {
    const decision = decide(input({}, facts));
    expect(decision.state).toBe('wait');
    expect(decision.title).toBe("Waits for the owner's approval");
    expect(decision.unattended.filter((c) => !c.met)).toHaveLength(1);
    expect(decide(input({ owner: OWNER_OK }, facts)).state).toBe('pass');
  });

  it('fails on an unmet PR rule, even with every approval, and names it', () => {
    const rules = [
      RULES[0]!,
      { met: false, line: "the PR body's Solution section is missing or empty" },
    ];
    const decision = decide(input({ rules, owner: OWNER_OK }));
    expect(decision.state).toBe('fail');
    expect(decision.title).toBe("Fails: the PR body's Solution section is missing or empty");
  });

  it('names the first unmet rule when several are unmet', () => {
    const rules = [
      { met: false, line: 'branch main is not a ticket branch T-<N>' },
      { met: false, line: 'second' },
    ];
    expect(decide(input({ rules })).title).toBe('Fails: branch main is not a ticket branch T-<N>');
  });

  const blocking: [ReviewerState, string][] = [
    [
      { kind: 'changes', round: 2, findings: 3 },
      'Fails: the reviewer requested changes (round 2, 3 findings)',
    ],
    [
      { kind: 'needs-human' },
      'Fails: the reviewer requested changes twice already: needs a person',
    ],
    [
      { kind: 'no-verdict', reason: 'the answer holds no JSON object' },
      'Fails: the reviewer gave no verdict: the answer holds no JSON object',
    ],
  ];

  it.each(blocking)('fails while the reviewer is %o, even with the owner', (reviewer, title) => {
    const decision = decide(input({ reviewer, owner: OWNER_OK }));
    expect(decision.state).toBe('fail');
    expect(decision.title).toBe(title);
  });

  it('waits for the reviewer when it has not reviewed the head, even with the owner', () => {
    const reviewer: ReviewerState = {
      kind: 'waiting',
      reason: 'the PR is a draft; the review starts when it is ready',
    };
    const decision = decide(input({ reviewer, owner: OWNER_OK }));
    expect(decision.state).toBe('wait');
    expect(decision.title).toBe(
      'Waits: the reviewer waits: the PR is a draft; the review starts when it is ready',
    );
  });

  it('skips the reviewer where agents are off', () => {
    expect(decide(input({ reviewer: { kind: 'off' } })).state).toBe('pass');
    expect(decide(input({ reviewer: { kind: 'off' } }, { isTalos: true })).state).toBe('wait');
  });

  it('reports every condition in order', () => {
    const decision = decide(input());
    expect(decision.rules).toEqual(RULES);
    expect(decision.reviewer).toEqual({
      met: true,
      line: 'the reviewer approved the head (round 1)',
    });
    expect(decision.unattended.map((c) => c.line)).toEqual([
      'closes one issue, #12',
      '#12 is debt/other work',
      "#12's debt/other label was set by Talos's debt job",
      "stays inside its issue's Affected areas",
      'touches no guarded file',
      'test integrity: nothing flagged',
      'touches no protected path',
      'not the Talos repository',
      'the repository is on a channel',
    ]);
  });

  it('lands nothing without the owner at evaluate, where talos/review alone holds the branch', () => {
    const atEvaluate = decide(input({}, { onChannel: false }));
    expect(atEvaluate.state).toBe('wait');
    expect(atEvaluate.title).toBe("Waits for the owner's approval");
    expect(atEvaluate.unattended.at(-1)).toEqual({
      met: false,
      line: 'the repository is at evaluate: every PR needs the owner',
    });
    expect(decide(input({ owner: OWNER_OK }, { onChannel: false })).state).toBe('pass');
  });
});

describe('reviewerCondition', () => {
  it('says what each state means', () => {
    expect(reviewerCondition({ kind: 'off' })).toEqual({
      met: true,
      line: 'the reviewer: agents are off here, so no AI review is needed',
    });
    expect(reviewerCondition({ kind: 'approved', round: 3 })).toEqual({
      met: true,
      line: 'the reviewer approved the head (round 3)',
    });
    expect(reviewerCondition({ kind: 'waiting', reason: 'x' })).toEqual({
      met: false,
      line: 'the reviewer waits: x',
    });
  });
});

describe('unattendedConditions', () => {
  it('describes each unmet condition', () => {
    const lines = unattendedConditions({
      closingCount: 1,
      issue: { number: 7, type: 'feature', setter: 'other' },
      outside: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
      guarded: ['.github/workflows/talos.yml'],
      integrity: {
        flagged: true,
        reasons: ['adds 1 skip markers', 'deletes test files: a.test.ts'],
      },
      protectedPaths: ['src/review/job.ts'],
      isTalos: true,
      onChannel: false,
    });
    expect(lines).toEqual([
      { met: true, line: 'closes one issue, #7' },
      { met: false, line: '#7 is feature, not chore or debt work' },
      { met: false, line: "#7's feature label was set by an App that doesn't count" },
      { met: false, line: 'touches files its issue does not name: a.ts, b.ts, c.ts and 1 more' },
      { met: false, line: 'touches guarded files: .github/workflows/talos.yml' },
      { met: false, line: 'test integrity: adds 1 skip markers; deletes test files: a.test.ts' },
      { met: false, line: 'touches protected paths: src/review/job.ts' },
      { met: false, line: 'the Talos repository: every PR needs the owner' },
      { met: false, line: 'the repository is at evaluate: every PR needs the owner' },
    ]);
  });

  it('accepts a label a person set, and names a missing type', () => {
    const person = unattendedConditions({
      ...META,
      issue: { number: 3, type: 'chore', setter: 'person' },
    });
    expect(person[1]).toEqual({ met: true, line: '#3 is chore work' });
    expect(person[2]).toEqual({ met: true, line: "#3's chore label was set by a person" });
    const none = unattendedConditions({
      ...META,
      issue: { number: 3, type: undefined, setter: 'unknown' },
    });
    expect(none[1]).toEqual({ met: false, line: '#3 is no single type, not chore or debt work' });
    expect(none[2]).toEqual({ met: false, line: 'no record of who labelled #3 no single type' });
  });

  it('accepts each type that may land without the owner', () => {
    for (const type of ['chore', 'debt/dead-code', 'debt/other']) {
      expect(
        unattendedConditions({ ...META, issue: { number: 1, type, setter: 'person' } })[1]?.met,
      ).toBe(true);
    }
  });

  it('explains a PR that closes no single issue here', () => {
    expect(unattendedConditions({ ...META, closingCount: 1, issue: undefined })[0]).toEqual({
      met: false,
      line: 'closes an issue of another repository; debt and chore work closes one of this one',
    });
    expect(unattendedConditions({ ...META, closingCount: 0, issue: undefined })).toEqual([
      { met: false, line: 'closes 0 issues; debt and chore work closes exactly one' },
      ...unattendedConditions(META).slice(3),
    ]);
  });
});

describe('listed', () => {
  it('shows three paths and counts the rest', () => {
    expect(listed(['a'])).toBe('a');
    expect(listed(['a', 'b', 'c'])).toBe('a, b, c');
    expect(listed(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more');
  });
});

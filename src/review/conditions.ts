import type { OwnerApproval } from './approval.js';
import type { Condition } from './rules.js';
import { isUnattended, type LabelSetter } from './scope.js';

/**
 * `talos/review`'s decision. It passes only when the PR keeps the ticket and history rules, the
 * reviewer approved the head (where agents are on), and either the owner approved after the last
 * push or every debt-and-chore condition holds. Pure: every fact arrives already read.
 */

/** Where the reviewer's AI review stands on the head. */
export type ReviewerState =
  | { readonly kind: 'off' }
  | { readonly kind: 'approved'; readonly round: number }
  | { readonly kind: 'changes'; readonly round: number; readonly findings: number }
  | { readonly kind: 'needs-human' }
  | { readonly kind: 'no-verdict'; readonly reason: string }
  | { readonly kind: 'waiting'; readonly reason: string };

/** What the debt-and-chore conditions read about the PR. */
export type UnattendedFacts = {
  /** How many issues the PR closes, in any repository. */
  readonly closingCount: number;
  /** The one issue it closes in this repository, when it closes exactly one. */
  readonly issue:
    | { readonly number: number; readonly type: string | undefined; readonly setter: LabelSetter }
    | undefined;
  /** Touched paths the issue's Affected areas don't cover. */
  readonly outside: readonly string[];
  readonly guarded: readonly string[];
  readonly integrity: { readonly flagged: boolean; readonly reasons: readonly string[] };
  readonly protectedPaths: readonly string[];
  readonly isTalos: boolean;
  /** The repository is on `canary` or `stable`, not at `evaluate`. */
  readonly onChannel: boolean;
};

export type DecisionInput = {
  readonly rules: readonly Condition[];
  readonly reviewer: ReviewerState;
  readonly owner: OwnerApproval;
  readonly unattended: UnattendedFacts;
};

/** `pass` lands; `wait` waits on a person; `fail` needs a change to the PR. */
export type DecisionState = 'pass' | 'wait' | 'fail';

export type Decision = {
  readonly state: DecisionState;
  readonly title: string;
  readonly rules: readonly Condition[];
  readonly reviewer: Condition;
  readonly owner: Condition;
  readonly unattended: readonly Condition[];
};

export function listed(paths: readonly string[]): string {
  const shown = paths.slice(0, 3).join(', ');
  return paths.length > 3 ? `${shown} and ${paths.length - 3} more` : shown;
}

export function reviewerCondition(state: ReviewerState): Condition {
  switch (state.kind) {
    case 'off': {
      return { met: true, line: 'the reviewer: agents are off here, so no AI review is needed' };
    }
    case 'approved': {
      return { met: true, line: `the reviewer approved the head (round ${state.round})` };
    }
    case 'changes': {
      const line = `the reviewer requested changes (round ${state.round}, ${state.findings} findings)`;
      return { met: false, line };
    }
    case 'needs-human': {
      return { met: false, line: 'the reviewer requested changes twice already: needs a person' };
    }
    case 'no-verdict': {
      return { met: false, line: `the reviewer gave no verdict: ${state.reason}` };
    }
    case 'waiting': {
      return { met: false, line: `the reviewer waits: ${state.reason}` };
    }
  }
}

function issueConditions(facts: UnattendedFacts): Condition[] {
  const { issue } = facts;
  if (issue === undefined) {
    const line =
      facts.closingCount === 1
        ? 'closes an issue of another repository; debt and chore work closes one of this one'
        : `closes ${facts.closingCount} issues; debt and chore work closes exactly one`;
    return [{ met: false, line }];
  }
  const type = issue.type ?? 'no single type';
  const unattended = isUnattended(issue.type);
  const setter: Readonly<Record<LabelSetter, Condition>> = {
    person: { met: true, line: `#${issue.number}'s ${type} label was set by a person` },
    reviewer: { met: true, line: `#${issue.number}'s ${type} label was set by Talos's debt job` },
    other: {
      met: false,
      line: `#${issue.number}'s ${type} label was set by an App that doesn't count`,
    },
    unknown: { met: false, line: `no record of who labelled #${issue.number} ${type}` },
  };
  return [
    { met: true, line: `closes one issue, #${issue.number}` },
    unattended
      ? { met: true, line: `#${issue.number} is ${type} work` }
      : { met: false, line: `#${issue.number} is ${type}, not chore or debt work` },
    setter[issue.setter],
  ];
}

function pathCondition(paths: readonly string[], none: string, some: string): Condition {
  return paths.length === 0
    ? { met: true, line: none }
    : { met: false, line: `${some}: ${listed(paths)}` };
}

/** The debt-and-chore conditions, each one line. */
export function unattendedConditions(facts: UnattendedFacts): Condition[] {
  return [
    ...issueConditions(facts),
    pathCondition(
      facts.outside,
      "stays inside its issue's Affected areas",
      'touches files its issue does not name',
    ),
    pathCondition(facts.guarded, 'touches no guarded file', 'touches guarded files'),
    facts.integrity.flagged
      ? { met: false, line: `test integrity: ${facts.integrity.reasons.join('; ')}` }
      : { met: true, line: 'test integrity: nothing flagged' },
    pathCondition(facts.protectedPaths, 'touches no protected path', 'touches protected paths'),
    facts.isTalos
      ? { met: false, line: 'the Talos repository: every PR needs the owner' }
      : { met: true, line: 'not the Talos repository' },
    facts.onChannel
      ? { met: true, line: 'the repository is on a channel' }
      : { met: false, line: 'the repository is at evaluate: every PR needs the owner' },
  ];
}

const BLOCKING: ReadonlySet<ReviewerState['kind']> = new Set([
  'changes',
  'needs-human',
  'no-verdict',
]);

function titleOf(state: DecisionState, input: DecisionInput, reviewer: Condition): string {
  const rule = input.rules.find((c) => !c.met);
  if (rule !== undefined) return `Fails: ${rule.line}`;
  if (state === 'fail') return `Fails: ${reviewer.line}`;
  if (state === 'wait') {
    return reviewer.met ? "Waits for the owner's approval" : `Waits: ${reviewer.line}`;
  }
  return input.owner.approved
    ? 'Passes: the owner approved'
    : 'Passes as debt or chore work, without the owner';
}

export function decide(input: DecisionInput): Decision {
  const reviewer = reviewerCondition(input.reviewer);
  const owner: Condition = { met: input.owner.approved, line: input.owner.line };
  const unattended = unattendedConditions(input.unattended);
  const rulesMet = input.rules.every((c) => c.met);
  const unattendedMet = unattended.every((c) => c.met);
  let state: DecisionState = 'wait';
  if (rulesMet && reviewer.met && (owner.met || unattendedMet)) state = 'pass';
  else if (!rulesMet || BLOCKING.has(input.reviewer.kind)) state = 'fail';
  return {
    state,
    title: titleOf(state, input, reviewer),
    rules: input.rules,
    reviewer,
    owner,
    unattended,
  };
}

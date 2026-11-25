import type { Decision, DecisionState } from './conditions.js';
import type { ReviewerRun } from './reviewer.js';
import type { Condition } from './rules.js';
import type { CheckRunFields } from '../github/checks.js';
import type { JobOutcome } from '../jobs/context.js';
import { clip } from '../ticket/payload.js';

/**
 * How `talos/review` reports: a check run whose conclusion says who acts next. `pass` is green;
 * `fail` is red, for something the PR must change; `wait` stays in progress while it waits on a
 * person (the owner, or the reviewer's review of a draft), so nobody mistakes waiting for a fault.
 */

export const CHECK_NAME = 'talos/review';

const TITLE_MAX = 200;

function item(condition: Condition): string {
  return `- [${condition.met ? 'x' : ' '}] ${condition.line}`;
}

/** One line per condition: the PR's rules, the reviewer, the owner, then debt and chore work. */
export function checkSummary(decision: Decision): string {
  return [
    ...decision.rules.map(item),
    item(decision.reviewer),
    item(decision.owner),
    '',
    'Without the owner, debt and chore work lands when all of these hold:',
    '',
    ...decision.unattended.map(item),
  ].join('\n');
}

/** The check run for a decision. In the merge queue nothing waits: an unmet condition fails. */
export function checkFields(
  decision: Decision,
  state: DecisionState,
  run: ReviewerRun | undefined,
): CheckRunFields {
  const text =
    run?.kind === 'needs-human' && run.body !== undefined
      ? `The reviewer's sixth request, not submitted:\n\n${run.body}`
      : undefined;
  const output = {
    title: clip(decision.title, TITLE_MAX),
    summary: checkSummary(decision),
    ...(text === undefined ? {} : { text }),
  };
  if (state === 'wait') return { status: 'in_progress', output };
  return { conclusion: state === 'pass' ? 'success' : 'failure', output };
}

/** The check run when `talos/review` couldn't decide: red, with what failed and never a body. */
export function errorFields(detail: string): CheckRunFields {
  return {
    conclusion: 'failure',
    output: {
      title: 'Could not decide',
      summary: `${clip(detail, TITLE_MAX)}\n\nIt decides again on the next push, review or re-run.`,
    },
  };
}

/**
 * The check run where the base branch has no `talos.yml`: neutral, since there are no rules to
 * judge the PR by until the repository's adoption lands.
 */
export function unadoptedFields(base: string): CheckRunFields {
  return {
    conclusion: 'neutral',
    output: {
      title: clip(`Not adopted: talos.yml is not on ${base}`, TITLE_MAX),
      summary: [
        `${base} has no talos.yml, so the repository is not adopted yet and talos/review has no`,
        'rules to judge this PR by. It decides on the next push, review or re-run once the PR',
        `that adds talos.yml has landed on ${base}.`,
      ].join(' '),
    },
  };
}

/** The job's own line about the reviewer's run; never repository content. */
export function reviewerOutcome(run: ReviewerRun): JobOutcome {
  switch (run.kind) {
    case 'reviewed': {
      return {
        job: 'reviewer',
        result: 'done',
        detail: `${run.review.state.toLowerCase()} the head`,
      };
    }
    case 'needs-human': {
      return {
        job: 'reviewer',
        result: 'done',
        detail: 'five rounds already: labelled needs-human',
      };
    }
    case 'no-verdict': {
      return { job: 'reviewer', result: 'failed', detail: `no verdict: ${run.reason}` };
    }
    case 'skipped': {
      return { job: 'reviewer', result: 'skipped', detail: run.reason };
    }
  }
}

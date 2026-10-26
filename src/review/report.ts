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
      ? `The reviewer's third request, not submitted:\n\n${run.body}`
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
        detail: 'two rounds already: labelled needs-human',
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

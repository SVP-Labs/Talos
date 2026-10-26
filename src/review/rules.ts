import type { ClosingIssue } from './types.js';
import { DEPENDABOT } from '../github/identities.js';
import { hasContent, sections } from '../ticket/sections.js';

/** One condition of `talos/review`, met or not, as one short line. */
export type Condition = { readonly met: boolean; readonly line: string };

export type PullText = {
  readonly author: string | undefined;
  readonly headRef: string;
  readonly body: string;
  /** The project's ticket prefix, from `talos.yml`. */
  readonly prefix: string;
  /** `owner/name`, to tell this repository's issues from another's. */
  readonly repo: string;
  readonly closing: readonly ClosingIssue[];
};

/** The sections every PR body carries, as the PR template writes them. */
const HISTORY_SECTIONS: readonly string[] = ['Problem', 'Discussion', 'Solution'];

function issueRef(issue: ClosingIssue, repo: string): string {
  return issue.repo.toLowerCase() === repo.toLowerCase()
    ? `#${issue.number}`
    : `${issue.repo}#${issue.number}`;
}

/** The ticket number a branch names, or `undefined` when it is no `<P>-<N>` ticket branch. */
export function ticketOf(branch: string, prefix: string): number | undefined {
  const match = /^([A-Z][A-Z0-9]*)-([1-9]\d*)$/.exec(branch);
  return match?.[1] === prefix ? Number(match[2]) : undefined;
}

/** The ticket rules: a `<P>-<N>` branch, and a PR that closes `#N` and no other issue. */
export function ticketRule(pull: PullText): Condition {
  if (pull.author === DEPENDABOT) {
    return { met: true, line: 'Dependabot: exempt from the ticket rules' };
  }
  const ticket = ticketOf(pull.headRef, pull.prefix);
  if (ticket === undefined) {
    return { met: false, line: `branch ${pull.headRef} is not a ticket branch ${pull.prefix}-<N>` };
  }
  const refs = pull.closing.map((issue) => issueRef(issue, pull.repo));
  const only = pull.closing.length === 1 ? pull.closing[0] : undefined;
  if (only?.number === ticket && only.repo.toLowerCase() === pull.repo.toLowerCase()) {
    return { met: true, line: `branch ${pull.headRef} closes #${ticket} and no other issue` };
  }
  const closes = refs.length === 0 ? 'closes no issue' : `closes ${refs.join(', ')}`;
  return { met: false, line: `branch ${pull.headRef} ${closes}; it must close #${ticket} only` };
}

/** A section's text without the template's HTML comments. */
function said(text: string | undefined): string | undefined {
  return text?.replaceAll(/<!--[\s\S]*?(?:-->|$)/g, '');
}

/** The PR body's history: Problem, Discussion and Solution, each present and not empty. */
export function historyRule(pull: Pick<PullText, 'author' | 'body'>): Condition {
  if (pull.author === DEPENDABOT) return { met: true, line: 'Dependabot: its PR text is exempt' };
  const found = sections(pull.body);
  const missing = HISTORY_SECTIONS.filter(
    (name) => !hasContent(said(found.get(name.toLowerCase()))),
  );
  if (missing.length === 0) {
    return { met: true, line: 'the PR body has Problem, Discussion and Solution' };
  }
  const names =
    missing.length === 1
      ? missing.join('')
      : `${missing.slice(0, -1).join(', ')} and ${missing.at(-1) ?? ''}`;
  const sectionWord = missing.length === 1 ? 'section is' : 'sections are';
  return { met: false, line: `the PR body's ${names} ${sectionWord} missing or empty` };
}

export function pullRules(pull: PullText): Condition[] {
  return [ticketRule(pull), historyRule(pull)];
}

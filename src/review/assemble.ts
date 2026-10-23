import { ownerApproval } from './approval.js';
import type { DecisionInput, UnattendedFacts } from './conditions.js';
import { lastMove } from './github.js';
import { guardedPaths, protectedPaths } from './guard.js';
import { testIntegrity } from './integrity.js';
import { reviewerState, type ReviewerRun, waitsForPerson } from './reviewer.js';
import { pullRules } from './rules.js';
import { labelSetter, outsideScope, touchedPaths, typeOf } from './scope.js';
import type { ClosingIssue, IssueEvent, Pull, PullCommit, PullFile, Review } from './types.js';
import type { TalosConfig } from '../config/schema.js';
import type { Identities } from '../github/identities.js';
import type { Issue } from '../ticket/schemas.js';

/** Everything `talos/review` reads about one pull request, as read from GitHub. */
export type ReviewFacts = {
  readonly repo: string;
  readonly who: Identities;
  readonly config: TalosConfig;
  readonly agentsOn: boolean;
  readonly pull: Pull;
  readonly files: readonly PullFile[];
  readonly reviews: readonly Review[];
  readonly commits: readonly PullCommit[];
  /** The PR's own events: force-pushes and base changes. */
  readonly pullEvents: readonly IssueEvent[];
  readonly closing: { readonly issues: readonly ClosingIssue[]; readonly total: number };
  /** The one issue the PR closes in this repository, when it closes exactly one. */
  readonly issue: Issue | undefined;
  readonly issueEvents: readonly IssueEvent[];
  /** CODEOWNERS' default owners at the base, or the owner when it names none. */
  readonly owners: readonly string[];
  /** The tool-config extension files the packs declare. */
  readonly extensions: readonly string[];
};

function isTalosRepo(repo: string, who: Identities): boolean {
  return repo.toLowerCase() === who.talosRepo.toLowerCase();
}

/** The one issue the PR closes in this repository, when it closes exactly one. */
export function ticketIssue(
  closing: ReviewFacts['closing'],
  repo: string,
): ClosingIssue | undefined {
  const [only] = closing.issues;
  return closing.total === 1 && only?.repo.toLowerCase() === repo.toLowerCase() ? only : undefined;
}

function unattendedFacts(
  facts: ReviewFacts,
  touched: readonly string[],
  hit: readonly string[],
): UnattendedFacts {
  const { issue, config } = facts;
  const type = issue === undefined ? undefined : typeOf(issue.labels);
  return {
    closingCount: facts.closing.total,
    issue:
      issue === undefined
        ? undefined
        : {
            number: issue.number,
            type,
            setter:
              type === undefined
                ? 'unknown'
                : labelSetter(facts.issueEvents, type, facts.who.reviewer),
          },
    outside:
      issue === undefined || type === undefined
        ? [...touched]
        : outsideScope(touched, issue.body, type),
    guarded: guardedPaths(touched, {
      extensions: facts.extensions,
      briefs: config.docs.briefs,
      glossary: config.docs.glossary,
    }),
    integrity: testIntegrity(facts.files, facts.files.length >= facts.pull.changedFiles),
    protectedPaths: hit,
    isTalos: isTalosRepo(facts.repo, facts.who),
  };
}

/** The decision's input: every condition's facts, from what was read and this run's review. */
export function decisionInput(facts: ReviewFacts, run: ReviewerRun | undefined): DecisionInput {
  const { pull, who } = facts;
  const touched = touchedPaths(facts.files);
  const hit = protectedPaths(touched, facts.config.protected);
  const reviews = run?.kind === 'reviewed' ? [...facts.reviews, run.review] : facts.reviews;
  return {
    rules: pullRules({
      author: pull.author,
      headRef: pull.headRef,
      body: pull.body,
      prefix: facts.config.prefix,
      repo: facts.repo,
      closing: facts.closing.issues,
    }),
    reviewer: reviewerState({
      agentsOn: facts.agentsOn,
      reviews,
      reviewer: who.reviewer,
      head: pull.headSha,
      run,
      waitsForPerson: waitsForPerson(facts),
    }),
    owner: ownerApproval({
      headSha: pull.headSha,
      lastPushAt: lastMove(facts.pullEvents),
      reviews,
      commits: facts.commits,
      commitCount: pull.commits,
      author: pull.author,
      owners: facts.owners.length > 0 ? facts.owners : [who.owner],
      thea: who.thea,
      theaCounts: hit.length === 0 && !isTalosRepo(facts.repo, who),
    }),
    unattended: unattendedFacts(facts, touched, hit),
  };
}

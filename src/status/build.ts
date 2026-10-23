import { loginOf, priorityOf, reviewerVerdict } from './markers.js';
import type { ClaimComment, PullRequestNode, State, Suite } from './query.js';
import {
  type CheckStateName,
  type Claim,
  clip,
  MAX_LISTED,
  MAX_MESSAGE,
  MAX_TITLE,
  MAX_TOP,
  type PullRequestStatus,
  type RepoStatus,
  type SecurityIssue,
  STATUS_SCHEMA,
} from './schema.js';
import { stateOf } from '../github/checks.js';
import type { Identities } from '../github/identities.js';
import { claimantOf, issueOfBranch } from '../ticket/claim.js';
import type { Comment } from '../ticket/schemas.js';
import { asChannel, type Pin } from '../version/pin.js';

/** What the state is built from, besides the GraphQL answer. */
export type StatusInput = {
  readonly repo: string;
  readonly state: State;
  readonly properties: { readonly talos: string | undefined; readonly agents: string | undefined };
  readonly pin: Pin | null;
  readonly version: string | null;
  /** The ticket prefix from `talos.yml`; any `<P>-<N>` branch counts when unknown. */
  readonly prefix: string | undefined;
  /** Claim comments by issue number. */
  readonly comments: ReadonlyMap<number, readonly ClaimComment[]>;
  /** The Talos repository (whose workflows are the gate), the reviewer, and who may claim. */
  readonly who: Identities;
  readonly problems: readonly string[];
};

function isGateSuite(suite: Suite, talosRepo: string, path: string | null): boolean {
  const file = suite.workflowRun?.file;
  if (file === null || file === undefined) return false;
  const name = file.repositoryName.toLowerCase().replace(/^https:\/\/github\.com\//, '');
  return name === talosRepo.toLowerCase() && (path === null || file.path === path);
}

function newest(suites: readonly Suite[]): Suite | undefined {
  return [...suites].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** The gate's state on a commit: its newest run, since a re-run or a later event supersedes. */
export function gateState(
  suites: readonly Suite[],
  talosRepo: string,
  path: string | null,
): CheckStateName {
  const latest = newest(suites.filter((suite) => isGateSuite(suite, talosRepo, path)));
  return latest === undefined ? 'unknown' : stateOf([latest]);
}

/** `talos/review` on a commit, from the reviewer App's newest suite that carries it. */
export function reviewState(suites: readonly Suite[], reviewer: string): CheckStateName {
  const slug = reviewer.replace(/\[bot\]$/, '');
  const latest = newest(
    suites.filter((suite) => suite.app?.slug === slug && suite.review.nodes.length > 0),
  );
  return latest === undefined ? 'unknown' : stateOf(latest.review.nodes);
}

const ANY_TICKET = /^([A-Z][A-Z0-9]{0,5})-[1-9]\d{0,8}$/;

/**
 * The issue a ticket branch `<P>-<N>` names: with the repository's prefix, or any prefix
 * `talos.yml` would accept when it can't be read.
 */
export function issueOf(branch: string, prefix: string | undefined): number | null {
  const effective = prefix ?? ANY_TICKET.exec(branch)?.[1];
  return effective === undefined ? null : (issueOfBranch(effective, branch) ?? null);
}

function asTicketComment(comment: ClaimComment, index: number): Comment {
  return {
    id: index,
    body: comment.body,
    author: loginOf(comment.author) ?? undefined,
    association: comment.authorAssociation,
    createdAt: comment.createdAt,
  };
}

function stageOf(pr: PullRequestNode): PullRequestStatus['stage'] {
  if (pr.isDraft) return 'draft';
  return pr.mergeQueueEntry === null ? 'ready' : 'queued';
}

function pullRequestStatus(pr: PullRequestNode, input: StatusInput): PullRequestStatus {
  const suites = pr.commits.nodes[0]?.commit.checkSuites.nodes ?? [];
  const { who } = input;
  const review = pr.latestReviews.nodes.find((r) => loginOf(r.author) === who.reviewer);
  return {
    number: pr.number,
    title: clip(pr.title, MAX_TITLE),
    branch: pr.headRefName,
    issue: issueOf(pr.headRefName, input.prefix),
    author: loginOf(pr.author),
    stage: stageOf(pr),
    gate: gateState(suites, who.talosRepo, input.pin?.path ?? null),
    review: reviewState(suites, who.reviewer),
    reviewer: review === undefined ? null : reviewerVerdict(review),
    automerge: pr.autoMergeRequest !== null,
  };
}

/** Ticket branches with a positive issue number, in issue order. */
export function claimedBranches(
  branches: readonly string[],
  prefix: string | undefined,
): { readonly branch: string; readonly issue: number }[] {
  return branches
    .flatMap((branch) => {
      const issue = issueOf(branch, prefix);
      return issue === null ? [] : [{ branch, issue }];
    })
    .sort((a, b) => a.issue - b.issue);
}

function claims(input: StatusInput): RepoStatus['claims'] {
  const all = claimedBranches(
    input.state.refs.nodes.map((ref) => ref.name),
    input.prefix,
  );
  const prByBranch = new Map(
    input.state.pullRequests.nodes.map((pr) => [pr.headRefName, pr.number]),
  );
  const items = all.slice(0, MAX_LISTED).map(({ branch, issue }): Claim => {
    const comments = (input.comments.get(issue) ?? []).map(asTicketComment);
    const holder = claimantOf(comments, input.who);
    return {
      branch,
      issue,
      by: holder?.agent ?? null,
      since: holder?.at ?? null,
      pr: prByBranch.get(branch) ?? null,
    };
  });
  return { total: all.length, items };
}

const PRIORITY_ORDER = ['p0', 'p1', 'p2', 'p3'];

function security(state: State): RepoStatus['security'] {
  const issues: SecurityIssue[] = state.security.nodes.map((issue) => ({
    number: issue.number,
    title: clip(issue.title, MAX_TITLE),
    priority: priorityOf(issue.labels?.nodes.map((label) => label.name) ?? []),
  }));
  const rank = (issue: SecurityIssue): number =>
    issue.priority === null ? PRIORITY_ORDER.length : PRIORITY_ORDER.indexOf(issue.priority);
  // The query lists newest first, and the sort is stable, so ties stay newest first.
  const top = [...issues].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_TOP);
  return { open: state.security.totalCount, top };
}

function drift(state: State): RepoStatus['drift'] {
  const [last] = state.lastDrift.nodes;
  return {
    open: state.openDrift.totalCount,
    last:
      last === undefined
        ? null
        : {
            number: last.number,
            date: last.createdAt,
            state: last.state === 'OPEN' ? 'open' : 'closed',
          },
  };
}

function main(input: StatusInput): RepoStatus['main'] {
  const ref = input.state.defaultBranchRef;
  if (ref?.target == null) return null;
  const suites = ref.target.checkSuites.nodes;
  return {
    branch: ref.name,
    sha: ref.target.oid,
    gate: gateState(suites, input.who.talosRepo, input.pin?.path ?? null),
    review: reviewState(suites, input.who.reviewer),
  };
}

/** A repository's `talos.status/1` from what GitHub returned. */
export function buildStatus(input: StatusInput): RepoStatus {
  return {
    schema: STATUS_SCHEMA,
    repo: input.repo,
    channel: asChannel(input.properties.talos) ?? input.pin?.channel ?? null,
    agents: input.properties.agents === 'true',
    pin:
      input.pin === null
        ? null
        : { sha: input.pin.sha, version: input.version, source: input.pin.source },
    main: main(input),
    claims: claims(input),
    prs: {
      total: input.state.pullRequests.totalCount,
      items: input.state.pullRequests.nodes
        .slice(0, MAX_LISTED)
        .map((pr) => pullRequestStatus(pr, input)),
    },
    security: security(input.state),
    debt: { open: input.state.deadCode.totalCount + input.state.otherDebt.totalCount },
    drift: drift(input.state),
    problems: input.problems.slice(0, MAX_TOP).map((problem) => clip(problem, MAX_MESSAGE)),
  };
}

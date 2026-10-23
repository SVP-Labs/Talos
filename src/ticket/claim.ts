import {
  addComment,
  branchHead,
  changeLabels,
  defaultBranch,
  deleteBranch,
  getIssue,
  listComments,
  openPullsFrom,
  refSha,
} from './github.js';
import { LABEL, CLAIM_BLOCKERS } from './labels.js';
import { ticketPayload } from './payload.js';
import type { Comment, Issue } from './schemas.js';
import { carriesApproval, isTrusted } from './trust.js';
import { type GitHub, GitHubError } from '../github/api.js';
import type { Identities } from '../github/identities.js';

/**
 * The claim protocol. The lock is the branch `<P>-<N>`: creating a ref is GitHub's one atomic
 * compare-and-set (a second create answers 422), so two claimants can never both hold a ticket.
 * Labels and comments only mirror the lock for people.
 */
export type Ticketing = {
  readonly gh: GitHub;
  readonly repo: string;
  readonly prefix: string;
  readonly who: Identities;
  readonly now: Date;
};

export function branchFor(prefix: string, issue: number): string {
  return `${prefix}-${issue}`;
}

/** The issue a ticket branch names, or `undefined` for any other branch. */
export function issueOfBranch(prefix: string, branch: string): number | undefined {
  if (!branch.startsWith(`${prefix}-`)) return undefined;
  const rest = branch.slice(prefix.length + 1);
  return /^[1-9]\d{0,8}$/.test(rest) ? Number(rest) : undefined;
}

const AGENT = /^[A-Za-z0-9][\w.-]{0,38}$/;

export function agentProblem(agent: string): string | undefined {
  if (!AGENT.test(agent)) {
    return 'an agent id is 1 to 39 letters, digits, dots, dashes or underscores';
  }
  return carriesApproval(agent) ? 'an agent id may not contain talos-approve' : undefined;
}

export function reasonProblem(reason: string): string | undefined {
  if (reason.trim() === '' || /[\r\n]/.test(reason) || reason.length > 200) {
    return 'a reason is one line of at most 200 characters';
  }
  return carriesApproval(reason) ? 'a reason may not contain talos-approve' : undefined;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function claimLine(agent: string, now: Date): string {
  return `🔒 claimed by ${agent} · ${stamp(now)}`;
}

const CLAIM_LINE = /^🔒 claimed by (\S+) · (\S+)/u;

/** The latest claim comment a trusted author wrote; anyone can type the same words. */
export function claimantOf(
  comments: readonly Comment[],
  who: Identities,
): { agent: string; at: string } | undefined {
  for (const comment of [...comments].reverse()) {
    const match = CLAIM_LINE.exec(comment.body);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    if (!isTrusted({ login: comment.author, association: comment.association }, who)) continue;
    return { agent: match[1], at: match[2] };
  }
  return undefined;
}

/** Refusals about the issue itself, which hold whether or not anyone holds its branch. */
const ISSUE_REFUSALS: ReadonlySet<string> = new Set(['not-found', 'not-an-issue', 'closed']);

/** Why an issue can't be claimed, or `undefined` when it can. */
export function claimRefusal(issue: Issue | undefined): string | undefined {
  if (issue === undefined) return 'not-found';
  if (issue.isPull) return 'not-an-issue';
  if (issue.state === 'closed') return 'closed';
  if (!issue.labels.includes(LABEL.ready)) return 'not-ready';
  return CLAIM_BLOCKERS.find((label) => issue.labels.includes(label));
}

/** The labels a ticket carries once its claim is released. */
export function releasedLabels(issue: Issue): { add: string[]; remove: string[] } {
  const remove = [LABEL.inProgress, LABEL.claimed].filter((l) => issue.labels.includes(l));
  const reopen =
    issue.state === 'open' &&
    !issue.labels.includes(LABEL.ready) &&
    !issue.labels.includes(LABEL.needsSpec) &&
    !issue.labels.includes(LABEL.epic);
  return { add: reopen ? [LABEL.ready] : [], remove };
}

export type ClaimResult =
  | { readonly result: 'claimed'; readonly ticket: Record<string, unknown> }
  | { readonly result: 'taken'; readonly by: string | null }
  | { readonly result: 'refused'; readonly reason: string };

/** Creates the ticket's branch at the default branch's head; `false` when it already exists. */
async function lock(t: Ticketing, branch: string): Promise<boolean> {
  const base = await refSha(t.gh, t.repo, await defaultBranch(t.gh, t.repo));
  try {
    await t.gh.request('POST', `repos/${t.repo}/git/refs`, {
      body: { ref: `refs/heads/${branch}`, sha: base },
    });
    return true;
  } catch (error) {
    const exists =
      error instanceof GitHubError &&
      error.status === 422 &&
      (await branchHead(t.gh, t.repo, branch)) !== undefined;
    if (exists) return false;
    throw error;
  }
}

/** Someone else holds the ticket: the agent a trusted claim comment names, if one does yet. */
async function taken(t: Ticketing, n: number): Promise<ClaimResult> {
  const by = claimantOf(await listComments(t.gh, t.repo, n), t.who)?.agent ?? null;
  return { result: 'taken', by };
}

/**
 * Refuses an issue, unless someone holds it. A claim takes `status/ready` off its ticket, so a
 * held ticket would otherwise read as not ready: an open issue refused for its labels is looked
 * up first, since who holds it is the answer then.
 */
async function refused(t: Ticketing, n: number, reason: string): Promise<ClaimResult> {
  if (!ISSUE_REFUSALS.has(reason)) {
    const held = await branchHead(t.gh, t.repo, branchFor(t.prefix, n));
    if (held !== undefined) return await taken(t, n);
  }
  return { result: 'refused', reason };
}

export async function claim(t: Ticketing, n: number, agent: string): Promise<ClaimResult> {
  const issue = await getIssue(t.gh, t.repo, n);
  const refusal = claimRefusal(issue);
  if (refusal !== undefined || issue === undefined) {
    return await refused(t, n, refusal ?? 'not-found');
  }
  const branch = branchFor(t.prefix, n);
  if (!(await lock(t, branch))) return await taken(t, n);
  const add = [LABEL.inProgress, LABEL.claimed].filter((l) => !issue.labels.includes(l));
  try {
    await changeLabels(t.gh, t.repo, n, { add, remove: [LABEL.ready] });
    await addComment(t.gh, t.repo, n, claimLine(agent, t.now));
  } catch (error) {
    // A claim nobody knows they hold would sit until the stale sweep: give it back at once.
    await deleteBranch(t.gh, t.repo, branch).catch(() => false);
    throw error;
  }
  const labels = [...issue.labels.filter((l) => l !== LABEL.ready), ...add];
  const comments = await listComments(t.gh, t.repo, n);
  return {
    result: 'claimed',
    ticket: { branch, agent, ...ticketPayload({ ...issue, labels }, comments, t.who) },
  };
}

export type ReleaseResult =
  | { readonly result: 'released'; readonly branch: string; readonly deleted: boolean }
  | { readonly result: 'refused'; readonly reason: string; readonly pr?: number };

/** Gives a ticket back: its branch goes, unless a PR is open from it, and it is ready again. */
export async function release(t: Ticketing, n: number, reason: string): Promise<ReleaseResult> {
  const issue = await getIssue(t.gh, t.repo, n);
  if (issue === undefined || issue.isPull) return { result: 'refused', reason: 'not-found' };
  const branch = branchFor(t.prefix, n);
  const open = await openPullsFrom(t.gh, t.repo, branch);
  if (open[0] !== undefined) return { result: 'refused', reason: 'open-pr', pr: open[0].number };
  const deleted = await deleteBranch(t.gh, t.repo, branch);
  await changeLabels(t.gh, t.repo, n, releasedLabels(issue));
  await addComment(t.gh, t.repo, n, `🔓 released: ${reason}`);
  return { result: 'released', branch, deleted };
}

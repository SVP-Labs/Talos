import { claim, type ClaimResult, type Ticketing } from './claim.js';
import { getIssue } from './github.js';
import { LABEL, looksClaimed, priorityOf, CLAIM_BLOCKERS } from './labels.js';
import { type Issue, parseIssues } from './schemas.js';
import { ticketBranches } from './stale.js';

export type OpenClaim = { readonly issue: number; readonly branch: string };

/** The claims held now: ticket branches whose issue is still open. */
export async function openClaims(t: Omit<Ticketing, 'who' | 'now'>): Promise<OpenClaim[]> {
  const claims: OpenClaim[] = [];
  for (const candidate of await ticketBranches(t.gh, t.repo, t.prefix)) {
    const issue = await getIssue(t.gh, t.repo, candidate.issue);
    if (issue !== undefined && !issue.isPull && issue.state === 'open') claims.push(candidate);
  }
  return claims;
}

/** The queue `talos ticket next` works: claimable agent tickets by priority, then age. */
export function queueOrder(issues: readonly Issue[]): Issue[] {
  return issues
    .filter(
      (i) =>
        !i.isPull &&
        i.state === 'open' &&
        i.labels.includes(LABEL.ready) &&
        i.labels.includes(LABEL.eligible) &&
        !looksClaimed(i.labels) &&
        !CLAIM_BLOCKERS.some((label) => i.labels.includes(label)),
    )
    .sort(
      (a, b) =>
        priorityOf(a.labels) - priorityOf(b.labels) ||
        Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
        a.number - b.number,
    );
}

async function queue(t: Ticketing): Promise<Issue[]> {
  const labels = [LABEL.ready, LABEL.eligible].map(encodeURIComponent).join(',');
  const data = await t.gh.paginate<unknown>(`repos/${t.repo}/issues?state=open&labels=${labels}`);
  return queueOrder(parseIssues(data));
}

export type NextResult =
  | (ClaimResult & { readonly result: 'claimed'; readonly issue: number })
  | { readonly result: 'max-claims'; readonly claims: number; readonly max: number }
  | { readonly result: 'empty'; readonly tried: number };

/**
 * Claims the first ticket of the queue that can still be claimed, unless the repository's
 * open claims already reach `agents.max_claims`. Losing a race moves on to the next ticket.
 */
export async function next(t: Ticketing, agent: string, maxClaims: number): Promise<NextResult> {
  const held = await openClaims(t);
  if (held.length >= maxClaims) {
    return { result: 'max-claims', claims: held.length, max: maxClaims };
  }
  const candidates = await queue(t);
  for (const issue of candidates) {
    const outcome = await claim(t, issue.number, agent);
    if (outcome.result === 'claimed') return { ...outcome, issue: issue.number };
  }
  return { result: 'empty', tried: candidates.length };
}

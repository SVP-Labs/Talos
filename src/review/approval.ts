import type { PullCommit, Review } from './types.js';
import { sameLogin } from '../github/identities.js';

/**
 * The owner's approval of a pull request's head, which can come three ways: an APPROVE from a
 * code owner, authorship with every commit signed by the owner, or Thea's `talos-approve` review
 * carrying the okay the owner gave on her card.
 */

export type ApprovalFacts = {
  readonly headSha: string;
  /** When the head last moved other than by a plain push: the latest force-push or base change. */
  readonly lastPushAt: string | undefined;
  readonly reviews: readonly Review[];
  /** The PR's commits as listed, and how many it has (a list stops at 250). */
  readonly commits: readonly PullCommit[];
  readonly commitCount: number;
  readonly author: string | undefined;
  /** The people whose APPROVE counts: CODEOWNERS' default owners. */
  readonly owners: readonly string[];
  /** Thea's App, whose `talos-approve` review stands for the owner's okay. */
  readonly thea: string;
  /** False on a PR touching a protected path, and in the Talos repository. */
  readonly theaCounts: boolean;
};

export type OwnerApproval =
  | { readonly approved: true; readonly line: string }
  | { readonly approved: false; readonly line: string };

const DECIDING: ReadonlySet<string> = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

function time(iso: string | undefined): number {
  return iso === undefined ? Number.NaN : Date.parse(iso);
}

/** Submitted on the head, and after the last push: a later push or base change voids it. */
export function current(review: Review, headSha: string, lastPushAt: string | undefined): boolean {
  if (review.commitId !== headSha) return false;
  const submitted = time(review.submittedAt);
  if (Number.isNaN(submitted)) return false;
  return lastPushAt === undefined || submitted > time(lastPushAt);
}

/** A code owner's latest deciding review is an APPROVE of the head, after the last push. */
function codeOwnerApproval(facts: ApprovalFacts): string | undefined {
  for (const owner of facts.owners) {
    const latest = facts.reviews
      .filter((r) => sameLogin(r.author, owner) && DECIDING.has(r.state))
      .at(-1);
    if (latest?.state === 'APPROVED' && current(latest, facts.headSha, facts.lastPushAt)) {
      return owner;
    }
  }
  return undefined;
}

/** The owner opened it, and every commit is signed and both authored and committed by them. */
function authoredByOwner(facts: ApprovalFacts): boolean {
  const owner = facts.author;
  if (owner === undefined || !facts.owners.some((o) => sameLogin(o, owner))) return false;
  if (facts.commitCount === 0 || facts.commits.length !== facts.commitCount) return false;
  return facts.commits.every(
    (c) => c.verified && sameLogin(c.author, owner) && sameLogin(c.committer, owner),
  );
}

const APPROVE_BODY = /^talos-approve (\S+) ([0-9a-f]{40})$/;

/** The card id of a `talos-approve` review that counts: Thea's, on the head, after the push. */
export function theaCard(review: Review, facts: ApprovalFacts): string | undefined {
  if (!sameLogin(review.author, facts.thea) || review.state !== 'COMMENTED') return undefined;
  const match = APPROVE_BODY.exec(review.body.trim());
  if (match?.[2] !== facts.headSha) return undefined;
  return current(review, facts.headSha, facts.lastPushAt) ? match[1] : undefined;
}

function theaApproval(facts: ApprovalFacts): string | undefined {
  for (const review of [...facts.reviews].reverse()) {
    const card = theaCard(review, facts);
    if (card !== undefined) return card;
  }
  return undefined;
}

export function ownerApproval(facts: ApprovalFacts): OwnerApproval {
  const owner = codeOwnerApproval(facts);
  if (owner !== undefined) {
    return { approved: true, line: `the owner approved: @${owner} on GitHub` };
  }
  if (authoredByOwner(facts)) {
    return {
      approved: true,
      line: `the owner approved: @${facts.author ?? ''} wrote and signed every commit`,
    };
  }
  const card = theaApproval(facts);
  if (card === undefined) return { approved: false, line: 'the owner has not approved the head' };
  if (!facts.theaCounts) {
    return { approved: false, line: "the owner's card doesn't count here: they approve on GitHub" };
  }
  return { approved: true, line: `the owner approved: card ${card} through Thea` };
}

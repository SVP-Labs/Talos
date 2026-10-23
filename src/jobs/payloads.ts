import { z } from 'zod';
import type { Identities } from '../github/identities.js';
import { isTrusted } from '../ticket/trust.js';

/** The parts of the caller's event payloads the jobs read, validated before use. */

const actor = z.object({ login: z.string() }).nullable().optional();

export const issuesEvent = z.object({
  action: z.string(),
  issue: z.object({
    number: z.number().int().positive(),
    user: actor,
    author_association: z.string().optional(),
  }),
  sender: actor,
  repository: z.object({ default_branch: z.string().min(1) }).optional(),
});

const issueCommentEvent = z.object({
  comment: z.object({ user: actor, author_association: z.string().optional() }),
  sender: actor,
});

const reviewEvent = z.object({
  review: z.object({ user: actor, author_association: z.string().optional() }),
  sender: actor,
});

export type Admission =
  { readonly admit: true } | { readonly admit: false; readonly reason: string };

const ADMIT: Admission = { admit: true };

function judgeAuthor(
  author: { login: string | undefined; association: string | undefined },
  who: Identities,
): Admission {
  if (author.login !== undefined && author.login === who.reviewer) {
    return { admit: false, reason: "the reviewer's own event" };
  }
  return isTrusted(author, who) ? ADMIT : { admit: false, reason: 'author not trusted' };
}

/**
 * Whether an event may go on to use the reviewer's token or a model at all. On a public
 * repository a stranger can comment and review, so those two events are admitted only from the
 * owner, a member, a collaborator or Thea's App (whose `talos-approve` reviews carry the owner's
 * okay). Decided from the payload alone, before any API call.
 */
export function admission(event: string, payload: unknown, who: Identities): Admission {
  if (event === 'issue_comment') {
    const parsed = issueCommentEvent.safeParse(payload);
    if (!parsed.success) return { admit: false, reason: 'unreadable payload' };
    const { comment } = parsed.data;
    return judgeAuthor(
      { login: comment.user?.login, association: comment.author_association },
      who,
    );
  }
  if (event === 'pull_request_review') {
    const parsed = reviewEvent.safeParse(payload);
    if (!parsed.success) return { admit: false, reason: 'unreadable payload' };
    const { review } = parsed.data;
    return judgeAuthor({ login: review.user?.login, association: review.author_association }, who);
  }
  return ADMIT;
}

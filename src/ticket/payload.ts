import type { Comment, Issue } from './schemas.js';
import { isTrusted } from './trust.js';
import type { Identities } from '../github/identities.js';

/** The version of every JSON object `talos ticket` prints. */
export const TICKET_SCHEMA = 'talos.ticket/1';

const BODY_MAX = 3000;
const COMMENT_MAX = 300;
const LAST_COMMENTS = 5;

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * What a claim hands the agent: enough to start, small enough for its context. The body is the
 * ticket's spec, so it is clipped far later than a message; the full text stays on GitHub. Each
 * comment says whether its author is trusted, since anyone else's words are data.
 */
export function ticketPayload(
  issue: Issue,
  comments: readonly Comment[],
  who: Identities,
): Record<string, unknown> {
  const recent = comments.slice(-LAST_COMMENTS);
  return {
    number: issue.number,
    title: issue.title,
    labels: [...issue.labels],
    body: clip(issue.body, BODY_MAX),
    bodyTruncated: issue.body.length > BODY_MAX,
    comments: recent.map((c) => ({
      author: c.author ?? null,
      trusted: isTrusted({ login: c.author, association: c.association }, who),
      at: c.createdAt,
      body: clip(c.body, COMMENT_MAX),
    })),
    commentsTotal: comments.length,
  };
}

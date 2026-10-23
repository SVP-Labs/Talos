import type { Actor } from './query.js';
import type { ReviewerVerdict } from './schema.js';

/** A login as REST spells it: GraphQL drops the `[bot]` an App's login carries. */
export function loginOf(actor: Actor): string | null {
  if (actor === null) return null;
  return actor.__typename === 'Bot' ? `${actor.login}[bot]` : actor.login;
}

const REVIEW_STATES: Readonly<Record<string, ReviewerVerdict['verdict']>> = {
  APPROVED: 'APPROVE',
  CHANGES_REQUESTED: 'REQUEST_CHANGES',
  COMMENTED: 'COMMENT',
};

/** The `key=value` fields of a marker line such as `talos-review/1 verdict=APPROVE round=1`. */
export function markerFields(text: string, marker: string): Record<string, string> | undefined {
  const [first = ''] = text.trimStart().split('\n', 1);
  const words = first.trim().split(/\s+/);
  if (words[0] !== marker) return undefined;
  const fields: Record<string, string> = {};
  for (const word of words.slice(1)) {
    const match = /^([a-z]+)=(\S+)$/.exec(word);
    if (match?.[1] !== undefined && match[2] !== undefined) fields[match[1]] = match[2];
  }
  return fields;
}

function countField(value: string | undefined): number | null {
  return value !== undefined && /^\d{1,4}$/.test(value) ? Number(value) : null;
}

function asVerdict(value: string | undefined): ReviewerVerdict['verdict'] | undefined {
  return value === 'APPROVE' || value === 'REQUEST_CHANGES' || value === 'COMMENT'
    ? value
    : undefined;
}

/**
 * The reviewer's verdict from its review: the `talos-review/1` line when it opens the review,
 * else the review's own state.
 */
export function reviewerVerdict(review: {
  readonly state: string;
  readonly body: string;
}): ReviewerVerdict | null {
  const fields = markerFields(review.body, 'talos-review/1');
  const verdict = asVerdict(fields?.verdict) ?? REVIEW_STATES[review.state];
  if (verdict === undefined) return null;
  return { verdict, round: countField(fields?.round), findings: countField(fields?.findings) };
}

const PRIORITY = /^(?:priority\/)?(p[0-3])$/;

/** An issue's priority from its labels (`priority/p0` … `priority/p3`). */
export function priorityOf(labels: readonly string[]): 'p0' | 'p1' | 'p2' | 'p3' | null {
  for (const label of labels) {
    const value = PRIORITY.exec(label)?.[1];
    if (value === 'p0' || value === 'p1' || value === 'p2' || value === 'p3') return value;
  }
  return null;
}

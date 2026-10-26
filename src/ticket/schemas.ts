import { z } from 'zod';

/**
 * The parts of GitHub's REST responses the claim protocol and the jobs rely on, validated before
 * use. Unknown fields are dropped; a missing one is an error, never a guess.
 */

const user = z.object({ login: z.string(), type: z.string().optional() }).nullable().optional();

const label = z.union([z.string(), z.object({ name: z.string() })]);

const rawIssue = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable().optional(),
  state: z.enum(['open', 'closed']),
  state_reason: z.string().nullable().optional(),
  labels: z.array(label),
  user,
  author_association: z.string().optional(),
  created_at: z.string(),
  closed_at: z.string().nullable().optional(),
  pull_request: z.unknown().optional(),
});

export type Issue = {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: 'open' | 'closed';
  readonly stateReason: string | undefined;
  readonly labels: readonly string[];
  readonly author: string | undefined;
  readonly association: string | undefined;
  readonly createdAt: string;
  readonly closedAt: string | undefined;
  /** The issues endpoints list pull requests too. */
  readonly isPull: boolean;
};

function toIssue(raw: z.infer<typeof rawIssue>): Issue {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? '',
    state: raw.state,
    stateReason: raw.state_reason ?? undefined,
    labels: raw.labels.map((l) => (typeof l === 'string' ? l : l.name)),
    author: raw.user?.login,
    association: raw.author_association,
    createdAt: raw.created_at,
    closedAt: raw.closed_at ?? undefined,
    isPull: raw.pull_request !== undefined && raw.pull_request !== null,
  };
}

export function parseIssue(data: unknown): Issue {
  return toIssue(rawIssue.parse(data));
}

export function parseIssues(data: unknown): Issue[] {
  return z.array(rawIssue).parse(data).map(toIssue);
}

const rawComment = z.object({
  id: z.number().int(),
  body: z.string().nullable().optional(),
  user,
  author_association: z.string().optional(),
  created_at: z.string(),
});

export type Comment = {
  readonly id: number;
  readonly body: string;
  readonly author: string | undefined;
  readonly association: string | undefined;
  readonly createdAt: string;
};

export function parseComments(data: unknown): Comment[] {
  return z
    .array(rawComment)
    .parse(data)
    .map((c) => ({
      id: c.id,
      body: c.body ?? '',
      author: c.user?.login,
      association: c.author_association,
      createdAt: c.created_at,
    }));
}

export const refSchema = z.object({ ref: z.string(), object: z.object({ sha: z.string() }) });

export const repoSchema = z.object({ default_branch: z.string().min(1) });

export const branchSchema = z.object({
  commit: z.object({
    sha: z.string(),
    commit: z.object({
      committer: z.object({ date: z.string().optional() }).nullable().optional(),
    }),
  }),
});

const rawPull = z.object({
  number: z.number().int().positive(),
  draft: z.boolean().optional(),
  state: z.enum(['open', 'closed']),
  updated_at: z.string(),
  head: z.object({ ref: z.string() }),
});

export type Pull = {
  readonly number: number;
  readonly draft: boolean;
  readonly state: 'open' | 'closed';
  readonly updatedAt: string;
  readonly headRef: string;
};

export function parsePulls(data: unknown): Pull[] {
  return z
    .array(rawPull)
    .parse(data)
    .map((p) => ({
      number: p.number,
      draft: p.draft ?? false,
      state: p.state,
      updatedAt: p.updated_at,
      headRef: p.head.ref,
    }));
}

/** Timeline items differ by kind; only `labeled` events are read. */
export const timelineSchema = z.array(
  z.object({
    event: z.string().optional(),
    created_at: z.string().optional(),
    label: z.object({ name: z.string() }).optional(),
  }),
);

export const contentsFileSchema = z.object({
  type: z.literal('file'),
  encoding: z.literal('base64'),
  content: z.string(),
});

export const labelListSchema = z.array(
  z.object({
    name: z.string(),
    color: z.string(),
    description: z.string().nullable().optional(),
  }),
);

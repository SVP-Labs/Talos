import { z } from 'zod';
import type { ClosingIssue, IssueEvent, Pull, PullCommit, PullFile, Review } from './types.js';
import type { GitHub } from '../github/api.js';
import { propertyValuesSchema } from '../github/repos.js';

/**
 * The REST and GraphQL reads `talos/review` makes, and the review it submits. Each validates
 * what it relies on; unknown fields are dropped and a missing one is an error, never a guess.
 */

const user = z.object({ login: z.string(), type: z.string().optional() }).nullable().optional();

const pullSchema = z.object({
  number: z.number().int().positive(),
  state: z.string(),
  draft: z.boolean().optional(),
  title: z.string(),
  body: z.string().nullable().optional(),
  user,
  author_association: z.string().optional(),
  head: z.object({ sha: z.string(), ref: z.string() }),
  base: z.object({ ref: z.string() }),
  commits: z.number().int().nonnegative(),
  changed_files: z.number().int().nonnegative(),
  labels: z.array(z.object({ name: z.string() })).default([]),
});

export async function getPull(gh: GitHub, repo: string, n: number): Promise<Pull> {
  const raw = pullSchema.parse(await gh.request<unknown>('GET', `repos/${repo}/pulls/${n}`));
  return {
    number: raw.number,
    state: raw.state,
    draft: raw.draft ?? false,
    title: raw.title,
    body: raw.body ?? '',
    author: raw.user?.login,
    association: raw.author_association,
    headSha: raw.head.sha,
    headRef: raw.head.ref,
    baseRef: raw.base.ref,
    commits: raw.commits,
    changedFiles: raw.changed_files,
    labels: raw.labels.map((label) => label.name),
  };
}

const fileSchema = z.object({
  filename: z.string(),
  status: z.string(),
  previous_filename: z.string().optional(),
  changes: z.number().int().nonnegative(),
  patch: z.string().optional(),
});

/** The PR's changed files with their patches; GitHub lists at most 3000. */
export async function listPullFiles(gh: GitHub, repo: string, n: number): Promise<PullFile[]> {
  const raw = await gh.paginate<unknown>(`repos/${repo}/pulls/${n}/files`);
  return z
    .array(fileSchema)
    .parse(raw)
    .map((file) => ({
      path: file.filename,
      status: file.status,
      previousPath: file.previous_filename,
      changes: file.changes,
      patch: file.patch,
    }));
}

const reviewSchema = z.object({
  user,
  state: z.string(),
  commit_id: z.string().nullable().optional(),
  submitted_at: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
});

function toReview(raw: z.infer<typeof reviewSchema>): Review {
  return {
    author: raw.user?.login,
    state: raw.state,
    commitId: raw.commit_id ?? undefined,
    submittedAt: raw.submitted_at ?? undefined,
    body: raw.body ?? '',
  };
}

/** Every review on the PR, oldest first. */
export async function listReviews(gh: GitHub, repo: string, n: number): Promise<Review[]> {
  const raw = await gh.paginate<unknown>(`repos/${repo}/pulls/${n}/reviews`);
  return z.array(reviewSchema).parse(raw).map(toReview);
}

const commitSchema = z.object({
  sha: z.string(),
  commit: z.object({
    verification: z.object({ verified: z.boolean() }).nullable().optional(),
  }),
  author: user,
  committer: user,
});

/** The PR's commits; GitHub lists at most 250. */
export async function listPullCommits(gh: GitHub, repo: string, n: number): Promise<PullCommit[]> {
  const raw = await gh.paginate<unknown>(`repos/${repo}/pulls/${n}/commits`);
  return z
    .array(commitSchema)
    .parse(raw)
    .map((c) => ({
      sha: c.sha,
      verified: c.commit.verification?.verified === true,
      author: c.author?.login,
      committer: c.committer?.login,
    }));
}

const eventSchema = z.object({
  event: z.string(),
  label: z.object({ name: z.string() }).nullable().optional(),
  actor: user,
  created_at: z.string().nullable().optional(),
});

/** An issue's or a PR's events, oldest first: labelling, force-pushes, base changes. */
export async function listIssueEvents(gh: GitHub, repo: string, n: number): Promise<IssueEvent[]> {
  const raw = await gh.paginate<unknown>(`repos/${repo}/issues/${n}/events`);
  return z
    .array(eventSchema)
    .parse(raw)
    .map((e) => ({
      event: e.event,
      label: e.label?.name,
      actor: e.actor?.login,
      actorType: e.actor?.type,
      createdAt: e.created_at ?? undefined,
    }));
}

const propertySchema = propertyValuesSchema;

export type RepoProperties = {
  /** The `talos-agents` property is on. */
  readonly agentsOn: boolean;
  /** The `talos` property names `canary` or `stable`; at `evaluate`, or unset, it doesn't. */
  readonly onChannel: boolean;
};

const ON_CHANNEL: ReadonlySet<string> = new Set(['canary', 'stable']);

/**
 * The repository's `talos-agents` and `talos` properties. Read from the properties endpoint,
 * which refuses a token that can't see them, rather than from the repository's own record, which
 * leaves them out silently and would read as off and at `evaluate`.
 */
export async function repoProperties(gh: GitHub, repo: string): Promise<RepoProperties> {
  const raw = await gh.request<unknown>('GET', `repos/${repo}/properties/values`);
  const values = propertySchema.parse(raw);
  const value = (name: string) => values.find((p) => p.property_name === name)?.value;
  const channel = value('talos');
  return {
    agentsOn: value('talos-agents') === 'true',
    onChannel: typeof channel === 'string' && ON_CHANNEL.has(channel),
  };
}

const MOVES: ReadonlySet<string> = new Set(['head_ref_force_pushed', 'base_ref_changed']);

/**
 * When the PR's head last moved in a way its sha alone doesn't show: a force-push (which can
 * bring back a commit reviewed before) or a change of base (which changes the diff).
 */
export function lastMove(events: readonly IssueEvent[]): string | undefined {
  let latest: string | undefined;
  for (const event of events) {
    const at = event.createdAt;
    if (!MOVES.has(event.event) || at === undefined) continue;
    if (latest === undefined || Date.parse(at) > Date.parse(latest)) latest = at;
  }
  return latest;
}

const CLOSING_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      closingIssuesReferences(first: 10) {
        totalCount
        nodes { number repository { nameWithOwner } }
      }
    }
  }
}`;

const closingSchema = z.object({
  repository: z
    .object({
      pullRequest: z
        .object({
          closingIssuesReferences: z.object({
            totalCount: z.number().int().nonnegative(),
            nodes: z.array(
              z
                .object({
                  number: z.number().int().positive(),
                  repository: z.object({ nameWithOwner: z.string() }),
                })
                .nullable(),
            ),
          }),
        })
        .nullable(),
    })
    .nullable(),
});

/** The issues the PR closes when it merges, as GitHub links them, and how many there are. */
export async function closingIssues(
  gh: GitHub,
  repo: string,
  n: number,
): Promise<{ readonly issues: ClosingIssue[]; readonly total: number }> {
  const [owner = '', name = ''] = repo.split('/');
  const data = closingSchema.parse(
    await gh.graphql<unknown>(CLOSING_QUERY, { owner, name, number: n }),
  );
  const refs = data.repository?.pullRequest?.closingIssuesReferences;
  if (refs === undefined) return { issues: [], total: 0 };
  const issues = refs.nodes.flatMap((node) =>
    node === null ? [] : [{ number: node.number, repo: node.repository.nameWithOwner }],
  );
  return { issues, total: Math.max(refs.totalCount, issues.length) };
}

export type ReviewComment = { readonly path: string; readonly line: number; readonly body: string };

export type ReviewSubmission = {
  readonly commitId: string;
  readonly event: 'APPROVE' | 'REQUEST_CHANGES';
  readonly body: string;
  readonly comments: readonly ReviewComment[];
};

/** Submits a review with its inline comments, each on the head's side of the diff. */
export async function submitReview(
  gh: GitHub,
  repo: string,
  n: number,
  review: ReviewSubmission,
): Promise<Review> {
  const raw = await gh.request<unknown>('POST', `repos/${repo}/pulls/${n}/reviews`, {
    body: {
      commit_id: review.commitId,
      event: review.event,
      body: review.body,
      comments: review.comments.map((c) => ({
        path: c.path,
        line: c.line,
        side: 'RIGHT',
        body: c.body,
      })),
    },
  });
  return toReview(reviewSchema.parse(raw));
}

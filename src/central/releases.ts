import { z } from 'zod';
import {
  REGRESSION_LABEL,
  type Regression,
  type RegressionIssue,
  regressionOf,
  type Release,
  releasesOf,
} from './channels.js';
import type { GitHub } from '../github/api.js';
import { parseIssues } from '../ticket/schemas.js';

/**
 * What the Talos repository says about its releases: its tags, whether each is on `main`, and
 * its `regression` issues. Talos is public, so the workflow's own token reads all of it.
 */

const commitTarget = z.object({
  __typename: z.literal('Commit'),
  oid: z.string(),
  committedDate: z.string(),
});

const tagTarget = z.object({
  __typename: z.literal('Tag'),
  tagger: z.object({ date: z.string().nullable() }).nullable(),
  target: z.object({ oid: z.string(), committedDate: z.string() }),
});

const otherTarget = z.object({ __typename: z.string(), oid: z.string() });

const tagsPage = z.object({
  repository: z.object({
    refs: z.object({
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
      nodes: z.array(
        z.object({ name: z.string(), target: z.union([commitTarget, tagTarget, otherTarget]) }),
      ),
    }),
  }),
});

const TAGS_QUERY = `
query TalosTags($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    refs(refPrefix: "refs/tags/", first: 100, after: $after,
         orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        target {
          __typename
          oid
          ... on Commit { committedDate }
          ... on Tag { tagger { date } target { oid ... on Commit { committedDate } } }
        }
      }
    }
  }
}`;

const TAG_PAGES = 3;

type Node = z.infer<typeof tagsPage>['repository']['refs']['nodes'][number];

/** A tag's commit and when it was made; a tag of anything but a commit is no release. */
export function tagOf(node: Node): { name: string; sha: string; taggedAt: string } | undefined {
  const parsedCommit = commitTarget.safeParse(node.target);
  if (parsedCommit.success) {
    const { oid, committedDate } = parsedCommit.data;
    return { name: node.name, sha: oid, taggedAt: committedDate };
  }
  const parsedTag = tagTarget.safeParse(node.target);
  if (!parsedTag.success) return undefined;
  const { tagger, target } = parsedTag.data;
  return { name: node.name, sha: target.oid, taggedAt: tagger?.date ?? target.committedDate };
}

function ownerAndName(repo: string): { owner: string; name: string } {
  const [owner = '', name = ''] = repo.split('/');
  return { owner, name };
}

/** The repository's releases, newest version first. */
export async function readReleases(gh: GitHub, repo: string): Promise<Release[]> {
  const tags: { name: string; sha: string; taggedAt: string }[] = [];
  let after: string | null = null;
  for (let page = 0; page < TAG_PAGES; page += 1) {
    const data = tagsPage.parse(
      await gh.graphql<unknown>(TAGS_QUERY, { ...ownerAndName(repo), after }),
    );
    const { nodes, pageInfo } = data.repository.refs;
    tags.push(...nodes.flatMap((node) => tagOf(node) ?? []));
    if (!pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
  }
  return releasesOf(tags);
}

const compareSchema = z.object({ status: z.string() });

/** Whether `sha` is in `branch`'s history: comparing it with the branch finds the branch ahead. */
export async function isAncestor(
  gh: GitHub,
  repo: string,
  sha: string,
  branch: string,
): Promise<boolean> {
  const raw = await gh.request<unknown>(
    'GET',
    `repos/${repo}/compare/${sha}...${encodeURIComponent(branch)}`,
  );
  const { status } = compareSchema.parse(raw);
  return status === 'ahead' || status === 'identical';
}

const CANDIDATES = 10;

/**
 * The newest releases whose commit is on `branch`, newest first. Rollback goes back one release
 * at a time, so the newest few are all a decision ever needs.
 */
export async function releasesOnBranch(
  gh: GitHub,
  repo: string,
  releases: readonly Release[],
  branch: string,
): Promise<Release[]> {
  const candidates = releases.slice(0, CANDIDATES);
  const onBranch = await Promise.all(candidates.map((r) => isAncestor(gh, repo, r.sha, branch)));
  return candidates.filter((_release, index) => onBranch[index] === true);
}

const eventSchema = z.object({
  event: z.string(),
  label: z.object({ name: z.string() }).nullable().optional(),
  actor: z.object({ login: z.string() }).nullable().optional(),
  created_at: z.string(),
});

/** Who put which label on an issue, and when. */
export function labelledEvents(raw: unknown): RegressionIssue['labelled'] {
  return z
    .array(eventSchema)
    .parse(raw)
    .flatMap((event) =>
      event.event === 'labeled' && event.label != null
        ? [{ label: event.label.name, actor: event.actor?.login, at: event.created_at }]
        : [],
    );
}

const MAX_REGRESSIONS = 50;

/** The repository's `regression` issues, open or closed, that a trusted actor raised. */
export async function readRegressions(
  gh: GitHub,
  repo: string,
  trusted: readonly string[],
): Promise<Regression[]> {
  const raw = await gh.paginate<unknown>(
    `repos/${repo}/issues?state=all&labels=${encodeURIComponent(REGRESSION_LABEL)}`,
  );
  const issues = parseIssues(raw)
    .filter((issue) => !issue.isPull)
    .slice(0, MAX_REGRESSIONS);
  const regressions = await Promise.all(
    issues.map(async (issue) => {
      const events = await gh.paginate<unknown>(`repos/${repo}/issues/${issue.number}/events`);
      return regressionOf(
        {
          number: issue.number,
          author: issue.author,
          open: issue.state === 'open',
          stateReason: issue.stateReason,
          labels: issue.labels,
          createdAt: issue.createdAt,
          labelled: labelledEvents(events),
        },
        trusted,
      );
    }),
  );
  return regressions.filter((r): r is Regression => r !== undefined);
}

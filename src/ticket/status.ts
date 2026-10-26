import { z } from 'zod';
import { branchFor, claimantOf, type Ticketing } from './claim.js';
import { branchHead, getIssue, listComments } from './github.js';

/** Where a PR stands, in the words `talos status` uses too. */
export type PullStage = 'draft' | 'ready' | 'queued' | 'merged' | 'closed';

export type ChecksState = 'green' | 'red' | 'pending' | 'none';

const pullNode = z.object({
  number: z.number().int().positive(),
  isDraft: z.boolean(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  mergeQueueEntry: z.object({ state: z.string() }).nullable().optional(),
  commits: z.object({
    nodes: z.array(
      z.object({
        commit: z.object({
          statusCheckRollup: z.object({ state: z.string() }).nullable().optional(),
        }),
      }),
    ),
  }),
});

type PullNode = z.infer<typeof pullNode>;

const pullQuery = z.object({
  repository: z.object({ pullRequests: z.object({ nodes: z.array(pullNode) }) }).nullable(),
});

const QUERY = `query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $branch, first: 1, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        number isDraft state
        mergeQueueEntry { state }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

export function pullStage(pr: {
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED';
  readonly isDraft: boolean;
  readonly inQueue: boolean;
}): PullStage {
  if (pr.state === 'MERGED') return 'merged';
  if (pr.state === 'CLOSED') return 'closed';
  if (pr.isDraft) return 'draft';
  return pr.inQueue ? 'queued' : 'ready';
}

/** GitHub's combined state of every check and status on a commit. */
export function checksState(rollup: string | undefined): ChecksState {
  switch (rollup) {
    case 'SUCCESS': {
      return 'green';
    }
    case 'FAILURE':
    case 'ERROR': {
      return 'red';
    }
    case 'PENDING':
    case 'EXPECTED': {
      return 'pending';
    }
    default: {
      return 'none';
    }
  }
}

function describePull(node: PullNode): { number: number; stage: PullStage; checks: ChecksState } {
  const rollup = node.commits.nodes[0]?.commit.statusCheckRollup?.state;
  return {
    number: node.number,
    stage: pullStage({
      state: node.state,
      isDraft: node.isDraft,
      inQueue: node.mergeQueueEntry !== undefined && node.mergeQueueEntry !== null,
    }),
    checks: checksState(rollup),
  };
}

async function latestPull(
  t: Ticketing,
  branch: string,
): Promise<ReturnType<typeof describePull> | null> {
  const [owner, name] = t.repo.split('/');
  const data = pullQuery.parse(await t.gh.graphql<unknown>(QUERY, { owner, name, branch }));
  const node = data.repository?.pullRequests.nodes[0];
  return node === undefined ? null : describePull(node);
}

/** A ticket's claim, branch and PR, as `talos ticket status` prints them. */
export async function ticketStatus(t: Ticketing, n: number): Promise<Record<string, unknown>> {
  const branch = branchFor(t.prefix, n);
  const issue = await getIssue(t.gh, t.repo, n);
  const head = await branchHead(t.gh, t.repo, branch);
  const claimant =
    head === undefined ? undefined : claimantOf(await listComments(t.gh, t.repo, n), t.who);
  return {
    result: 'status',
    issue: n,
    branch,
    state: issue?.state ?? null,
    labels: issue === undefined ? [] : [...issue.labels],
    claimed: head !== undefined,
    agent: claimant?.agent ?? null,
    since: claimant?.at ?? null,
    lastCommit: head === undefined ? null : { sha: head.sha, date: head.date ?? null },
    pr: await latestPull(t, branch),
  };
}

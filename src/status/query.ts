import { z } from 'zod';

/** The labels the state reads. */
const LABELS = {
  security: 'security',
  debt: ['debt/dead-code', 'debt/other'],
  drift: 'drift',
} as const;

const SUITE = `
fragment Suite on CheckSuite {
  createdAt
  status
  conclusion
  app { slug }
  workflowRun { file { path repositoryName } }
  review: checkRuns(first: 1, filterBy: { checkName: "talos/review" }) {
    nodes { status conclusion }
  }
}`;

/** One query for everything but the claim comments. */
export const STATE_QUERY = `
query TalosState($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    talosYml: object(expression: "HEAD:talos.yml") { ... on Blob { text } }
    defaultBranchRef {
      name
      target { ... on Commit { oid checkSuites(last: 20) { nodes { ...Suite } } } }
    }
    refs(
      refPrefix: "refs/heads/"
      first: 100
      orderBy: { field: TAG_COMMIT_DATE, direction: DESC }
    ) {
      totalCount
      nodes { name }
    }
    pullRequests(states: OPEN, first: 50, orderBy: { field: CREATED_AT, direction: DESC }) {
      totalCount
      nodes {
        number
        title
        isDraft
        headRefName
        author { __typename login }
        mergeQueueEntry { position }
        autoMergeRequest { enabledAt }
        latestReviews(first: 10) { nodes { author { __typename login } state body } }
        commits(last: 1) { nodes { commit { checkSuites(last: 20) { nodes { ...Suite } } } } }
      }
    }
    security: issues(
      states: OPEN
      labels: ["${LABELS.security}"]
      first: 20
      orderBy: { field: CREATED_AT, direction: DESC }
    ) {
      totalCount
      nodes { number title labels(first: 20) { nodes { name } } }
    }
    deadCode: issues(states: OPEN, labels: ["${LABELS.debt[0]}"]) { totalCount }
    otherDebt: issues(states: OPEN, labels: ["${LABELS.debt[1]}"]) { totalCount }
    openDrift: issues(states: OPEN, labels: ["${LABELS.drift}"]) { totalCount }
    lastDrift: issues(
      labels: ["${LABELS.drift}"]
      first: 1
      orderBy: { field: CREATED_AT, direction: DESC }
    ) {
      nodes { number createdAt state }
    }
  }
}
${SUITE}`;

/** The comments of each claimed issue, newest last; issue numbers are integers we produced. */
export function claimsQuery(issues: readonly number[]): string {
  const fields = issues.map(
    (n) =>
      `i${n}: issue(number: ${n}) { comments(last: 30) { nodes { ` +
      `author { __typename login } authorAssociation body createdAt } } }`,
  );
  return `query TalosClaims($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    ${fields.join('\n    ')}
  }
}`;
}

const actor = z.object({ __typename: z.string(), login: z.string() }).nullable();

const suite = z.object({
  createdAt: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  app: z.object({ slug: z.string() }).nullable(),
  workflowRun: z
    .object({ file: z.object({ path: z.string(), repositoryName: z.string() }).nullable() })
    .nullable(),
  review: z.object({
    nodes: z.array(z.object({ status: z.string(), conclusion: z.string().nullable() })),
  }),
});

const suites = z.object({ nodes: z.array(suite) });

const pullRequest = z.object({
  number: z.number().int(),
  title: z.string(),
  isDraft: z.boolean(),
  headRefName: z.string(),
  author: actor,
  mergeQueueEntry: z.object({ position: z.number().int() }).nullable(),
  autoMergeRequest: z.object({ enabledAt: z.string().nullable() }).nullable(),
  latestReviews: z.object({
    nodes: z.array(z.object({ author: actor, state: z.string(), body: z.string() })),
  }),
  commits: z.object({ nodes: z.array(z.object({ commit: z.object({ checkSuites: suites }) })) }),
});

const total = z.object({ totalCount: z.number().int() });

export const stateSchema = z.object({
  repository: z.object({
    talosYml: z.object({ text: z.string().nullable().optional() }).nullable(),
    defaultBranchRef: z
      .object({
        name: z.string(),
        target: z.object({ oid: z.string(), checkSuites: suites }).nullable(),
      })
      .nullable(),
    refs: z.object({
      totalCount: z.number().int(),
      nodes: z.array(z.object({ name: z.string() })),
    }),
    pullRequests: total.extend({ nodes: z.array(pullRequest) }),
    security: total.extend({
      nodes: z.array(
        z.object({
          number: z.number().int(),
          title: z.string(),
          labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }).nullable(),
        }),
      ),
    }),
    deadCode: total,
    otherDebt: total,
    openDrift: total,
    lastDrift: z.object({
      nodes: z.array(
        z.object({ number: z.number().int(), createdAt: z.string(), state: z.string() }),
      ),
    }),
  }),
});

const comment = z.object({
  author: actor,
  authorAssociation: z.string(),
  body: z.string(),
  createdAt: z.string(),
});

export const claimsSchema = z.object({
  repository: z.record(
    z.string(),
    z.object({ comments: z.object({ nodes: z.array(comment) }) }).nullable(),
  ),
});

export type State = z.infer<typeof stateSchema>['repository'];
export type Suite = z.infer<typeof suite>;
export type PullRequestNode = z.infer<typeof pullRequest>;
export type Actor = z.infer<typeof actor>;
export type ClaimComment = z.infer<typeof comment>;

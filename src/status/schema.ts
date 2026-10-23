import { z } from 'zod';

export const STATUS_SCHEMA = 'talos.status/1';

/** Lists are cut here and carry their total. */
export const MAX_LISTED = 20;
/** Security issues listed by priority. */
export const MAX_TOP = 5;
export const MAX_TITLE = 100;
export const MAX_MESSAGE = 200;

const count = z.number().int().min(0);
const number = z.number().int().positive();
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const title = z.string().max(MAX_TITLE);
const timestamp = z.string().describe('ISO 8601 date and time');

const checkState = z
  .enum(['green', 'red', 'pending', 'unknown'])
  .describe('red when any run failed, pending while any runs, unknown when none ran');

function capped<T extends z.ZodType>(item: T) {
  return z.strictObject({ total: count, items: z.array(item).max(MAX_LISTED) });
}

const claim = z.strictObject({
  branch: z.string().describe('the ticket branch <P>-<N>: the claim itself'),
  issue: number,
  by: z.string().nullable().describe('the agent or person named by the claim comment'),
  since: timestamp.nullable(),
  pr: number.nullable().describe('the open PR from the branch'),
});

const reviewer = z.strictObject({
  verdict: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']),
  round: count.nullable(),
  findings: count.nullable(),
});

const pullRequest = z.strictObject({
  number,
  title,
  branch: z.string(),
  issue: number.nullable().describe('the ticket the branch names'),
  author: z.string().nullable(),
  stage: z.enum(['draft', 'ready', 'queued']),
  gate: checkState.describe("the Talos gate's latest run on the PR's head"),
  review: checkState.describe('the talos/review check on the head'),
  reviewer: reviewer.nullable().describe("talos-reviewer's latest review (talos-review/1 line)"),
  automerge: z.boolean(),
});

const securityIssue = z.strictObject({
  number,
  title,
  priority: z.enum(['p0', 'p1', 'p2', 'p3']).nullable(),
});

const card = z.strictObject({
  id: z.string(),
  pr: number.nullable(),
  title,
  since: timestamp,
});

export const repoStatusSchema = z
  .strictObject({
    schema: z.literal(STATUS_SCHEMA),
    repo: z.string().describe('owner/name'),
    channel: z.enum(['evaluate', 'canary', 'stable']).nullable(),
    agents: z.boolean().describe('whether the talos-agents property lets agents work here'),
    pin: z
      .strictObject({ sha, version: z.string().nullable(), source: z.string() })
      .nullable()
      .describe('the enforced Talos release; null when no single pin was found'),
    main: z
      .strictObject({ branch: z.string(), sha, gate: checkState, review: checkState })
      .nullable(),
    claims: capped(claim),
    prs: capped(pullRequest),
    security: z.strictObject({ open: count, top: z.array(securityIssue).max(MAX_TOP) }),
    debt: z.strictObject({ open: count.describe('open debt/dead-code and debt/other issues') }),
    drift: z.strictObject({
      open: count,
      last: z
        .strictObject({ number, date: timestamp, state: z.enum(['open', 'closed']) })
        .nullable(),
    }),
    problems: z
      .array(z.string().max(MAX_MESSAGE))
      .max(MAX_TOP)
      .describe('what could not be read; the rest of the object still holds'),
    cards: capped(card)
      .optional()
      .describe("added by Thea's hub: approval cards waiting on the owner; Talos never sets it"),
  })
  .describe("one governed repository's state");

export const statusErrorSchema = z
  .strictObject({
    schema: z.literal(STATUS_SCHEMA),
    repo: z.string(),
    error: z.string().max(MAX_MESSAGE),
  })
  .describe('a repository whose state could not be read');

/** One element of `talos status --json`'s array. */
export const statusSchema = z
  .union([repoStatusSchema, statusErrorSchema])
  .meta({ title: STATUS_SCHEMA, description: "A governed repository's current state" });

export type RepoStatus = z.infer<typeof repoStatusSchema>;
export type StatusError = z.infer<typeof statusErrorSchema>;
export type Status = z.infer<typeof statusSchema>;
export type CheckStateName = z.infer<typeof checkState>;
export type Claim = z.infer<typeof claim>;
export type PullRequestStatus = z.infer<typeof pullRequest>;
export type ReviewerVerdict = z.infer<typeof reviewer>;
export type SecurityIssue = z.infer<typeof securityIssue>;

/** The JSON Schema of `talos.status/1`, as `docs/contracts/status.schema.json` holds it. */
export function statusJsonSchema(): Record<string, unknown> {
  return {
    $id: 'https://github.com/SVP-Labs/Talos/blob/main/docs/contracts/status.schema.json',
    ...z.toJSONSchema(statusSchema, { target: 'draft-2020-12' }),
  };
}

/** Text from GitHub on one line and within `max` characters. */
export function clip(text: string, max: number): string {
  const line = text.replaceAll(/[\s\p{Cc}]+/gu, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

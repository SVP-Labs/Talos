import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { decisionInput, type ReviewFacts, ticketIssue } from './assemble.js';
import { codeOwnersAt } from './codeowners.js';
import { decide, type DecisionState } from './conditions.js';
import {
  closingIssues,
  getPull,
  listIssueEvents,
  listPullCommits,
  listPullFiles,
  listReviews,
  repoProperties,
} from './github.js';
import { extensionFiles } from './guard.js';
import { claudeCodeModel } from './model.js';
import { CHECK_NAME, checkFields, errorFields, reviewerOutcome } from './report.js';
import { type ReviewerDeps, type ReviewerRun, runReviewer } from './reviewer.js';
import { ConfigError } from '../config/load.js';
import { PACKS } from '../core/registry.js';
import { exec } from '../exec/exec.js';
import { type GitHub, GitHubError } from '../github/api.js';
import { createCheckRun } from '../github/checks.js';
import { type Identities, sameLogin } from '../github/identities.js';
import type { JobContext, JobOutcome } from '../jobs/context.js';
import { getIssue } from '../ticket/github.js';
import { isTrusted } from '../ticket/trust.js';
import { assetsDir } from '../version/self.js';

export type ReviewDeps = ReviewerDeps & {
  /** The tool-config extension files the packs declare, for the guard list. */
  readonly extensions: readonly string[];
};

/** Where the event points: a PR, and for a merge group the group's own commits. */
type Target = {
  readonly pr: number;
  /** The head the payload names, so a check still reports when reading the PR fails. */
  readonly sha: string;
  readonly group: { readonly headSha: string; readonly baseSha: string } | undefined;
};

export type Routed = { readonly target: Target } | { readonly skip: string };

const REVIEWED_ACTIONS: ReadonlySet<string> = new Set([
  'opened',
  'synchronize',
  'reopened',
  'ready_for_review',
  'edited',
]);

const pullRef = z.object({
  number: z.number().int().positive(),
  head: z.object({ sha: z.string().min(1) }),
});

const pullEvent = z.object({ action: z.string(), pull_request: pullRef });

const reviewEvent = z.object({
  action: z.string(),
  review: z.object({
    user: z.object({ login: z.string() }).nullable().optional(),
    author_association: z.string().optional(),
  }),
  pull_request: pullRef,
});

const groupEvent = z.object({
  action: z.string(),
  merge_group: z.object({ head_sha: z.string(), head_ref: z.string(), base_sha: z.string() }),
});

/** The PR a merge queue's branch is for: `gh-readonly-queue/<base>/pr-<N>-<sha>`. */
export function pullOfQueueRef(ref: string): number | undefined {
  const match = /(?:^|\/)gh-readonly-queue\/.+\/pr-([1-9]\d*)-[0-9a-f]{40}$/.exec(ref);
  return match === null ? undefined : Number(match[1]);
}

function routeGroup(payload: unknown): Routed {
  const parsed = groupEvent.safeParse(payload);
  if (!parsed.success) return { skip: 'unreadable merge_group payload' };
  const group = parsed.data.merge_group;
  if (parsed.data.action !== 'checks_requested') {
    return { skip: `merge_group ${parsed.data.action}` };
  }
  const pr = pullOfQueueRef(group.head_ref);
  if (pr === undefined) return { skip: 'the merge group names no PR' };
  return {
    target: {
      pr,
      sha: group.head_sha,
      group: { headSha: group.head_sha, baseSha: group.base_sha },
    },
  };
}

/**
 * The PR an event asks `talos/review` about. Reviews by strangers end here, whatever the
 * dispatcher did, and so do the reviewer's own, which would only start it again.
 */
export function routeEvent(event: string, payload: unknown, who: Identities): Routed {
  if (event === 'merge_group') return routeGroup(payload);
  if (event === 'pull_request_target') {
    const parsed = pullEvent.safeParse(payload);
    if (!parsed.success) return { skip: 'unreadable pull_request_target payload' };
    const { action, pull_request: pull } = parsed.data;
    if (!REVIEWED_ACTIONS.has(action)) return { skip: `pull_request_target ${action}` };
    return { target: { pr: pull.number, sha: pull.head.sha, group: undefined } };
  }
  if (event === 'pull_request_review') {
    const parsed = reviewEvent.safeParse(payload);
    if (!parsed.success) return { skip: 'unreadable pull_request_review payload' };
    const { review, pull_request: pull } = parsed.data;
    const login = review.user?.login;
    if (sameLogin(login, who.reviewer)) return { skip: "the reviewer's own review" };
    if (!isTrusted({ login, association: review.author_association }, who)) {
      return { skip: 'review author not trusted' };
    }
    return { target: { pr: pull.number, sha: pull.head.sha, group: undefined } };
  }
  return { skip: `no review on ${event}` };
}

async function gather(
  gh: GitHub,
  ctx: JobContext,
  target: Target,
  deps: ReviewDeps,
): Promise<ReviewFacts> {
  const { repo } = ctx;
  const pull = await getPull(gh, repo, target.pr);
  const [config, files, reviews, commits, pullEvents, closing, properties, owners] =
    await Promise.all([
      ctx.config(target.group?.headSha ?? pull.baseRef),
      listPullFiles(gh, repo, pull.number),
      listReviews(gh, repo, pull.number),
      listPullCommits(gh, repo, pull.number),
      listIssueEvents(gh, repo, pull.number),
      closingIssues(gh, repo, pull.number),
      repoProperties(gh, repo),
      codeOwnersAt(gh, repo, target.group?.baseSha ?? pull.baseRef),
    ]);
  const ticket = ticketIssue(closing, repo);
  const issue = ticket === undefined ? undefined : await getIssue(gh, repo, ticket.number);
  const issueEvents = issue === undefined ? [] : await listIssueEvents(gh, repo, issue.number);
  return {
    repo,
    who: ctx.who,
    config,
    agentsOn: properties.agentsOn,
    onChannel: properties.onChannel,
    pull,
    files,
    reviews,
    commits,
    pullEvents,
    closing,
    issue,
    issueEvents,
    owners,
    extensions: deps.extensions,
  };
}

/** What failed, in words safe to publish: never a response body or repository content. */
function safeDetail(error: unknown): string {
  if (error instanceof GitHubError) return `GitHub refused a request: ${error.message}`;
  if (error instanceof ConfigError) return 'talos.yml is invalid';
  if (error instanceof z.ZodError) return 'a response from GitHub had an unexpected shape';
  return error instanceof Error
    ? `${error.name} while reading the PR`
    : 'an error while reading the PR';
}

async function decideAndPublish(
  gh: GitHub,
  ctx: JobContext,
  target: Target,
  deps: ReviewDeps,
): Promise<JobOutcome[]> {
  const facts = await gather(gh, ctx, target, deps);
  if (facts.pull.state !== 'open') {
    return [{ job: 'review', result: 'skipped', detail: 'the PR is closed' }];
  }
  const run: ReviewerRun | undefined =
    target.group === undefined ? await runReviewer(gh, facts, deps) : undefined;
  const decision = decide(decisionInput(facts, run));
  const state: DecisionState =
    target.group !== undefined && decision.state === 'wait' ? 'fail' : decision.state;
  const headSha = target.group?.headSha ?? facts.pull.headSha;
  await createCheckRun(gh, ctx.repo, {
    name: CHECK_NAME,
    headSha,
    ...checkFields(decision, state, run),
  });
  const where = target.group === undefined ? `#${target.pr}` : `#${target.pr} in the merge queue`;
  return [
    ...(run === undefined ? [] : [reviewerOutcome(run)]),
    { job: 'review', result: 'done', detail: `${CHECK_NAME} ${state} on ${where}` },
  ];
}

/** `reviewJob` with its model, prompts and guard list of the caller's choosing (tests). */
export async function reviewJobWith(ctx: JobContext, deps: ReviewDeps): Promise<JobOutcome[]> {
  if (ctx.phase !== 'act') {
    return [{ job: 'review', result: 'skipped', detail: 'runs in the act phase' }];
  }
  const gh = ctx.gh;
  if (gh === undefined) return [{ job: 'review', result: 'failed', detail: 'no reviewer token' }];
  const routed = routeEvent(ctx.event, ctx.payload, ctx.who);
  if ('skip' in routed) return [{ job: 'review', result: 'skipped', detail: routed.skip }];
  const { target } = routed;
  try {
    return await decideAndPublish(gh, ctx, target, deps);
  } catch (error) {
    const detail = safeDetail(error);
    await createCheckRun(gh, ctx.repo, {
      name: CHECK_NAME,
      headSha: target.sha,
      ...errorFields(detail),
    }).catch(() => undefined);
    throw error;
  }
}

async function readText(url: URL, fallback: string): Promise<string> {
  try {
    return await readFile(url, 'utf8');
  } catch {
    return fallback;
  }
}

export function defaultReviewDeps(env: Readonly<Record<string, string | undefined>>): ReviewDeps {
  return {
    model: claudeCodeModel({ exec, env }),
    extensions: extensionFiles(PACKS),
    rubric: () => readFile(new URL('prompts/review.md', assetsDir()), 'utf8'),
    engineering: () =>
      readText(
        new URL('../../ENGINEERING.md', import.meta.url),
        '(ENGINEERING.md is not available.)',
      ),
  };
}

/**
 * `talos/review` for the event in `ctx`: the reviewer's AI review where agents are on, the
 * owner's approval or the debt-and-chore conditions, published as a check run on the PR's head
 * or the merge group's head.
 */
export function reviewJob(ctx: JobContext): Promise<JobOutcome[]> {
  return reviewJobWith(ctx, defaultReviewDeps(ctx.env));
}

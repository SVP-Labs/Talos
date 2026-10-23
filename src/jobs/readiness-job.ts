import type { z } from 'zod';
import type { JobContext, JobOutcome } from './context.js';
import { issuesEvent } from './payloads.js';
import {
  briefLinks,
  judgeReadiness,
  needsBrief,
  readinessComment,
  type Readiness,
  readinessLabels,
} from './readiness.js';
import { readMarker } from './talos-issues.js';
import type { GitHub } from '../github/api.js';
import type { Identities } from '../github/identities.js';
import {
  addComment,
  changeLabels,
  defaultBranch,
  fileAt,
  getIssue,
  listComments,
} from '../ticket/github.js';
import { LABEL } from '../ticket/labels.js';
import type { Issue } from '../ticket/schemas.js';
import { isTalos, isTrusted } from '../ticket/trust.js';

const JOB = 'readiness';

/** The issue actions that can change whether an issue is ready. */
const ACTIONS: ReadonlySet<string> = new Set([
  'opened',
  'edited',
  'reopened',
  'labeled',
  'unlabeled',
]);

/** At most this many brief links are looked up: a body can't make the job call the API at will. */
const MAX_BRIEFS = 5;

function skipped(detail: string): JobOutcome {
  return { job: JOB, result: 'skipped', detail };
}

/**
 * Rewrites the readiness comment in place. A ready issue that never had one gets none: the
 * comment exists to say what is missing, and to say so no longer once it isn't.
 */
async function keepComment(
  gh: GitHub,
  at: { repo: string; who: Identities; issue: number },
  text: string,
  ready: boolean,
): Promise<void> {
  const comments = await listComments(gh, at.repo, at.issue);
  const mine = comments.find(
    (c) => c.author === at.who.reviewer && readMarker(c.body, 'readiness') !== undefined,
  );
  if (mine === undefined) {
    if (!ready) await addComment(gh, at.repo, at.issue, text);
    return;
  }
  if (mine.body.trim() === text.trim()) return;
  await gh.request('PATCH', `repos/${at.repo}/issues/comments/${mine.id}`, {
    body: { body: text },
  });
}

async function briefsOf(
  gh: GitHub,
  at: { repo: string; base: string },
  links: readonly string[],
): Promise<Map<string, boolean>> {
  const briefs = new Map<string, boolean>();
  for (const path of links.slice(0, MAX_BRIEFS)) {
    briefs.set(path, (await fileAt(gh, at.repo, path, at.base)) !== undefined);
  }
  return briefs;
}

type IssuesEvent = z.infer<typeof issuesEvent>;

/** Why an event is not judged, from the payload alone, before the token is used. */
export function eventSkip(event: IssuesEvent, who: Identities): string | undefined {
  if (!ACTIONS.has(event.action)) return `nothing to judge on ${event.action}`;
  if (event.sender?.login === who.reviewer) return "the reviewer's own change";
  const author = { login: event.issue.user?.login, association: event.issue.author_association };
  if (!isTrusted(author, who)) return 'author not trusted';
  return isTalos(author.login, who) ? 'filed by Talos' : undefined;
}

async function judge(
  ctx: JobContext,
  gh: GitHub,
  at: { readonly issue: Issue; readonly base: string },
): Promise<Readiness> {
  const config = await ctx.config(at.base);
  const { body, labels } = at.issue;
  const links = needsBrief(labels) ? briefLinks(body, config.docs.briefs) : [];
  return judgeReadiness({
    body,
    labels,
    briefsDir: config.docs.briefs,
    briefs: await briefsOf(gh, { repo: ctx.repo, base: at.base }, links),
  });
}

/**
 * Issue readiness on an `issues` event. Only issues an owner, member or collaborator wrote are
 * judged; issues marked `legacy` wait until someone rewrites them, and Talos's own are written
 * ready. Not ready: `needs-spec` and one comment listing what's missing. Ready: `status/ready`.
 */
export async function readinessJob(ctx: JobContext, gh: GitHub): Promise<JobOutcome> {
  const event = issuesEvent.parse(ctx.payload);
  const skip = eventSkip(event, ctx.who);
  if (skip !== undefined) return skipped(skip);
  const issue = await getIssue(gh, ctx.repo, event.issue.number);
  if (issue === undefined || issue.isPull || issue.state === 'closed') return skipped('not open');
  if (issue.labels.includes(LABEL.legacy)) return skipped('legacy');
  const base = event.repository?.default_branch ?? (await defaultBranch(gh, ctx.repo));
  const verdict = await judge(ctx, gh, { issue, base });
  await changeLabels(gh, ctx.repo, issue.number, readinessLabels(verdict.ready, issue.labels));
  await keepComment(
    gh,
    { repo: ctx.repo, who: ctx.who, issue: issue.number },
    readinessComment(verdict.problems),
    verdict.ready,
  );
  const detail = verdict.ready ? 'ready' : `not ready: ${verdict.problems.length} problem(s)`;
  return { job: JOB, result: 'done', detail };
}

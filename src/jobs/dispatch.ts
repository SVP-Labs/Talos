import {
  type ActDeps,
  type ActEnv,
  type ActJob,
  debtIssues,
  flakyTests,
  labelSync,
  MissingInput,
  staleClaims,
  syncChores,
} from './act.js';
import { type AnalyzeDeps, debtRun, mutationReport } from './analyze.js';
import type { JobContext, JobOutcome } from './context.js';
import { admission } from './payloads.js';
import { readinessJob } from './readiness-job.js';
import { type Cadence, isDue } from './schedule.js';
import { ConfigError } from '../config/load.js';
import { GitHubError } from '../github/api.js';
import { defaultBranch } from '../ticket/github.js';

export type JobDeps = ActDeps & {
  /** `talos/review` and the reviewer's AI review: pull requests, reviews, merge groups. */
  review(ctx: JobContext): Promise<JobOutcome[]>;
  /** Present in the analyze phase only. */
  readonly analyze?: AnalyzeDeps;
};

type Scheduled =
  | {
      readonly name: string;
      readonly phase: 'analyze';
      readonly cadence: Cadence;
      run(ctx: JobContext, deps: AnalyzeDeps): Promise<JobOutcome>;
    }
  | {
      readonly name: string;
      readonly phase: 'act';
      readonly cadence: Cadence;
      readonly run: ActJob;
    };

/** In order: labels exist before any issue is filed with them. */
const SCHEDULED: readonly Scheduled[] = [
  { name: 'debt-run', phase: 'analyze', cadence: 'weekly', run: debtRun },
  { name: 'mutation-report', phase: 'analyze', cadence: 'weekly', run: mutationReport },
  { name: 'label-sync', phase: 'act', cadence: 'daily', run: labelSync },
  { name: 'stale-claims', phase: 'act', cadence: 'daily', run: staleClaims },
  { name: 'flaky-tests', phase: 'act', cadence: 'daily', run: flakyTests },
  { name: 'debt-issues', phase: 'act', cadence: 'weekly', run: debtIssues },
  { name: 'sync-chore', phase: 'act', cadence: 'weekly', run: syncChores },
];

const REVIEWED: ReadonlySet<string> = new Set([
  'pull_request_target',
  'merge_group',
  'pull_request_review',
]);

/** A failure's one line: what failed, never what the repository holds. */
function safeDetail(error: unknown): string {
  if (error instanceof GitHubError || error instanceof MissingInput) return error.message;
  if (error instanceof ConfigError) return 'talos.yml is invalid';
  return error instanceof Error ? `${error.name} in the job` : 'an error in the job';
}

async function guarded(
  ctx: JobContext,
  job: string,
  work: () => Promise<JobOutcome | JobOutcome[]>,
): Promise<JobOutcome[]> {
  try {
    const done = await work();
    return Array.isArray(done) ? done : [done];
  } catch (error) {
    ctx.log.warn(`${job}: ${error instanceof Error ? error.message : String(error)}`);
    return [{ job, result: 'failed', detail: safeDetail(error) }];
  }
}

function skipped(job: string, detail: string): JobOutcome[] {
  return [{ job, result: 'skipped', detail }];
}

async function actEnv(ctx: JobContext, deps: JobDeps): Promise<ActEnv> {
  if (ctx.gh === undefined) throw new MissingInput('no reviewer token in the act phase');
  const base = await defaultBranch(ctx.gh, ctx.repo);
  return { gh: ctx.gh, actions: ctx.actions, base, config: await ctx.config(base), deps };
}

async function scheduled(ctx: JobContext, deps: JobDeps): Promise<JobOutcome[]> {
  const due = SCHEDULED.filter((s) => s.phase === ctx.phase);
  const outcomes: JobOutcome[] = [];
  let env: ActEnv | undefined;
  for (const job of due) {
    if (!isDue(job.cadence, ctx.event, ctx.now)) {
      outcomes.push(...skipped(job.name, 'not due today'));
      continue;
    }
    const ran = await guarded(ctx, job.name, async () => {
      if (job.phase === 'analyze') {
        if (deps.analyze === undefined) throw new MissingInput('no engine in the analyze phase');
        return job.run(ctx, deps.analyze);
      }
      env ??= await actEnv(ctx, deps);
      return job.run(ctx, env);
    });
    outcomes.push(...ran);
  }
  return outcomes;
}

/**
 * `talos job <event>`: routes the caller's event to its jobs in this phase. Comments and reviews
 * from anyone but the owner, a member, a collaborator or Thea's App end here, before any token
 * is used or any model called.
 */
export async function runJobs(ctx: JobContext, deps: JobDeps): Promise<JobOutcome[]> {
  const admitted = admission(ctx.event, ctx.payload, ctx.who);
  if (!admitted.admit) return skipped('admission', admitted.reason);
  if (ctx.event === 'schedule' || ctx.event === 'workflow_dispatch') return scheduled(ctx, deps);
  if (ctx.phase === 'analyze') return skipped('analyze', `nothing to analyze on ${ctx.event}`);
  const gh = ctx.gh;
  if (ctx.event === 'issues') {
    return guarded(ctx, 'readiness', async () => {
      if (gh === undefined) throw new MissingInput('no reviewer token in the act phase');
      return readinessJob(ctx, gh);
    });
  }
  if (REVIEWED.has(ctx.event)) return guarded(ctx, 'review', async () => deps.review(ctx));
  if (ctx.event === 'issue_comment') return skipped('comment', 'comments start no job');
  return skipped('none', `no job runs on ${ctx.event}`);
}

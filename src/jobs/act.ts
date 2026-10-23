import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEBT_FILE } from './analyze.js';
import type { Download } from './artifacts.js';
import type { JobContext, JobOutcome } from './context.js';
import { fileDebtIssues } from './debt-issues.js';
import { type DebtReport, parseDebtReport } from './debt-report.js';
import { fileFlakyIssues } from './flaky.js';
import { type DesiredLabel, syncLabels } from './label-sync.js';
import { keepSyncChore } from './sync-chore.js';
import type { TalosConfig } from '../config/schema.js';
import type { GitHub } from '../github/api.js';
import { sweepStaleClaims } from '../ticket/stale.js';

/** What the act phase's scheduled jobs need beyond the job context. */
export type ActDeps = {
  /** Downloads an artifact's zip with the workflow's token. */
  readonly download?: Download;
  labels(): Promise<readonly DesiredLabel[]>;
};

export type ActEnv = {
  /** The reviewer App's token. */
  readonly gh: GitHub;
  /** The workflow's token: artifacts, and deleting stale ticket branches. */
  readonly actions: GitHub | undefined;
  readonly base: string;
  readonly config: TalosConfig;
  readonly deps: ActDeps;
};

export type ActJob = (ctx: JobContext, env: ActEnv) => Promise<JobOutcome>;

function outcome(job: string, failed: boolean, detail: string): JobOutcome {
  return { job, result: failed ? 'failed' : 'done', detail };
}

export class MissingInput extends Error {
  override readonly name = 'MissingInput';
}

async function analyzed(ctx: JobContext): Promise<DebtReport> {
  let text: string;
  try {
    text = await readFile(join(ctx.workdir, DEBT_FILE), 'utf8');
  } catch {
    throw new MissingInput(`no ${DEBT_FILE} from the analyze phase`);
  }
  return parseDebtReport(text);
}

export const labelSync: ActJob = async (ctx, env) => {
  const result = await syncLabels(env.gh, ctx.repo, await env.deps.labels());
  return outcome('label-sync', false, `created ${result.created}, updated ${result.updated}`);
};

/** Deleting a branch takes `contents: write`, which only the workflow's token has here. */
export const staleClaims: ActJob = async (ctx, env) => {
  if (env.actions === undefined) {
    return outcome('stale-claims', true, 'no workflow token to delete stale branches with');
  }
  const swept = await sweepStaleClaims(
    { gh: env.gh, refs: env.actions },
    { repo: ctx.repo, prefix: env.config.prefix, now: ctx.now },
  );
  return outcome(
    'stale-claims',
    swept.failed > 0,
    `released ${swept.released.length}, kept ${swept.kept}, ${swept.failed} failed`,
  );
};

export const flakyTests: ActJob = async (ctx, env) => {
  if (env.actions === undefined || env.deps.download === undefined) {
    return outcome('flaky-tests', true, "no workflow token to read the gate's artifacts with");
  }
  const result = await fileFlakyIssues(
    { gh: env.gh, actions: env.actions, download: env.deps.download },
    { repo: ctx.repo, who: ctx.who, now: ctx.now, base: env.base },
  );
  return outcome(
    'flaky-tests',
    false,
    `filed ${result.filed} of ${result.seen} flaky test(s); ${result.unreadable} verdict(s) unreadable`,
  );
};

export const debtIssues: ActJob = async (ctx, env) => {
  const result = await fileDebtIssues(
    env.gh,
    { repo: ctx.repo, who: ctx.who },
    await analyzed(ctx),
  );
  return outcome(
    'debt-issues',
    false,
    `filed ${result.filed} of ${result.candidates} file(s) with debt`,
  );
};

export const syncChores: ActJob = async (ctx, env) => {
  const plan = await keepSyncChore(env.gh, { repo: ctx.repo, who: ctx.who }, await analyzed(ctx));
  const said: Record<typeof plan.action, string> = {
    none: 'no stale generated copy',
    current: 'the open sync chore is current',
    claimed: 'the open sync chore is claimed; left as it is',
    create: 'filed a sync chore',
    update: 'updated the open sync chore',
  };
  return outcome('sync-chore', false, said[plan.action]);
};

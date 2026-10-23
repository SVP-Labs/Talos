import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Command, type Io, parse, required, UsageError } from './io.js';
import { currentOs } from './run.js';
import { loadConfig } from '../config/load.js';
import type { TalosConfig } from '../config/schema.js';
import { consoleLogger, type Logger } from '../core/log.js';
import type { RunResult } from '../core/result.js';
import { runAt } from '../engine/local.js';
import { createEngine } from '../engine/session.js';
import { github, type GitHub, type GitHubOptions } from '../github/api.js';
import { identities } from '../github/identities.js';
import type { AnalyzeDeps } from '../jobs/analyze.js';
import { downloader } from '../jobs/artifacts.js';
import type { JobContext, JobOutcome, JobPhase } from '../jobs/context.js';
import { debtCheckIds, mutationCheckIds } from '../jobs/debt-report.js';
import { type JobDeps, runJobs } from '../jobs/dispatch.js';
import { shippedLabels } from '../jobs/label-sync.js';
import { git, revParse } from '../repo/git.js';
import { reviewJob } from '../review/job.js';
import { configAt } from '../ticket/github.js';

/** The version of the one JSON line `talos job` prints. */
export const JOB_SCHEMA = 'talos.job/1';

const LISTED = 20;
const DETAIL = 200;
const REPO = /^[\w.-]+\/[\w.-]+$/;

type Env = Readonly<Record<string, string | undefined>>;

function phaseOf(value: string | undefined): JobPhase {
  if (value === 'analyze' || value === 'act') return value;
  throw new UsageError('--phase takes analyze or act');
}

function repoOf(env: Env): string {
  const repo = required(env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY (the environment)');
  if (!REPO.test(repo)) throw new UsageError('GITHUB_REPOSITORY is not owner/name');
  return repo;
}

function eventOf(event: string | undefined, env: Env): string {
  const named = required(event, 'event (the first argument)');
  if (env.GITHUB_EVENT_NAME !== undefined && env.GITHUB_EVENT_NAME !== named) {
    throw new UsageError(`the event is ${env.GITHUB_EVENT_NAME}, not ${named}`);
  }
  return named;
}

/**
 * The engine at the default branch's checkout, run once for both weekly analyze jobs, so the
 * project's dependencies and services start once.
 */
function analyzeDeps(io: Io, log: Logger, verbose: boolean): AnalyzeDeps {
  const engine = createEngine(verbose, log);
  const checks = { debt: debtCheckIds(engine.packs), mutation: mutationCheckIds(engine.packs) };
  let full: Promise<RunResult> | undefined;
  const runAll = async (): Promise<RunResult> => {
    const sha = await revParse(git(engine.exec, io.cwd), 'HEAD');
    return runAt(engine, {
      root: io.cwd,
      sha,
      tiers: ['commit', 'head'],
      os: currentOs(),
      side: 'alone',
      only: [...checks.debt, ...checks.mutation],
    });
  };
  return {
    checks,
    run: async (only) => {
      full ??= runAll();
      const result = await full;
      return { ...result, outcomes: result.outcomes.filter((o) => only.includes(o.check)) };
    },
    summary: async (markdown) => {
      if (io.env.GITHUB_STEP_SUMMARY !== undefined) {
        await appendFile(io.env.GITHUB_STEP_SUMMARY, markdown);
      }
    },
  };
}

function printed(outcomes: readonly JobOutcome[]): JobOutcome[] {
  return outcomes.slice(0, LISTED).map((o) => ({
    ...o,
    detail: o.detail.length <= DETAIL ? o.detail : `${o.detail.slice(0, DETAIL - 1)}…`,
  }));
}

export type JobOptions = GitHubOptions & {
  readonly review?: (ctx: JobContext) => Promise<JobOutcome[]>;
  readonly analyze?: AnalyzeDeps;
};

type Clients = { readonly gh: GitHub | undefined; readonly actions: GitHub | undefined };

function clients(phase: JobPhase, env: Env, options: GitHubOptions): Clients {
  if (phase === 'analyze') {
    if (tokenIn(env, 'TALOS_REVIEWER_TOKEN') !== undefined) {
      throw new UsageError(
        "the analyze phase runs repository code and must not hold the reviewer's token",
      );
    }
    return { gh: undefined, actions: undefined };
  }
  const reviewer = tokenIn(env, 'TALOS_REVIEWER_TOKEN');
  const workflow = tokenIn(env, 'GITHUB_TOKEN');
  return {
    gh: reviewer === undefined ? undefined : github(reviewer, options),
    actions: workflow === undefined ? undefined : github(workflow, options),
  };
}

function tokenIn(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

type Parsed = {
  readonly event: string;
  readonly phase: JobPhase;
  readonly workdir: string | undefined;
  readonly verbose: boolean;
};

async function contextOf(parsed: Parsed, io: Io, options: JobOptions): Promise<JobContext> {
  const { env } = io;
  const repo = repoOf(env);
  const { gh, actions } = clients(parsed.phase, env, options);
  const eventPath = required(env.GITHUB_EVENT_PATH, 'GITHUB_EVENT_PATH (the environment)');
  const payload: unknown = JSON.parse(await readFile(eventPath, 'utf8'));
  const workdir =
    parsed.workdir ?? env.TALOS_WORKDIR ?? join(env.RUNNER_TEMP ?? tmpdir(), 'talos-job');
  await mkdir(workdir, { recursive: true });
  const config = async (ref: string): Promise<TalosConfig> => {
    if (parsed.phase === 'analyze') return loadConfig(io.cwd);
    if (gh === undefined) throw new UsageError('TALOS_REVIEWER_TOKEN is required in the act phase');
    return configAt(gh, repo, ref);
  };
  return {
    event: parsed.event,
    payload,
    repo,
    phase: parsed.phase,
    ...(gh === undefined ? {} : { gh }),
    ...(actions === undefined ? {} : { actions }),
    who: identities(env),
    env,
    now: new Date(),
    log: consoleLogger(parsed.verbose),
    workdir,
    config,
  };
}

function depsOf(ctx: JobContext, io: Io, options: JobOptions, verbose: boolean): JobDeps {
  const workflowToken = tokenIn(io.env, 'GITHUB_TOKEN');
  const download =
    ctx.phase === 'act' && workflowToken !== undefined
      ? { download: downloader(workflowToken, options.fetch) }
      : {};
  const analyze =
    ctx.phase === 'analyze'
      ? { analyze: options.analyze ?? analyzeDeps(io, ctx.log, verbose) }
      : {};
  return { review: options.review ?? reviewJob, labels: shippedLabels, ...download, ...analyze };
}

/** `talos job` with GitHub clients, the review and the engine of the caller's choosing (tests). */
export function jobWith(options: JobOptions): Command {
  return async (argv, io) => {
    const { values, positionals } = parse(
      argv,
      {
        phase: { type: 'string' },
        workdir: { type: 'string' },
        verbose: { type: 'boolean', default: false },
      },
      true,
    );
    const parsed: Parsed = {
      event: eventOf(positionals[0], io.env),
      phase: phaseOf(values.phase),
      workdir: values.workdir,
      verbose: values.verbose,
    };
    const ctx = await contextOf(parsed, io, options);
    const outcomes = await runJobs(ctx, depsOf(ctx, io, options, parsed.verbose));
    const failed = outcomes.filter((o) => o.result === 'failed').length;
    const line = {
      schema: JOB_SCHEMA,
      event: ctx.event,
      phase: ctx.phase,
      repo: ctx.repo,
      outcomes: printed(outcomes),
      total: outcomes.length,
      failed,
    };
    io.out(`${JSON.stringify(line)}\n`);
    return failed > 0 ? 1 : 0;
  };
}

/**
 * `talos job <event> --phase analyze|act`: the caller workflow's one call. Prints one JSON line
 * (`talos.job/1`) and exits 1 when any job failed.
 */
export const job: Command = jobWith({});

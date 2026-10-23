import { type Command, type Io, parse, UsageError } from './io.js';
import { runChannels } from '../central/channels-job.js';
import { dispatchAllowed } from '../central/channels.js';
import { expectedFromAssets, runChannelsFileDrift, runDrift } from '../central/drift-job.js';
import { runPrivacy } from '../central/privacy.js';
import { packAssessor, type RuntimeAssessor } from '../central/runtime-port.js';
import { runSweep } from '../central/sweep-job.js';
import { github, type GitHubOptions } from '../github/api.js';
import { downloader } from '../github/artifacts.js';
import { identities } from '../github/identities.js';
import { lookupMode } from '../version/pin.js';

/** The version of the one JSON line `talos central` prints. */
export const CENTRAL_SCHEMA = 'talos.central/1';

const JOBS = ['channels', 'sweep', 'drift', 'privacy'] as const;
type Job = (typeof JOBS)[number];

/**
 * What a failed job prints instead of its error: messages from git and the API name
 * repositories, and these jobs run in a public repository.
 */
const GENERIC: Readonly<Record<Job, string>> = {
  channels: 'the channel job could not finish',
  sweep: 'the runtime sweep could not finish',
  drift: 'the drift report could not finish',
  privacy: 'the privacy self-test could not finish',
};

type Env = Readonly<Record<string, string | undefined>>;

export type CentralOptions = GitHubOptions & {
  readonly assess?: RuntimeAssessor;
  readonly now?: () => Date;
};

type Outcome = { readonly ok: boolean; readonly report: Readonly<Record<string, unknown>> };

type Flags = { readonly channelsFile: boolean };

function jobOf(name: string | undefined): Job {
  const job = JOBS.find((j) => j === name);
  if (job === undefined) throw new UsageError(`usage: talos central <${JOBS.join('|')}> [--json]`);
  return job;
}

function token(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new UsageError(`${name} is not set`);
  return value;
}

function optionalToken(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

async function channels(env: Env, options: CentralOptions): Promise<Outcome> {
  const who = identities(env);
  const urgent = env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  const actors = { actor: env.GITHUB_ACTOR, triggering: env.GITHUB_TRIGGERING_ACTOR };
  if (urgent && !dispatchAllowed(actors, who.owner)) {
    return { ok: false, report: { refused: 'only the owner may dispatch the urgent promotion' } };
  }
  const report = await runChannels({
    talos: github(token(env, 'GITHUB_TOKEN'), options),
    release: github(token(env, 'TALOS_RELEASE_TOKEN'), options),
    who,
    now: options.now?.() ?? new Date(),
    mirror: lookupMode(env) === 'channels',
    urgent,
  });
  return { ok: report.missing === 0, report };
}

async function sweep(env: Env, options: CentralOptions): Promise<Outcome> {
  const report = await runSweep({
    gh: github(token(env, 'TALOS_REVIEWER_TOKEN'), options),
    who: identities(env),
    assess: options.assess ?? packAssessor(),
  });
  return { ok: report.errors === 0, report };
}

async function drift(env: Env, options: CentralOptions, flags: Flags): Promise<Outcome> {
  const who = identities(env);
  const release = github(token(env, 'TALOS_RELEASE_TOKEN'), options);
  const reviewer = github(token(env, 'TALOS_REVIEWER_TOKEN'), options);
  const report = flags.channelsFile
    ? await runChannelsFileDrift({ release, reviewer, who })
    : await runDrift({ release, reviewer, who, expected: await expectedFromAssets(who.owner) });
  return { ok: true, report };
}

async function privacy(io: Io, options: CentralOptions): Promise<Outcome> {
  const { env } = io;
  const apps = ['TALOS_REVIEWER_TOKEN', 'TALOS_RELEASE_TOKEN']
    .map((name) => optionalToken(env, name))
    .filter((value) => value !== undefined)
    .map((value) => github(value, options));
  if (apps.length === 0) {
    throw new UsageError('TALOS_REVIEWER_TOKEN or TALOS_RELEASE_TOKEN is required');
  }
  const workflow = token(env, 'GITHUB_TOKEN');
  const report = await runPrivacy({
    apps,
    actions: github(workflow, options),
    download: downloader(workflow, options),
    run: {
      repo: token(env, 'GITHUB_REPOSITORY'),
      id: token(env, 'GITHUB_RUN_ID'),
      attempt: env.GITHUB_RUN_ATTEMPT ?? '1',
      self: env.TALOS_PRIVACY_JOB ?? 'privacy',
    },
    out: (text) => {
      io.out(text);
    },
    canary: optionalToken(env, 'TALOS_PRIVACY_CANARY_SHA256')?.toLowerCase(),
  });
  return { ok: report.leaks === 0 && report.canary !== false, report };
}

function run(job: Job, io: Io, options: CentralOptions, flags: Flags): Promise<Outcome> {
  switch (job) {
    case 'channels':
      return channels(io.env, options);
    case 'sweep':
      return sweep(io.env, options);
    case 'drift':
      return drift(io.env, options, flags);
    case 'privacy':
      return privacy(io, options);
  }
}

/** `talos central` with the GitHub client and runtime assessor of the caller's choosing (tests). */
export function centralWith(options: CentralOptions): Command {
  return async (argv, io) => {
    const { values, positionals } = parse(
      argv,
      {
        json: { type: 'boolean', default: false },
        'channels-file': { type: 'boolean', default: false },
      },
      true,
    );
    const job = jobOf(positionals[0]);
    const print = (line: Record<string, unknown>): void => {
      io.out(`${JSON.stringify({ schema: CENTRAL_SCHEMA, job, ...line })}\n`);
    };
    try {
      const outcome = await run(job, io, options, { channelsFile: values['channels-file'] });
      print({ ok: outcome.ok, ...outcome.report });
      return outcome.ok ? 0 : 1;
    } catch (error) {
      if (error instanceof UsageError) throw error;
      print({ ok: false, error: GENERIC[job] });
      return 1;
    }
  };
}

/**
 * `talos central <channels|sweep|drift|privacy>`: the central jobs Talos's own workflows run.
 * Each prints one JSON line (`talos.central/1`) of counts, Talos's own release tags at most, and
 * never a repository's name, a path or a finding: these runs are public.
 */
export const central: Command = centralWith({});

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { type GitHub, GitHubError } from '../github/api.js';
import type { Download } from '../github/artifacts.js';
import { listInstallationRepositories, type Repository } from '../github/repos.js';

/**
 * The privacy self-test of the central workflows: every repository name an App can see is
 * masked first, then the logs of the run's other jobs are searched for them. Talos's runs are
 * public, so a name found there is a leak, and the job fails.
 */

/** A repository to look for: its `owner/name`, and its bare name when it is private. */
export type WatchedRepo = { readonly fullName: string; readonly name: string | undefined };

/**
 * The repositories to look for: every one but the current. A public repository's bare name is no
 * secret (and `Talos` is all over its own logs), so only a private one's is watched.
 */
export function watchedNames(repos: readonly Repository[], current: string): WatchedRepo[] {
  const seen = new Set([current.toLowerCase()]);
  const watched: WatchedRepo[] = [];
  for (const repo of repos) {
    const key = repo.fullName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const name = repo.fullName.split('/').at(-1);
    watched.push({ fullName: repo.fullName, name: repo.private && name !== '' ? name : undefined });
  }
  return watched;
}

/** `::add-mask::` commands for every watched name, full names first. */
export function maskCommands(watched: readonly WatchedRepo[]): string {
  const names = [
    ...watched.map((repo) => repo.fullName),
    ...watched.flatMap((repo) => (repo.name === undefined ? [] : [repo.name])),
  ];
  return names.map((name) => `::add-mask::${name}\n`).join('');
}

function escaped(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\/-]/g, String.raw`\$&`);
}

/**
 * How many watched repositories a log names: by full name anywhere, or by bare name as a whole
 * word (a sentence's full stop may follow it), regardless of case.
 */
export function leaksIn(log: string, watched: readonly WatchedRepo[]): number {
  const text = log.toLowerCase();
  const named = (repo: WatchedRepo): boolean => {
    if (text.includes(repo.fullName.toLowerCase())) return true;
    if (repo.name === undefined) return false;
    const word = escaped(repo.name.toLowerCase());
    return new RegExp(`(?<![\\w.-])${word}(?![\\w-]|\\.[\\w-])`).test(text);
  };
  return watched.filter(named).length;
}

/** The SHA-256 of a repository's lower-cased `owner/name`, as the canary's variable holds it. */
export function nameDigest(fullName: string): string {
  return createHash('sha256').update(fullName.toLowerCase()).digest('hex');
}

/**
 * Whether the scratch canary is among the watched repositories. Its name is known only by its
 * digest: the name itself in a workflow expression would print it.
 */
export function canaryWatched(watched: readonly WatchedRepo[], digest: string): boolean {
  return watched.some((repo) => repo.name !== undefined && nameDigest(repo.fullName) === digest);
}

const jobsSchema = z.array(
  z.object({
    id: z.number().int(),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
  }),
);

export type PrivacyDeps = {
  /** Metadata-only tokens of the Apps whose repositories the run could name. */
  readonly apps: readonly GitHub[];
  /** The workflow's own token: actions read. */
  readonly actions: GitHub;
  readonly download: Download;
  readonly run: {
    readonly repo: string;
    readonly id: string;
    readonly attempt: string;
    /** This job's name, whose log is still being written. */
    readonly self: string;
  };
  /** Where the masks go: the runner reads them from this job's output. */
  readonly out: (text: string) => void;
  /** The canary's name digest, when one is set. */
  readonly canary?: string | undefined;
  /** Waits between tries at a log GitHub hasn't stored yet. */
  readonly wait?: (ms: number) => Promise<void>;
};

export type PrivacyReport = {
  readonly names: number;
  readonly jobs: number;
  readonly leaks: number;
  /** Whether the canary was watched; `null` when no digest is set. */
  readonly canary: boolean | null;
};

async function allRepositories(apps: readonly GitHub[]): Promise<Repository[]> {
  const lists = await Promise.all(apps.map((gh) => listInstallationRepositories(gh)));
  return lists.flat();
}

const LOG_TRIES = 4;
const LOG_WAIT_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** A finished job's log, which GitHub may store a few seconds after the job ends. */
async function jobLog(deps: PrivacyDeps, jobId: number): Promise<string> {
  const path = `repos/${deps.run.repo}/actions/jobs/${jobId}/logs`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return new TextDecoder().decode(await deps.download(path));
    } catch (error) {
      const missing = error instanceof GitHubError && error.status === 404;
      if (!missing || attempt >= LOG_TRIES) throw error;
      await (deps.wait ?? sleep)(LOG_WAIT_MS * attempt);
    }
  }
}

/** Masks every name, then searches every finished job of this run attempt. */
export async function runPrivacy(deps: PrivacyDeps): Promise<PrivacyReport> {
  const watched = watchedNames(await allRepositories(deps.apps), deps.run.repo);
  deps.out(maskCommands(watched));
  const { repo, id, attempt, self } = deps.run;
  const listed = jobsSchema.parse(
    await deps.actions.paginate<unknown>(
      `repos/${repo}/actions/runs/${id}/attempts/${attempt}/jobs`,
      'jobs',
    ),
  );
  // A skipped job has no log; this job's own is still being written.
  const done = listed.filter(
    (job) => job.status === 'completed' && job.conclusion !== 'skipped' && job.name !== self,
  );
  let leaks = 0;
  for (const job of done) leaks += leaksIn(await jobLog(deps, job.id), watched);
  const canary = deps.canary === undefined ? null : canaryWatched(watched, deps.canary);
  return { names: watched.length, jobs: done.length, leaks, canary };
}

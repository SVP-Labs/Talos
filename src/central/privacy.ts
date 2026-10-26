import { createHash } from 'node:crypto';
import { z } from 'zod';
import { literalMatches } from '../core/literal.js';
import { type GitHub, GitHubError } from '../github/api.js';
import type { Download } from '../github/artifacts.js';
import { listInstallationRepositories, listPropertyValues } from '../github/repos.js';

/**
 * The privacy self-test of the central workflows: every repository name of the organisation is
 * masked first, then the logs of the run's other jobs are searched for them. Talos's runs are
 * public, so a name found there is a leak, and the job fails. The names come from the
 * organisation's custom property listing, which lists every repository the central jobs could
 * name with an organisation permission alone.
 */

/** A repository to look for: its `owner/name`, and its bare name when it is private. */
export type WatchedRepo = { readonly fullName: string; readonly name: string | undefined };

/** A repository as far as the search needs it. */
export type Listed = { readonly fullName: string; readonly private: boolean };

/**
 * The repositories to look for: every one but the current. A public repository's bare name is no
 * secret (and `Talos` is all over its own logs), so only a private one's is watched.
 */
export function watchedNames(repos: readonly Listed[], current: string): WatchedRepo[] {
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

/** A bare name on its own: no word character, `.` or `-` against it, but a full stop after it. */
const BARE_NAME = { start: /(?<![\w.-])/y, end: /(?![\w-]|\.[\w-])/y };

/**
 * How many watched repositories a log names: by full name anywhere, or by bare name as a whole
 * word (a sentence's full stop may follow it), regardless of case.
 */
export function leaksIn(log: string, watched: readonly WatchedRepo[]): number {
  const text = log.toLowerCase();
  const named = (repo: WatchedRepo): boolean => {
    if (text.includes(repo.fullName.toLowerCase())) return true;
    if (repo.name === undefined) return false;
    return literalMatches(text, repo.name.toLowerCase(), BARE_NAME).length > 0;
  };
  return watched.filter(named).length;
}

/** The SHA-256 of a repository's lower-cased `owner/name`, as the canary's variable holds it. */
export function nameDigest(fullName: string): string {
  return createHash('sha256').update(fullName.toLowerCase()).digest('hex');
}

/** The private watched repository whose name has the canary's digest. */
function canaryIn(watched: readonly WatchedRepo[], digest: string): WatchedRepo | undefined {
  return watched.find((repo) => repo.name !== undefined && nameDigest(repo.fullName) === digest);
}

/**
 * Whether the scratch canary is among the watched repositories. Its name is known only by its
 * digest: the name itself in a workflow expression would print it.
 */
export function canaryWatched(watched: readonly WatchedRepo[], digest: string): boolean {
  return canaryIn(watched, digest) !== undefined;
}

/**
 * Every repository of `org`, the private ones marked, from two listings of its custom property
 * values: all of them, then those the search `is:private` finds.
 */
export async function organisationRepositories(gh: GitHub, org: string): Promise<Listed[]> {
  const [all, hidden] = await Promise.all([
    listPropertyValues(gh, org),
    listPropertyValues(gh, org, 'is:private'),
  ]);
  const secret = new Set(hidden.map((repo) => repo.id));
  const listed = new Map(all.map((repo) => [repo.id, repo.fullName]));
  for (const repo of hidden) listed.set(repo.id, repo.fullName);
  return [...listed].map(([id, fullName]) => ({ fullName, private: secret.has(id) }));
}

/** Where the names come from, and where the masks go. */
export type PrivacyNames = {
  /** A token of the organisation's custom property values: Custom properties read. */
  readonly properties: GitHub;
  readonly org: string;
  /** The Talos repository, whose name is public and in every log. */
  readonly current: string;
  /** Where the masks go: the runner reads them from this job's output. */
  readonly out: (text: string) => void;
  /** The canary's name digest, when one is set. */
  readonly canary?: string | undefined;
};

async function maskAll(names: PrivacyNames): Promise<WatchedRepo[]> {
  const repos = await organisationRepositories(names.properties, names.org);
  const watched = watchedNames(repos, names.current);
  names.out(maskCommands(watched));
  return watched;
}

export type MaskDeps = PrivacyNames & {
  /** Hands a value to the job's later steps (`$GITHUB_OUTPUT`), which never prints it. */
  readonly output: (key: string, value: string) => Promise<void>;
};

export type MaskReport = {
  readonly names: number;
  /** Whether the canary was found among the private repositories; `null` without a digest. */
  readonly canary: boolean | null;
};

/**
 * The privacy job's first step: masks every name, then hands the canary's bare name, masked by
 * now, to the steps that mint each App's token for the canary alone.
 */
export async function maskNames(deps: MaskDeps): Promise<MaskReport> {
  const watched = await maskAll(deps);
  if (deps.canary === undefined) return { names: watched.length, canary: null };
  const found = canaryIn(watched, deps.canary);
  if (found?.name !== undefined) await deps.output('name', found.name);
  return { names: watched.length, canary: found !== undefined };
}

const jobsSchema = z.array(
  z.object({
    id: z.number().int(),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
  }),
);

export type PrivacyDeps = Omit<PrivacyNames, 'current'> & {
  /** Each App's token minted for the canary alone, which proves the App reaches it. */
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
  /** Waits between tries at a log GitHub hasn't stored yet. */
  readonly wait?: (ms: number) => Promise<void>;
};

export type PrivacyReport = {
  readonly names: number;
  readonly jobs: number;
  readonly leaks: number;
  /** Whether the canary was watched and every App reaches it; `null` when no digest is set. */
  readonly canary: boolean | null;
};

/** Whether a token reaches the canary and nothing else. */
async function reachesOnly(gh: GitHub, digest: string): Promise<boolean> {
  const [only, ...rest] = await listInstallationRepositories(gh);
  return only !== undefined && rest.length === 0 && nameDigest(only.fullName) === digest;
}

/**
 * Whether the canary was watched, and each App's token minted for it reaches it alone: a clean
 * search then covered a private name that every App of the run could print.
 */
async function canaryProven(
  deps: PrivacyDeps,
  watched: readonly WatchedRepo[],
): Promise<boolean | null> {
  const digest = deps.canary;
  if (digest === undefined) return null;
  if (!canaryWatched(watched, digest) || deps.apps.length === 0) return false;
  const reached = await Promise.all(deps.apps.map((gh) => reachesOnly(gh, digest)));
  return reached.every(Boolean);
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
  const watched = await maskAll({ ...deps, current: deps.run.repo });
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
  return {
    names: watched.length,
    jobs: done.length,
    leaks,
    canary: await canaryProven(deps, watched),
  };
}

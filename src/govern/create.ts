import { parse } from 'yaml';
import { z } from 'zod';
import { GovernRefusal } from './plan.js';
import { talosConfigSchema } from '../config/schema.js';
import { type GitHub, GitHubError } from '../github/api.js';
import { readFileAt } from '../github/contents.js';
import { listOrgRepositories } from '../github/repos.js';

/**
 * `talos new`: the owner creates a repository in the organisation with their own login, under a
 * ticket prefix no other repository uses, and governs it. No App may create repositories.
 */

const NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function nameProblem(name: string): string | undefined {
  if (!NAME.test(name) || name === '.' || name === '..' || name.endsWith('.git')) {
    return `${name} is not a repository name GitHub takes (letters, digits, ".", "-", "_")`;
  }
  return undefined;
}

export function prefixProblem(prefix: string): string | undefined {
  const parsed = talosConfigSchema.shape.prefix.safeParse(prefix);
  return parsed.success
    ? undefined
    : `--prefix ${prefix}: 1 to 6 capitals or digits, a capital first`;
}

/** The prefix a `talos.yml`, or Scaffold's `project.yml`, names; `undefined` when none. */
export function prefixIn(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed = z.object({ prefix: z.string().min(1) }).safeParse(parse(text));
    return parsed.success ? parsed.data.prefix : undefined;
  } catch {
    return undefined;
  }
}

export type PrefixUse = { readonly repo: string; readonly prefix: string };

/** Every prefix the organisation's repositories use, from their default branch. */
export async function prefixesInUse(gh: GitHub, org: string): Promise<PrefixUse[]> {
  const repositories = (await listOrgRepositories(gh, org)).filter((r) => !r.archived);
  const found = await Promise.all(
    repositories.map(async (repository) => {
      const at = repository.defaultBranch;
      const prefix =
        prefixIn(await readFileAt(gh, repository.fullName, 'talos.yml', at)) ??
        prefixIn(await readFileAt(gh, repository.fullName, 'project.yml', at));
      return prefix === undefined ? [] : [{ repo: repository.fullName, prefix }];
    }),
  );
  return found.flat();
}

/** The repository already using `prefix`, compared without case; `undefined` when it is free. */
export function prefixHolder(uses: readonly PrefixUse[], prefix: string): string | undefined {
  return uses.find((use) => use.prefix.toUpperCase() === prefix.toUpperCase())?.repo;
}

function scalar(text: string): string {
  return /^[A-Za-z][\w .-]*$/.test(text) && !/\s$/.test(text) ? text : JSON.stringify(text);
}

/**
 * The `talos.yml` a new repository starts with: its name and prefix only, so the prefix is on
 * record from the start; `talos adopt` fills in the rest.
 */
export function seedConfig(name: string, prefix: string): string {
  return `name: ${scalar(name)}\nprefix: ${prefix}\n`;
}

async function repositoryExists(gh: GitHub, repo: string): Promise<boolean> {
  return (await gh.request<unknown>('GET', `repos/${repo}`, { allowMissing: true })) !== undefined;
}

/** Creates the repository with a first commit, so its default branch exists to commit to. */
export async function createRepository(
  gh: GitHub,
  org: string,
  name: string,
  visibility: 'public' | 'private',
): Promise<void> {
  const created = await gh.request<unknown>('POST', `orgs/${encodeURIComponent(org)}/repos`, {
    body: { name, private: visibility === 'private', auto_init: true },
  });
  z.object({ id: z.number().int() }).parse(created);
}

export type Sleep = (ms: number) => Promise<void>;

/**
 * A repository just created may answer 404 or 409 for a moment while GitHub writes its first
 * commit; this retries such answers a few times before giving up.
 */
export async function whenReady<T>(attempt: () => Promise<T>, sleep: Sleep, tries = 5): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    const settling = error instanceof GitHubError && (error.status === 404 || error.status === 409);
    if (!settling || tries <= 1) throw error;
    await sleep(2000);
    return whenReady(attempt, sleep, tries - 1);
  }
}

/** Refuses a name already taken in the organisation, or a prefix another repository uses. */
export async function checkNew(
  gh: GitHub,
  org: string,
  name: string,
  prefix: string,
): Promise<void> {
  if (await repositoryExists(gh, `${org}/${name}`)) {
    throw new GovernRefusal(`${org}/${name} exists already`);
  }
  const holder = prefixHolder(await prefixesInUse(gh, org), prefix);
  if (holder !== undefined) throw new GovernRefusal(`prefix ${prefix} is in use by ${holder}`);
}

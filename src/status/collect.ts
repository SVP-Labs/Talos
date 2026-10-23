import { z } from 'zod';
import { buildStatus, claimedBranches } from './build.js';
import { type ClaimComment, claimsQuery, claimsSchema, STATE_QUERY, stateSchema } from './query.js';
import { clip, MAX_LISTED, MAX_MESSAGE, type Status, STATUS_SCHEMA } from './schema.js';
import { parseConfig } from '../config/load.js';
import type { GitHub } from '../github/api.js';
import type { Identities } from '../github/identities.js';
import {
  getRepository,
  listOrgRepositories,
  propertyOf,
  type Repository,
} from '../github/repos.js';
import { type LookupMode, type Pin, type PinFinder, pinFinder } from '../version/pin.js';
import { versionAt } from '../version/release.js';

export type StatusContext = {
  readonly gh: GitHub;
  readonly who: Identities;
  readonly findPin: PinFinder;
  /** The release version at a Talos commit, read once per commit. */
  versionAt(sha: string): Promise<string>;
};

export function statusContext(gh: GitHub, who: Identities, mode: LookupMode): StatusContext {
  const versions = new Map<string, Promise<string>>();
  return {
    gh,
    who,
    findPin: pinFinder(gh, who.talosRepo, mode),
    versionAt: (sha) => {
      const known = versions.get(sha) ?? versionAt(gh, who.talosRepo, sha);
      versions.set(sha, known);
      return known;
    },
  };
}

/** A message that may be printed: ours, or a generic line for anything else. */
function messageOf(error: unknown): string {
  if (error instanceof z.ZodError) return "GitHub's answer did not have the expected shape";
  return error instanceof Error ? error.message : 'unknown error';
}

function prefixOf(text: string | null | undefined, problems: string[]): string | undefined {
  if (text === null || text === undefined) {
    problems.push('no talos.yml on the default branch');
    return undefined;
  }
  try {
    return parseConfig(text).prefix;
  } catch {
    problems.push('talos.yml on the default branch is invalid');
    return undefined;
  }
}

async function claimComments(
  gh: GitHub,
  repo: string,
  issues: readonly number[],
): Promise<Map<number, readonly ClaimComment[]>> {
  const comments = new Map<number, readonly ClaimComment[]>();
  if (issues.length === 0) return comments;
  const [owner, name] = repo.split('/');
  const raw = await gh.graphql<unknown>(claimsQuery(issues), { owner, name });
  const { repository } = claimsSchema.parse(raw);
  for (const issue of issues) {
    comments.set(issue, repository[`i${issue}`]?.comments.nodes ?? []);
  }
  return comments;
}

async function pinOf(
  ctx: StatusContext,
  repository: Repository,
  problems: string[],
): Promise<{ pin: Pin | null; version: string | null }> {
  try {
    const lookup = await ctx.findPin(repository);
    if (!lookup.found) {
      problems.push(`pin: ${lookup.reason}`);
      return { pin: null, version: null };
    }
    return { pin: lookup.pin, version: await ctx.versionAt(lookup.pin.sha) };
  } catch (error) {
    problems.push(`pin: ${messageOf(error)}`);
    return { pin: null, version: null };
  }
}

/** One repository's `talos.status/1`, or the error object when its state can't be read. */
export async function repoStatus(ctx: StatusContext, repository: Repository): Promise<Status> {
  const repo = repository.fullName;
  try {
    const [owner, name] = repo.split('/');
    const problems: string[] = [];
    const [raw, pinned] = await Promise.all([
      ctx.gh.graphql<unknown>(STATE_QUERY, { owner, name }),
      pinOf(ctx, repository, problems),
    ]);
    const state = stateSchema.parse(raw).repository;
    if (state.refs.totalCount > state.refs.nodes.length) {
      problems.push(`claims: only the ${state.refs.nodes.length} newest branches were read`);
    }
    const prefix = prefixOf(state.talosYml?.text, problems);
    const claimed = claimedBranches(
      state.refs.nodes.map((ref) => ref.name),
      prefix,
    ).slice(0, MAX_LISTED);
    const comments = await claimComments(
      ctx.gh,
      repo,
      claimed.map((c) => c.issue),
    );
    return buildStatus({
      repo,
      state,
      properties: {
        talos: propertyOf(repository, 'talos'),
        agents: propertyOf(repository, 'talos-agents'),
      },
      pin: pinned.pin,
      version: pinned.version,
      prefix,
      comments,
      who: ctx.who,
      problems,
    });
  } catch (error) {
    return { schema: STATUS_SCHEMA, repo, error: clip(messageOf(error), MAX_MESSAGE) };
  }
}

async function inBatches<T, R>(
  items: readonly T[],
  size: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += size) {
    results.push(...(await Promise.all(items.slice(start, start + size).map(work))));
  }
  return results;
}

/** The state of each named repository, in the order given. */
export async function statusOf(ctx: StatusContext, repos: readonly string[]): Promise<Status[]> {
  return inBatches(repos, 4, async (repo) => {
    try {
      return await repoStatus(ctx, await getRepository(ctx.gh, repo));
    } catch (error) {
      return { schema: STATUS_SCHEMA, repo, error: clip(messageOf(error), MAX_MESSAGE) };
    }
  });
}

/** Every governed repository the token can see: those whose `talos` property is set. */
export async function orgStatus(ctx: StatusContext): Promise<Status[]> {
  const governed = (await listOrgRepositories(ctx.gh, ctx.who.org))
    .filter((r) => !r.archived && propertyOf(r, 'talos') !== undefined)
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
  return inBatches(governed, 4, (repository) => repoStatus(ctx, repository));
}

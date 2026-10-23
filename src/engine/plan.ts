import { z } from 'zod';
import type { TalosConfig } from '../config/schema.js';
import type { Os, Tier } from '../core/check.js';
import { type Git, mergeBase, revList, revParse } from '../repo/git.js';

/**
 * - `draft`: a draft PR; its latest commit only, against the PR's base;
 * - `ready`: a PR ready for review; every commit against its parent, the head against the base;
 * - `merge-group`: the merge queue; as `ready`, for every commit the queue will push to main.
 */
export type Mode = 'draft' | 'ready' | 'merge-group';

type RunSpec = { readonly sha: string; readonly tiers: readonly Tier[]; readonly os: Os };

export type GatePlan = {
  readonly mode: Mode;
  readonly base: string;
  readonly head: string;
  /** The commits judged one by one, oldest first; empty for a draft. */
  readonly commits: readonly string[];
  /** The PR's branch, which names its ticket. */
  readonly branch?: string | undefined;
  readonly runs: readonly RunSpec[];
};

const pullRequestEvent = z.object({
  pull_request: z.object({
    draft: z.boolean().default(false),
    base: z.object({ sha: z.string() }),
    head: z.object({ sha: z.string(), ref: z.string() }),
  }),
});

const mergeGroupEvent = z.object({
  merge_group: z.object({ base_sha: z.string(), head_sha: z.string(), head_ref: z.string() }),
});

function osesOf(config: TalosConfig): Os[] {
  const all = new Set<Os>(['linux']);
  for (const component of config.components) for (const os of component.os) all.add(os);
  return [...all];
}

function runsFor(
  range: { mode: Mode; base: string; head: string; commits: readonly string[] },
  oses: readonly Os[],
): RunSpec[] {
  const { mode, base, head, commits } = range;
  const both: Tier[] = ['commit', 'head'];
  const middle = mode === 'draft' ? [] : commits.filter((sha) => sha !== head);
  return oses.flatMap((os) => [
    { sha: base, tiers: both, os },
    ...middle.map((sha) => ({ sha, tiers: ['commit'] as Tier[], os })),
    { sha: head, tiers: both, os },
  ]);
}

/** Plans the gate's runs from the event GitHub delivered (`GITHUB_EVENT_PATH`). */
export async function planFromEvent(
  eventName: string,
  payload: unknown,
  repo: Git,
  config: TalosConfig,
): Promise<GatePlan> {
  let mode: Mode;
  let tipOfBase: string;
  let head: string;
  let branch: string | undefined;
  if (eventName === 'merge_group') {
    const event = mergeGroupEvent.parse(payload).merge_group;
    mode = 'merge-group';
    tipOfBase = event.base_sha;
    head = event.head_sha;
  } else if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    const event = pullRequestEvent.parse(payload).pull_request;
    mode = event.draft ? 'draft' : 'ready';
    tipOfBase = event.base.sha;
    head = event.head.sha;
    branch = event.head.ref;
  } else {
    throw new Error(`the gate runs on pull_request and merge_group, not ${eventName}`);
  }
  return planRange(repo, config, { mode, tipOfBase, head, ...(branch ? { branch } : {}) });
}

export async function planRange(
  repo: Git,
  config: TalosConfig,
  range: { mode: Mode; tipOfBase: string; head: string; branch?: string },
): Promise<GatePlan> {
  const head = await revParse(repo, range.head);
  const base = await mergeBase(repo, range.tipOfBase, head);
  const commits = range.mode === 'draft' ? [] : await revList(repo, base, head);
  return {
    mode: range.mode,
    base,
    head,
    commits,
    ...(range.branch ? { branch: range.branch } : {}),
    runs: runsFor({ mode: range.mode, base, head, commits }, osesOf(config)),
  };
}

export const gatePlanSchema = z.object({
  mode: z.enum(['draft', 'ready', 'merge-group']),
  base: z.string(),
  head: z.string(),
  commits: z.array(z.string()),
  branch: z.string().optional(),
  runs: z.array(
    z.object({
      sha: z.string(),
      tiers: z.array(z.enum(['commit', 'head'])),
      os: z.enum(['linux', 'windows', 'macos']),
    }),
  ),
});

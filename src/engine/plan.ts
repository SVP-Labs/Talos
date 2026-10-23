import { posix } from 'node:path';
import { z } from 'zod';
import { compareVersions } from '../checks/runtime/versions.js';
import { CONFIG_FILE, ConfigError, parseConfig } from '../config/load.js';
import type { TalosConfig } from '../config/schema.js';
import type { Lang, Os, Tier } from '../core/check.js';
import { type Git, mergeBase, revList, revParse, showFile } from '../repo/git.js';

/**
 * - `draft`: a draft PR; its latest commit only, against the PR's base;
 * - `ready`: a PR ready for review; every commit against its parent, the head against the base;
 * - `merge-group`: the merge queue; as `ready`, for every commit the queue will push to main.
 */
export type Mode = 'draft' | 'ready' | 'merge-group';

/** The oldest PHP the PHP toolchain installs on: a run that needs PHP never gets an older one. */
const PHP_FLOOR = '8.4';

/** What a run sets up before Talos runs, read from `talos.yml` at the run's own commit. */
type Needs = {
  /** The languages of the components on the run's OS, in `talos.yml`'s order. */
  readonly langs: readonly Lang[];
  /** The PHP minor to set up, such as `8.4`, or `''` when no PHP component is on the run's OS. */
  readonly php: string;
};

type RunSpec = Needs & { readonly sha: string; readonly tiers: readonly Tier[]; readonly os: Os };

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

/** A constraint Composer can read; any other value (`false` hides the platform PHP) asks none. */
const constraint = z.string().optional().catch(undefined);

/** The PHP a `composer.json` asks for: `config.platform.php`, else `require.php`. */
const composerPhp = z.object({
  config: z.object({ platform: z.object({ php: constraint }).optional() }).optional(),
  require: z.object({ php: constraint }).optional(),
});

type Component = { readonly lang: Lang; readonly os: readonly Os[]; readonly php?: string };

/** The first minor a version constraint names: `8.5` of `^8.5`, `8.4` of `~8.4.1 || ^8.5`. */
function firstMinor(range: string): string | undefined {
  for (const release of range.split(/[^\d.]+/)) {
    const [major, minor] = release.split('.');
    if (major && minor) return `${major}.${minor}`;
  }
  return undefined;
}

/** The minor of PHP a `composer.json` asks for, or nothing. */
function minorAsked(text: string): string | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const asked = composerPhp.safeParse(json).data;
  return firstMinor(asked?.config?.platform?.php ?? asked?.require?.php ?? '');
}

/**
 * The components `talos.yml` declares at a commit, each PHP one with the minor its
 * `composer.json` there asks for. A commit with no `talos.yml`, such as the base of the PR that
 * adopts Talos, takes the head's, as its run does; one whose `talos.yml` can't be read declares
 * none, so its run sets nothing up and reports the file itself.
 */
async function componentsAt(repo: Git, sha: string, head: string): Promise<Component[]> {
  const text =
    (await showFile(repo, sha, CONFIG_FILE)) ?? (await showFile(repo, head, CONFIG_FILE));
  if (text === undefined) return [];
  let config: TalosConfig;
  try {
    config = parseConfig(text);
  } catch (error) {
    if (error instanceof ConfigError) return [];
    throw error;
  }
  return Promise.all(
    config.components.map(async ({ lang, root, os }): Promise<Component> => {
      if (lang !== 'php') return { lang, os };
      const composer = await showFile(repo, sha, posix.join(root, 'composer.json'));
      const php = composer === undefined ? undefined : minorAsked(composer);
      return php === undefined ? { lang, os } : { lang, os, php };
    }),
  );
}

function needsOn(components: readonly Component[], os: Os): Needs {
  const here = components.filter((c) => c.os.includes(os));
  const langs = [...new Set(here.map((c) => c.lang))];
  if (!langs.includes('php')) return { langs, php: '' };
  const php = here.reduce(
    (newest, { php: asked }) =>
      asked !== undefined && compareVersions(asked, newest) > 0 ? asked : newest,
    PHP_FLOOR,
  );
  return { langs, php };
}

function osesOf(config: TalosConfig): Os[] {
  const all = new Set<Os>(['linux']);
  for (const component of config.components) for (const os of component.os) all.add(os);
  return [...all];
}

async function runsFor(
  repo: Git,
  range: { mode: Mode; base: string; head: string; commits: readonly string[] },
  oses: readonly Os[],
): Promise<RunSpec[]> {
  const { mode, base, head, commits } = range;
  const both: Tier[] = ['commit', 'head'];
  const middle = mode === 'draft' ? [] : commits.filter((sha) => sha !== head);
  const judged = [
    { sha: base, tiers: both },
    ...middle.map((sha) => ({ sha, tiers: ['commit'] as Tier[] })),
    { sha: head, tiers: both },
  ];
  const declared = await Promise.all(
    judged.map(async (run) => ({ ...run, components: await componentsAt(repo, run.sha, head) })),
  );
  return oses.flatMap((os) =>
    declared.map(({ components, ...run }) => ({ ...run, os, ...needsOn(components, os) })),
  );
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

/**
 * Plans the runs between the base and a head: on every OS `config` declares, each judged commit
 * with what its own `talos.yml` says the run needs, since base and head may differ.
 */
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
    runs: await runsFor(repo, { mode: range.mode, base, head, commits }, osesOf(config)),
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
      langs: z.array(z.enum(['ts', 'py', 'php', 'lua', 'rust'])),
      php: z.string(),
    }),
  ),
});

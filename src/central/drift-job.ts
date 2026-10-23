import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { channelsMismatch, readChannelsFile } from './channels-file.js';
import type { Channel, Pins } from './channels.js';
import {
  CALLER_PATH,
  CODEOWNERS_PATHS,
  type Difference,
  differences,
  DRIFT_LABEL,
  driftIssue,
  type DriftState,
  type Expected,
  GOVERNED_SETTINGS,
  MERGE_QUEUE_RULESET,
  OWNER_REVIEW_RULESET,
  reconcile,
} from './drift.js';
import { pinsOf, readChannelRulesets } from './org-rulesets.js';
import { CentralError, closeIssue, isGoverned, openTalosIssues, soleRepository } from './repos.js';
import { type GitHub, GitHubError } from '../github/api.js';
import { readFileAt } from '../github/contents.js';
import type { Identities } from '../github/identities.js';
import { getRepository, propertyOf, type Repository } from '../github/repos.js';
import { fileIssue } from '../jobs/talos-issues.js';
import { assetsDir } from '../version/self.js';

export type DriftDeps = {
  /** `talos-release`, limited to the repository: administration read. */
  readonly release: GitHub;
  /** `talos-reviewer`, limited to the same repository: contents read, issues write. */
  readonly reviewer: GitHub;
  readonly who: Identities;
  readonly expected: Expected;
};

/** Counts only, as every central job prints. */
export type DriftReport = {
  readonly governed: number;
  readonly differences: number;
  readonly filed: number;
  readonly closed: number;
};

function parsedJson(text: string): unknown {
  return JSON.parse(text);
}

/** What `talos govern` writes, read from the assets this release ships. */
export async function expectedFromAssets(owner: string, dir: URL = assetsDir()): Promise<Expected> {
  const text = (path: string): Promise<string> => readFile(new URL(path, dir), 'utf8');
  const [caller, codeowners, mergeQueue] = await Promise.all([
    text('workflows/talos.yml'),
    text('codeowners'),
    text('rulesets/merge-queue.json'),
  ]);
  return {
    settings: GOVERNED_SETTINGS,
    caller,
    codeowners: codeowners.replaceAll('@OWNER', `@${owner}`),
    mergeQueue: parsedJson(mergeQueue),
  };
}

/** Dependabot alerts: 204 when on, 404 when off; anything else leaves it unknown. */
async function alertsOn(gh: GitHub, repo: string): Promise<boolean | undefined> {
  try {
    await gh.request('GET', `repos/${repo}/vulnerability-alerts`);
    return true;
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return false;
    return undefined;
  }
}

const summariesSchema = z.array(z.object({ id: z.number().int(), name: z.string() }));
const OWN_RULESETS: ReadonlySet<string> = new Set([MERGE_QUEUE_RULESET, OWNER_REVIEW_RULESET]);

async function ownRulesets(gh: GitHub, repo: string): Promise<Record<string, unknown>> {
  const summaries = summariesSchema.parse(
    await gh.paginate<unknown>(`repos/${repo}/rulesets?includes_parents=false`),
  );
  const found: Record<string, unknown> = {};
  for (const summary of summaries.filter((s) => OWN_RULESETS.has(s.name))) {
    found[summary.name] = await gh.request<unknown>('GET', `repos/${repo}/rulesets/${summary.id}`);
  }
  return found;
}

async function codeownersText(gh: GitHub, repo: string, ref: string): Promise<string | undefined> {
  for (const path of CODEOWNERS_PATHS) {
    const text = await readFileAt(gh, repo, path, ref);
    if (text !== undefined) return text;
  }
  return undefined;
}

async function readDriftState(deps: DriftDeps, repository: Repository): Promise<DriftState> {
  const repo = repository.fullName;
  const ref = repository.defaultBranch;
  const [settings, alerts, caller, codeowners, rulesets] = await Promise.all([
    deps.release.request<unknown>('GET', `repos/${repo}`),
    alertsOn(deps.release, repo),
    readFileAt(deps.reviewer, repo, CALLER_PATH, ref),
    codeownersText(deps.reviewer, repo, ref),
    ownRulesets(deps.release, repo),
  ]);
  return {
    settings: z.record(z.string(), z.unknown()).parse(settings),
    alerts,
    channel: propertyOf(repository, 'talos'),
    caller,
    codeowners,
    rulesets,
  };
}

type Scope = {
  readonly gh: GitHub;
  readonly repo: string;
  readonly who: Identities;
  readonly owns: (key: string) => boolean;
};

/** Files what is new and closes what is gone; returns how many of each. */
async function settle(scope: Scope, diffs: readonly Difference[]) {
  const open = await openTalosIssues(scope.gh, { repo: scope.repo, who: scope.who }, DRIFT_LABEL);
  const plan = reconcile(diffs, open, scope.owns);
  for (const diff of plan.file) await fileIssue(scope.gh, scope.repo, driftIssue(diff));
  for (const number of plan.close) await closeIssue(scope.gh, scope.repo, number);
  return { filed: plan.file.length, closed: plan.close.length };
}

const CHANNELS_KEY = 'channels-json:';

/** One governed repository's drift report, filed in that repository. */
export async function runDrift(deps: DriftDeps): Promise<DriftReport> {
  const repository = await soleRepository(deps.release);
  const scoped = await soleRepository(deps.reviewer);
  if (scoped.id !== repository.id) {
    throw new CentralError('the two tokens reach different repositories');
  }
  if (!isGoverned(repository)) return { governed: 0, differences: 0, filed: 0, closed: 0 };
  const diffs = differences(await readDriftState(deps, repository), deps.expected);
  const settled = await settle(
    {
      gh: deps.reviewer,
      repo: repository.fullName,
      who: deps.who,
      owns: (key) => !key.startsWith(CHANNELS_KEY),
    },
    diffs,
  );
  return { governed: 1, differences: diffs.length, ...settled };
}

export type ChannelsFileDeps = {
  /** `talos-release`, organisation-wide: organisation administration read. */
  readonly release: GitHub;
  /** `talos-reviewer`, limited to the Talos repository: contents read, issues write. */
  readonly reviewer: GitHub;
  readonly who: Identities;
};

function fileDifferences(mismatched: readonly Channel[], pins: Pins): Difference[] {
  return mismatched.map((channel) => ({
    key: `${CHANNELS_KEY}${channel}`,
    what: `\`channels.json\`'s ${channel} pin`,
    expected: pins[channel] ?? 'no pin',
    actual: 'a different commit, or none',
  }));
}

/** In the `channels.json` lookup, whether the file still says what the rulesets pin. */
export async function runChannelsFileDrift(deps: ChannelsFileDeps): Promise<DriftReport> {
  const talos = await getRepository(deps.release, deps.who.talosRepo);
  const pins = pinsOf(await readChannelRulesets(deps.release, deps.who.org), talos.id);
  const file = await readChannelsFile(deps.reviewer, deps.who.talosRepo);
  const diffs = fileDifferences(channelsMismatch(file?.text, pins), pins);
  const settled = await settle(
    {
      gh: deps.reviewer,
      repo: deps.who.talosRepo,
      who: deps.who,
      owns: (key) => key.startsWith(CHANNELS_KEY),
    },
    diffs,
  );
  return { governed: 1, differences: diffs.length, ...settled };
}

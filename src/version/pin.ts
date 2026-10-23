import { z } from 'zod';
import type { GitHub } from '../github/api.js';
import { readFileAt } from '../github/contents.js';
import { getRepository, propertyOf, type Repository } from '../github/repos.js';
import { getRuleset, listRulesets, requiredWorkflows, type Ruleset } from '../github/rulesets.js';

/**
 * How the enforced Talos commit is found for a repository.
 *
 * - `rulesets`, the default: the repository's rulesets, the organisation's included, listed with
 *   `includes_parents=true` and read one by one. Disabled ones are skipped; `evaluate` and
 *   `active` count. Exactly one of them may carry a `workflows` rule whose workflow lives in the
 *   Talos repository (matched by repository id); its `sha` is the pin.
 * - `channels`, chosen by `TALOS_LOOKUP=channels`, for an organisation where that listing hides
 *   rulesets in Evaluate mode: the repository's `talos` custom property names its channel, and
 *   `channels.json` on the Talos repository's `channels` branch
 *   (`{ "evaluate": sha, "canary": sha, "stable": sha }`) gives the channel's pin. Only
 *   `talos-release` can write that branch.
 */
export type LookupMode = 'rulesets' | 'channels';

export const CHANNELS = ['evaluate', 'canary', 'stable'] as const;
export type Channel = (typeof CHANNELS)[number];

export type Pin = {
  /** The Talos commit the gate runs at: always a release tag's commit. */
  readonly sha: string;
  /** The ruleset that pins it, or `channels.json`. */
  readonly source: string;
  /** `active` or `evaluate`. */
  readonly enforcement: string;
  /** The gate workflow's path in the Talos repository; `null` in `channels` mode. */
  readonly path: string | null;
  readonly channel: Channel | null;
};

export type PinLookup =
  { readonly found: true; readonly pin: Pin } | { readonly found: false; readonly reason: string };

const SHA = /^[0-9a-f]{40}$/;
const CHANNELS_FILE = 'channels.json';
const CHANNELS_BRANCH = 'channels';

const channelsSchema = z.object({
  evaluate: z.string().regex(SHA),
  canary: z.string().regex(SHA),
  stable: z.string().regex(SHA),
});

function notFound(reason: string): PinLookup {
  return { found: false, reason };
}

export function asChannel(value: string | undefined): Channel | null {
  return CHANNELS.find((channel) => channel === value) ?? null;
}

export function lookupMode(env: Readonly<Record<string, string | undefined>>): LookupMode {
  const value = env.TALOS_LOOKUP;
  if (value === undefined || value === '' || value === 'rulesets') return 'rulesets';
  if (value === 'channels') return 'channels';
  throw new TypeError(`TALOS_LOOKUP must be "rulesets" or "channels", not "${value}"`);
}

/** The pin among the rulesets that apply to a repository, by the Talos repository's id. */
export function selectPin(rulesets: readonly Ruleset[], talosRepositoryId: number): PinLookup {
  const matches = rulesets
    .filter((ruleset) => ruleset.enforcement !== 'disabled')
    .map((ruleset) => ({
      ruleset,
      workflows: requiredWorkflows(ruleset).filter((w) => w.repository_id === talosRepositoryId),
    }))
    .filter((match) => match.workflows.length > 0);
  const [match] = matches;
  if (match === undefined) {
    return notFound('no ruleset that applies to this repository runs the Talos gate');
  }
  if (matches.length > 1) {
    const names = matches.map((m) => m.ruleset.name).join(', ');
    return notFound(`${matches.length} Talos rulesets apply (${names}); exactly one must`);
  }
  const { ruleset, workflows } = match;
  const shas = new Set(workflows.map((w) => w.sha));
  const [workflow] = workflows;
  if (shas.size > 1 || workflow === undefined) {
    return notFound(`ruleset ${ruleset.name} pins Talos at ${shas.size} different commits`);
  }
  if (workflow.sha === undefined || !SHA.test(workflow.sha)) {
    return notFound(`ruleset ${ruleset.name} runs Talos at a ref, not a commit SHA`);
  }
  return {
    found: true,
    pin: {
      sha: workflow.sha,
      source: ruleset.name,
      enforcement: ruleset.enforcement,
      path: workflow.path,
      channel: asChannel(/^talos-(\w+)$/.exec(ruleset.name)?.[1]),
    },
  };
}

/** The pin from `channels.json` for the channel a repository's `talos` property names. */
export function selectChannelPin(property: string | undefined, channels: unknown): PinLookup {
  if (property === undefined) return notFound('the repository has no `talos` property');
  const channel = asChannel(property);
  if (channel === null) return notFound(`the \`talos\` property is "${property}", not a channel`);
  const parsed = channelsSchema.safeParse(channels);
  if (!parsed.success) return notFound(`${CHANNELS_FILE} does not map every channel to a commit`);
  return {
    found: true,
    pin: {
      sha: parsed.data[channel],
      source: CHANNELS_FILE,
      enforcement: channel === 'evaluate' ? 'evaluate' : 'active',
      path: null,
      channel,
    },
  };
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Finds pins for repositories, reading the Talos repository's id or `channels.json` once. */
export type PinFinder = (repo: string | Repository) => Promise<PinLookup>;

export function pinFinder(gh: GitHub, talosRepo: string, mode: LookupMode): PinFinder {
  let talosId: Promise<number> | undefined;
  let channels: Promise<unknown> | undefined;
  const byRulesets = async (repo: string): Promise<PinLookup> => {
    talosId ??= getRepository(gh, talosRepo).then((r) => r.id);
    const summaries = await listRulesets(gh, repo);
    const live = summaries.filter((summary) => summary.enforcement !== 'disabled');
    const details = await Promise.all(live.map((summary) => getRuleset(gh, repo, summary.id)));
    return selectPin(details, await talosId);
  };
  const byChannels = async (repo: string | Repository): Promise<PinLookup> => {
    channels ??= readFileAt(gh, talosRepo, CHANNELS_FILE, CHANNELS_BRANCH).then(parseJson);
    const repository = typeof repo === 'string' ? await getRepository(gh, repo) : repo;
    return selectChannelPin(propertyOf(repository, 'talos'), await channels);
  };
  return (repo) => {
    if (mode === 'channels') return byChannels(repo);
    return byRulesets(typeof repo === 'string' ? repo : repo.fullName);
  };
}

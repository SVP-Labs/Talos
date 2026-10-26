import { z } from 'zod';
import { covers } from './compare.js';
import { appSlug } from './installations.js';
import { GovernRefusal } from './plan.js';
import { type LiveRuleset, readRulesets } from './rulesets-api.js';
import { change, manual, ok, rulesetStep, type Step } from './steps.js';
import {
  type Channel,
  channelRuleset,
  channelRulesetName,
  CHANNELS,
  channelsBranchRuleset,
  type ChannelIds,
  pinOf,
  type Templates,
} from './templates.js';
import type { GitHub } from '../github/api.js';
import type { Identities } from '../github/identities.js';
import { type LookupMode, lookupMode } from '../version/pin.js';

/**
 * The organisation's side of Talos: the two custom properties every governed repository carries,
 * the three channel rulesets that run the gate, and the Talos repository's own rulesets (only the
 * owner tags a release; nothing lands on `main` until the PR's own engine passed its checks and
 * self-test; and, in the `channels.json` lookup only, only `talos-release` writes the `channels`
 * branch).
 */
export const PROPERTY_DEFINITIONS: Readonly<Record<string, Record<string, unknown>>> = {
  talos: {
    value_type: 'single_select',
    required: false,
    allowed_values: [...CHANNELS],
    values_editable_by: 'org_actors',
    description: 'The Talos channel whose org ruleset runs the gate on this repository',
  },
  'talos-agents': {
    value_type: 'true_false',
    required: false,
    values_editable_by: 'org_actors',
    description: 'Whether Thea implements here and the reviewer adds its AI review',
  },
};

export type OrgState = {
  readonly org: string;
  readonly talosRepo: string;
  readonly ids: ChannelIds;
  readonly releaseAppId: number;
  /** How the gate finds its pin: the organisation's `TALOS_LOOKUP` Actions variable. */
  readonly lookup: LookupMode;
  /** The property definitions the organisation has, by name. */
  readonly definitions: Readonly<Record<string, unknown>>;
  readonly channels: readonly LiveRuleset[];
  readonly talosRulesets: readonly LiveRuleset[];
  /** Every `v*` tag of the Talos repository and its commit. */
  readonly releases: readonly { readonly tag: string; readonly sha: string }[];
};

const idSchema = z.object({ id: z.number().int() });
const definitionsSchema = z.array(z.looseObject({ property_name: z.string() }));
const tagsSchema = z.array(z.object({ name: z.string(), commit: z.object({ sha: z.string() }) }));
const variableSchema = z.object({ value: z.string() });

const CHANNEL_NAMES = CHANNELS.map(channelRulesetName);

/**
 * The lookup the organisation's workflows use: its `TALOS_LOOKUP` Actions variable, the same one
 * they read as `vars.TALOS_LOOKUP`, `rulesets` when it isn't set.
 */
export async function orgLookup(gh: GitHub, org: string): Promise<LookupMode> {
  const path = `orgs/${encodeURIComponent(org)}/actions/variables/TALOS_LOOKUP`;
  const variable = await gh.request<unknown>('GET', path, { allowMissing: true });
  if (variable === undefined) return 'rulesets';
  const value = variableSchema.parse(variable).value;
  try {
    return lookupMode({ TALOS_LOOKUP: value });
  } catch {
    throw new GovernRefusal(
      `${org}'s TALOS_LOOKUP variable is "${value}": set rulesets or channels`,
    );
  }
}

export async function releasesOf(gh: GitHub, talosRepo: string): Promise<OrgState['releases']> {
  const tags = tagsSchema.parse(await gh.paginate<unknown>(`repos/${talosRepo}/tags`));
  return tags.filter((t) => /^v\d/.test(t.name)).map((t) => ({ tag: t.name, sha: t.commit.sha }));
}

export async function channelRulesets(gh: GitHub, org: string): Promise<LiveRuleset[]> {
  return readRulesets(gh, { kind: 'org', org }, CHANNEL_NAMES);
}

export async function readOrgState(gh: GitHub, who: Identities, templates: Templates) {
  const org = encodeURIComponent(who.org);
  const tagNames = [
    templates.releaseTags.name,
    templates.channelsBranch.name,
    templates.selfTest.name,
  ];
  const [talos, reviewer, release, lookup, definitions, channels, talosRulesets, releases] =
    await Promise.all([
      gh.request<unknown>('GET', `repos/${who.talosRepo}`),
      gh.request<unknown>('GET', `apps/${appSlug(who, 'reviewer')}`),
      gh.request<unknown>('GET', `apps/${appSlug(who, 'release')}`),
      orgLookup(gh, who.org),
      gh.paginate<unknown>(`orgs/${org}/properties/schema`),
      channelRulesets(gh, who.org),
      readRulesets(gh, { kind: 'repo', repo: who.talosRepo }, tagNames),
      releasesOf(gh, who.talosRepo),
    ]);
  const state: OrgState = {
    org: who.org,
    talosRepo: who.talosRepo,
    ids: {
      talosRepositoryId: idSchema.parse(talos).id,
      reviewerAppId: idSchema.parse(reviewer).id,
    },
    releaseAppId: idSchema.parse(release).id,
    lookup,
    definitions: Object.fromEntries(
      definitionsSchema.parse(definitions).map((d) => [d.property_name, d]),
    ),
    channels,
    talosRulesets,
    releases,
  };
  return state;
}

function propertySteps(state: OrgState): Step[] {
  return Object.entries(PROPERTY_DEFINITIONS).map(([name, body]) => {
    const id = `property:${name}`;
    const current = state.definitions[name];
    if (current !== undefined && covers(current, body)) return ok(id, `${name} is defined`);
    const verb = current === undefined ? 'define' : 'update';
    return change(id, `${verb} the ${name} property`, {
      kind: 'define-property',
      org: state.org,
      name,
      body,
    });
  });
}

/** Refuses a seed that isn't a release tag's commit: a pin only ever points at a release. */
export function checkSeed(state: OrgState, seed: string | undefined): void {
  if (seed === undefined) return;
  if (!state.releases.some((release) => release.sha === seed)) {
    throw new GovernRefusal(`--seed ${seed} is not the commit of a v* tag on ${state.talosRepo}`);
  }
}

function channelStep(state: OrgState, templates: Templates, channel: Channel, seed?: string) {
  const name = channelRulesetName(channel);
  const current = state.channels.find((ruleset) => ruleset.name === name);
  const pin = (current === undefined ? undefined : pinOf(current.rules)) ?? seed;
  if (pin === undefined) {
    return manual(`ruleset:${name}`, `${name} needs a first pin: talos org init --seed <sha>`);
  }
  const scope = { kind: 'org', org: state.org } as const;
  return rulesetStep(scope, current, channelRuleset(templates.channel, channel, pin, state.ids));
}

type Find = (name: string) => LiveRuleset | undefined;

/**
 * The `channels` branch ruleset, which only the `channels.json` lookup needs: there `talos-release`
 * holds Contents write and is the one actor that may push the branch. In the rulesets lookup
 * nothing writes that branch and the App has no Contents permission, so nothing is set up.
 */
function channelsBranchStep(state: OrgState, templates: Templates, find: Find): Step {
  const name = templates.channelsBranch.name;
  if (state.lookup !== 'channels') {
    return ok(`ruleset:${name}`, `${name} is only needed with TALOS_LOOKUP=channels`);
  }
  const body = channelsBranchRuleset(templates.channelsBranch, state.releaseAppId);
  return rulesetStep({ kind: 'repo', repo: state.talosRepo }, find(name), body);
}

/**
 * What `talos org init` does: the properties first, which the channel rulesets target; then the
 * three channel rulesets, each keeping the pin it has (pins move only through the release jobs)
 * or taking the seed; then the Talos repository's own rulesets.
 */
export function orgPlan(state: OrgState, templates: Templates, seed?: string): Step[] {
  checkSeed(state, seed);
  const talos = { kind: 'repo', repo: state.talosRepo } as const;
  const find: Find = (name) => state.talosRulesets.find((ruleset) => ruleset.name === name);
  return [
    ...propertySteps(state),
    ...CHANNELS.map((channel) => channelStep(state, templates, channel, seed)),
    rulesetStep(talos, find(templates.releaseTags.name), templates.releaseTags),
    rulesetStep(talos, find(templates.selfTest.name), templates.selfTest),
    channelsBranchStep(state, templates, find),
  ];
}

export type PinReport = {
  readonly channel: Channel;
  readonly sha: string | null;
  readonly tag: string | null;
  readonly enforcement: string | null;
};

/** Each channel's pin, and the release tag it is. */
export function pinsOf(
  channels: readonly LiveRuleset[],
  releases: OrgState['releases'],
): PinReport[] {
  return CHANNELS.map((channel) => {
    const ruleset = channels.find((r) => r.name === channelRulesetName(channel));
    const sha = ruleset === undefined ? undefined : pinOf(ruleset.rules);
    const tag = releases.find((release) => release.sha === sha)?.tag;
    return {
      channel,
      sha: sha ?? null,
      tag: tag ?? null,
      enforcement: ruleset?.enforcement ?? null,
    };
  });
}

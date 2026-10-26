import { z } from 'zod';
import { type Channel, CHANNELS, type Pins } from './channels.js';
import type { GitHub } from '../github/api.js';

/**
 * The three channel rulesets of the organisation: reading their pins and history, and moving a
 * pin. Moving one needs organisation administration, which only `talos-release` holds.
 */

const SHA = /^[0-9a-f]{40}$/;

const summarySchema = z.object({ id: z.number().int(), name: z.string() });

const ruleSchema = z.looseObject({ type: z.string(), parameters: z.unknown().optional() });

const detailSchema = z.looseObject({
  id: z.number().int(),
  name: z.string(),
  target: z.string().optional(),
  enforcement: z.string(),
  bypass_actors: z.array(z.unknown()).optional(),
  conditions: z.unknown().optional(),
  rules: z.array(ruleSchema).default([]),
});

/** Loose, so a move keeps every field GitHub has and Talos doesn't know. */
const workflowsParameters = z.looseObject({
  workflows: z.array(
    z.looseObject({
      repository_id: z.number().int(),
      sha: z.string().optional(),
      ref: z.string().optional(),
    }),
  ),
});

const versionSchema = z.object({ version_id: z.number().int(), updated_at: z.string() });

const versionDetailSchema = z.object({
  updated_at: z.string(),
  state: z.looseObject({ rules: z.array(ruleSchema).default([]) }),
});

type Rule = z.infer<typeof ruleSchema>;
export type OrgRuleset = z.infer<typeof detailSchema>;

export function channelRulesetName(channel: Channel): string {
  return `talos-${channel}`;
}

/** The commit a ruleset runs Talos's gate at, when its workflows rules agree on exactly one. */
export function pinOfRules(rules: readonly Rule[], talosId: number): string | undefined {
  const shas = new Set<string>();
  for (const rule of rules) {
    if (rule.type !== 'workflows') continue;
    const parsed = workflowsParameters.safeParse(rule.parameters);
    if (!parsed.success) continue;
    for (const workflow of parsed.data.workflows) {
      if (workflow.repository_id === talosId) shas.add(workflow.sha ?? '');
    }
  }
  const [only] = shas;
  return shas.size === 1 && only !== undefined && SHA.test(only) ? only : undefined;
}

/** The rules with each workflow from the Talos repository pinned at `sha`, nothing else changed. */
export function withPin(rules: readonly Rule[], talosId: number, sha: string): Rule[] {
  return rules.map((rule) => {
    if (rule.type !== 'workflows') return rule;
    const parsed = workflowsParameters.safeParse(rule.parameters);
    if (!parsed.success) return rule;
    const workflows = parsed.data.workflows.map((workflow) => {
      if (workflow.repository_id !== talosId) return workflow;
      const { ref: _ref, ...rest } = workflow;
      return { ...rest, sha };
    });
    return { ...rule, parameters: { ...parsed.data, workflows } };
  });
}

/** The body the update endpoint takes: the ruleset as it is, its Talos pin moved. */
export function movedBody(
  ruleset: OrgRuleset,
  talosId: number,
  sha: string,
): Record<string, unknown> {
  return {
    name: ruleset.name,
    ...(ruleset.target === undefined ? {} : { target: ruleset.target }),
    enforcement: ruleset.enforcement,
    bypass_actors: ruleset.bypass_actors ?? [],
    ...(ruleset.conditions === undefined ? {} : { conditions: ruleset.conditions }),
    rules: withPin(ruleset.rules, talosId, sha),
  };
}

export type ChannelRulesets = Readonly<Record<Channel, OrgRuleset | undefined>>;

/** The organisation's channel rulesets, by channel; a channel without one is `undefined`. */
export async function readChannelRulesets(gh: GitHub, org: string): Promise<ChannelRulesets> {
  const at = `orgs/${encodeURIComponent(org)}/rulesets`;
  const summaries = z.array(summarySchema).parse(await gh.paginate<unknown>(at));
  const entries = await Promise.all(
    CHANNELS.map(async (channel) => {
      const summary = summaries.find((s) => s.name === channelRulesetName(channel));
      if (summary === undefined) return [channel, undefined] as const;
      const detail = detailSchema.parse(await gh.request<unknown>('GET', `${at}/${summary.id}`));
      return [channel, detail] as const;
    }),
  );
  return {
    evaluate: entries.find(([c]) => c === 'evaluate')?.[1],
    canary: entries.find(([c]) => c === 'canary')?.[1],
    stable: entries.find(([c]) => c === 'stable')?.[1],
  };
}

export function pinsOf(rulesets: ChannelRulesets, talosId: number): Pins {
  const pin = (channel: Channel): string | undefined => {
    const ruleset = rulesets[channel];
    return ruleset === undefined ? undefined : pinOfRules(ruleset.rules, talosId);
  };
  return { evaluate: pin('evaluate'), canary: pin('canary'), stable: pin('stable') };
}

export async function movePin(
  gh: GitHub,
  at: { readonly org: string; readonly talosId: number },
  ruleset: OrgRuleset,
  sha: string,
): Promise<void> {
  await gh.request('PUT', `orgs/${encodeURIComponent(at.org)}/rulesets/${ruleset.id}`, {
    body: movedBody(ruleset, at.talosId, sha),
  });
}

const HISTORY_DEPTH = 10;

/**
 * A ruleset's pins through its history, newest first, from GitHub's ruleset versions. Only the
 * newest few are read: enough to see when the current pin began.
 */
export async function pinHistory(
  gh: GitHub,
  at: { readonly org: string; readonly talosId: number },
  rulesetId: number,
  sha: string,
): Promise<{ at: string; sha: string | undefined }[]> {
  const base = `orgs/${encodeURIComponent(at.org)}/rulesets/${rulesetId}/history`;
  const versions = z
    .array(versionSchema)
    .parse(await gh.request<unknown>('GET', `${base}?per_page=${HISTORY_DEPTH}`));
  const pins: { at: string; sha: string | undefined }[] = [];
  for (const version of versions.slice(0, HISTORY_DEPTH)) {
    const detail = versionDetailSchema.parse(
      await gh.request<unknown>('GET', `${base}/${version.version_id}`),
    );
    const pin = pinOfRules(detail.state.rules, at.talosId);
    pins.push({ at: detail.updated_at, sha: pin });
    if (pin !== sha) break;
  }
  return pins;
}

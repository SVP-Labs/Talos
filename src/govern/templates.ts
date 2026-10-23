import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { workflowReferenceSchema } from '../github/rulesets.js';
import { assetsDir } from '../version/self.js';

/**
 * The rulesets Talos creates, kept as JSON templates under `assets/rulesets/`. Each API body is
 * built from its template by a pure function that fills in only what differs per organisation
 * (repository and App ids) or per channel (name, enforcement, pin).
 */

const bypassActorSchema = z.strictObject({
  actor_id: z.number().int().nullable().optional(),
  actor_type: z.enum(['Integration', 'OrganizationAdmin', 'RepositoryRole', 'Team', 'User']),
  bypass_mode: z.enum(['always', 'pull_request', 'exempt']),
});

const ruleSchema = z.strictObject({
  type: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

const refNameSchema = z.strictObject({
  include: z.array(z.string()),
  exclude: z.array(z.string()),
});

const propertySpecSchema = z.strictObject({
  name: z.string(),
  property_values: z.array(z.string()),
});

const conditionsSchema = z.strictObject({
  ref_name: refNameSchema,
  repository_property: z
    .strictObject({ include: z.array(propertySpecSchema), exclude: z.array(propertySpecSchema) })
    .optional(),
});

const rulesetBodySchema = z.strictObject({
  name: z.string().min(1),
  target: z.enum(['branch', 'tag', 'push']),
  enforcement: z.enum(['disabled', 'active', 'evaluate']),
  bypass_actors: z.array(bypassActorSchema),
  conditions: conditionsSchema,
  rules: z.array(ruleSchema).min(1),
});

/** A ruleset as the create and update endpoints take it. */
export type RulesetBody = z.infer<typeof rulesetBodySchema>;
type Rule = z.infer<typeof ruleSchema>;

export type Templates = {
  /** The repository ruleset that requires the merge queue (no bypass). */
  readonly mergeQueue: RulesetBody;
  /** The repository ruleset that requires the owner's approval while at `evaluate`. */
  readonly ownerReview: RulesetBody;
  /** The org ruleset of one channel, before its name, enforcement and pin are filled in. */
  readonly channel: RulesetBody;
  /** The Talos repository's tag ruleset: only the owner mints a release. */
  readonly releaseTags: RulesetBody;
  /** The Talos repository's `channels` branch, written by `talos-release` alone. */
  readonly channelsBranch: RulesetBody;
};

export function parseTemplate(name: string, text: string): RulesetBody {
  const parsed = rulesetBodySchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`assets/rulesets/${name}.json is invalid:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** Every ruleset template Talos ships, validated. */
export async function loadTemplates(dir: URL = assetsDir()): Promise<Templates> {
  const load = async (name: string): Promise<RulesetBody> =>
    parseTemplate(name, await readFile(new URL(`rulesets/${name}.json`, dir), 'utf8'));
  const [mergeQueue, ownerReview, channel, releaseTags, channelsBranch] = await Promise.all([
    load('merge-queue'),
    load('owner-review'),
    load('channel'),
    load('release-tags'),
    load('channels-branch'),
  ]);
  return { mergeQueue, ownerReview, channel, releaseTags, channelsBranch };
}

/** The channels a governed repository's `talos` property names, each with its org ruleset. */
export const CHANNELS = ['evaluate', 'canary', 'stable'] as const;
export type Channel = (typeof CHANNELS)[number];

const CHANNEL_NAMES: ReadonlySet<string> = new Set(CHANNELS);

export function isChannel(value: string | undefined): value is Channel {
  return value !== undefined && CHANNEL_NAMES.has(value);
}

export function channelRulesetName(channel: Channel): string {
  return `talos-${channel}`;
}

const workflowRefSchema = workflowReferenceSchema;
const workflowsParameters = z.object({ workflows: z.array(workflowRefSchema).min(1) });
const statusChecksParameters = z.object({
  strict_required_status_checks_policy: z.boolean(),
  required_status_checks: z
    .array(z.object({ context: z.string(), integration_id: z.number().int().optional() }))
    .min(1),
});

export type ChannelIds = {
  /** The Talos repository's id: the gate workflow lives there. */
  readonly talosRepositoryId: number;
  /** The `talos-reviewer` App's id, the only source `talos/review` is accepted from. */
  readonly reviewerAppId: number;
};

function pinRule(rule: Rule, sha: string, ids: ChannelIds): Rule {
  if (rule.type === 'workflows') {
    const parameters = workflowsParameters.parse(rule.parameters);
    const workflows = parameters.workflows.map((w) => ({
      path: w.path,
      repository_id: ids.talosRepositoryId,
      sha,
    }));
    return { type: rule.type, parameters: { ...parameters, workflows } };
  }
  if (rule.type === 'required_status_checks') {
    const parameters = statusChecksParameters.parse(rule.parameters);
    const checks = parameters.required_status_checks.map((check) => ({
      context: check.context,
      integration_id: ids.reviewerAppId,
    }));
    return { type: rule.type, parameters: { ...parameters, required_status_checks: checks } };
  }
  return rule;
}

/**
 * One of the three org rulesets: it runs the gate pinned at `sha` and requires `talos/review`
 * from the reviewer App, on the default branch of every repository whose `talos` property names
 * the channel. `talos-evaluate` is in Evaluate mode as a whole, so it blocks nothing.
 */
export function channelRuleset(
  template: RulesetBody,
  channel: Channel,
  sha: string,
  ids: ChannelIds,
): RulesetBody {
  const property = template.conditions.repository_property;
  if (property === undefined) throw new Error('the channel template targets no property');
  return {
    ...template,
    name: channelRulesetName(channel),
    enforcement: channel === 'evaluate' ? 'evaluate' : 'active',
    conditions: {
      ...template.conditions,
      repository_property: {
        ...property,
        include: property.include.map((spec) => ({ ...spec, property_values: [channel] })),
      },
    },
    rules: template.rules.map((rule) => pinRule(rule, sha, ids)),
  };
}

/** The pin a ruleset's `workflows` rule carries, or `undefined` when it has none. */
export function pinOf(
  rules: readonly { type: string; parameters?: unknown }[],
): string | undefined {
  for (const rule of rules) {
    if (rule.type !== 'workflows') continue;
    const parsed = workflowsParameters.safeParse(rule.parameters);
    const sha = parsed.success ? parsed.data.workflows[0]?.sha : undefined;
    if (sha !== undefined && /^[0-9a-f]{40}$/.test(sha)) return sha;
  }
  return undefined;
}

/** The `channels` branch of the Talos repository: only `talos-release` may write it. */
export function channelsBranchRuleset(template: RulesetBody, releaseAppId: number): RulesetBody {
  return {
    ...template,
    bypass_actors: template.bypass_actors.map((actor) =>
      actor.actor_type === 'Integration' ? { ...actor, actor_id: releaseAppId } : actor,
    ),
  };
}

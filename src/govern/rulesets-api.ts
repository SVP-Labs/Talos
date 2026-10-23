import { z } from 'zod';
import type { RulesetBody } from './templates.js';
import type { GitHub } from '../github/api.js';

/** Where a ruleset lives: one repository's own, or the organisation's. */
export type RulesetScope =
  { readonly kind: 'repo'; readonly repo: string } | { readonly kind: 'org'; readonly org: string };

const summarySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  source_type: z.string().optional(),
});

const detailSchema = z.looseObject({
  id: z.number().int(),
  name: z.string(),
  enforcement: z.string(),
  rules: z.array(z.object({ type: z.string(), parameters: z.unknown().optional() })).default([]),
});

/** A ruleset as GitHub returns it, with the fields Talos reads validated and the rest kept. */
export type LiveRuleset = z.infer<typeof detailSchema>;

function basePath(scope: RulesetScope): string {
  return scope.kind === 'repo'
    ? `repos/${scope.repo}/rulesets`
    : `orgs/${encodeURIComponent(scope.org)}/rulesets`;
}

/**
 * The scope's own rulesets among `names`, read in full. A repository's listing leaves out the
 * organisation's rulesets, which only `talos org` manages.
 */
export async function readRulesets(
  gh: GitHub,
  scope: RulesetScope,
  names: readonly string[],
): Promise<LiveRuleset[]> {
  const list =
    scope.kind === 'repo' ? `${basePath(scope)}?includes_parents=false` : basePath(scope);
  const summaries = z.array(summarySchema).parse(await gh.paginate<unknown>(list));
  const own = summaries.filter(
    (summary) =>
      names.includes(summary.name) &&
      (scope.kind === 'org' || (summary.source_type ?? 'Repository') === 'Repository'),
  );
  return Promise.all(
    own.map(async (summary) =>
      detailSchema.parse(await gh.request<unknown>('GET', `${basePath(scope)}/${summary.id}`)),
    ),
  );
}

export async function createRuleset(
  gh: GitHub,
  scope: RulesetScope,
  body: RulesetBody,
): Promise<number> {
  const created = await gh.request<unknown>('POST', basePath(scope), { body });
  return z.object({ id: z.number().int() }).parse(created).id;
}

export async function updateRuleset(
  gh: GitHub,
  scope: RulesetScope,
  id: number,
  body: RulesetBody,
): Promise<void> {
  await gh.request('PUT', `${basePath(scope)}/${id}`, { body });
}

export async function deleteRuleset(gh: GitHub, scope: RulesetScope, id: number): Promise<void> {
  await gh.request('DELETE', `${basePath(scope)}/${id}`, { allowMissing: true });
}

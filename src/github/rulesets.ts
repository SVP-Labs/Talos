import { z } from 'zod';
import type { GitHub } from './api.js';

const summarySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  enforcement: z.string(),
  source_type: z.string().optional(),
  source: z.string().optional(),
});

const workflowReferenceSchema = z.object({
  path: z.string(),
  repository_id: z.number().int(),
  ref: z.string().optional(),
  sha: z.string().optional(),
});

const ruleSchema = z.object({ type: z.string(), parameters: z.unknown().optional() });

const detailSchema = summarySchema.extend({
  target: z.string().optional(),
  rules: z.array(ruleSchema).default([]),
});

const workflowsParameters = z.object({ workflows: z.array(workflowReferenceSchema) });

export type RulesetSummary = z.infer<typeof summarySchema>;
export type Ruleset = z.infer<typeof detailSchema>;
export type WorkflowReference = z.infer<typeof workflowReferenceSchema>;

/**
 * The rulesets that apply to a repository, the organisation's included, in every enforcement
 * state: GitHub's branch-rules endpoint returns active rules only, so it would miss a ruleset in
 * Evaluate mode.
 */
export async function listRulesets(gh: GitHub, repo: string): Promise<RulesetSummary[]> {
  const raw = await gh.paginate<unknown>(`repos/${repo}/rulesets?includes_parents=true`);
  return z.array(summarySchema).parse(raw);
}

/** One ruleset with its rules, read through the repository so organisation rulesets work too. */
export async function getRuleset(gh: GitHub, repo: string, id: number): Promise<Ruleset> {
  const raw = await gh.request<unknown>(
    'GET',
    `repos/${repo}/rulesets/${id}?includes_parents=true`,
  );
  return detailSchema.parse(raw);
}

/** The workflows a ruleset's `workflows` rules require, in rule order. */
export function requiredWorkflows(ruleset: Ruleset): WorkflowReference[] {
  return ruleset.rules
    .filter((rule) => rule.type === 'workflows')
    .flatMap((rule) => {
      const parsed = workflowsParameters.safeParse(rule.parameters);
      return parsed.success ? parsed.data.workflows : [];
    });
}

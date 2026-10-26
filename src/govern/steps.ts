import { commitFiles, type FileChanges } from './commit.js';
import { rulesetMatches } from './compare.js';
import {
  createRuleset,
  deleteRuleset,
  type LiveRuleset,
  type RulesetScope,
  updateRuleset,
} from './rulesets-api.js';
import type { RulesetBody } from './templates.js';
import { type GitHub, GitHubError } from '../github/api.js';

/**
 * A plan is a list of steps, each either already right (`ok`), a change Talos makes (`change`,
 * with the effect that makes it), or something GitHub's API doesn't expose (`manual`, with the
 * words a person follows). Plans are pure; {@link applySteps} carries out their effects in order.
 */
export type Effect =
  | { readonly kind: 'commit'; readonly repo: string; readonly changes: FileChanges }
  | { readonly kind: 'patch-repo'; readonly repo: string; readonly body: Record<string, unknown> }
  | { readonly kind: 'create-ruleset'; readonly scope: RulesetScope; readonly body: RulesetBody }
  | {
      readonly kind: 'update-ruleset';
      readonly scope: RulesetScope;
      readonly id: number;
      readonly body: RulesetBody;
    }
  | { readonly kind: 'delete-ruleset'; readonly scope: RulesetScope; readonly id: number }
  | { readonly kind: 'enable-alerts'; readonly repo: string }
  | {
      readonly kind: 'set-properties';
      readonly repo: string;
      readonly values: readonly { property_name: string; value: string }[];
    }
  | {
      readonly kind: 'define-property';
      readonly org: string;
      readonly name: string;
      readonly body: Record<string, unknown>;
    }
  | {
      readonly kind: 'install';
      readonly installationId: number;
      readonly repositoryId: number;
    };

export type Step =
  | { readonly id: string; readonly status: 'ok'; readonly detail: string }
  | {
      readonly id: string;
      readonly status: 'change';
      readonly detail: string;
      readonly effect: Effect;
    }
  | { readonly id: string; readonly status: 'manual'; readonly detail: string };

export function ok(id: string, detail: string): Step {
  return { id, status: 'ok', detail };
}

export function change(id: string, detail: string, effect: Effect): Step {
  return { id, status: 'change', detail, effect };
}

export function manual(id: string, detail: string): Step {
  return { id, status: 'manual', detail };
}

/** Creates a ruleset that is missing, updates one that differs, and leaves a right one alone. */
export function rulesetStep(
  scope: RulesetScope,
  current: LiveRuleset | undefined,
  desired: RulesetBody,
): Step {
  const id = `ruleset:${desired.name}`;
  if (current === undefined) {
    return change(id, `create ${desired.name}`, { kind: 'create-ruleset', scope, body: desired });
  }
  if (rulesetMatches(current, desired)) return ok(id, `${desired.name} is as Talos sets it`);
  return change(id, `update ${desired.name}`, {
    kind: 'update-ruleset',
    scope,
    id: current.id,
    body: desired,
  });
}

async function run(gh: GitHub, effect: Effect): Promise<void> {
  switch (effect.kind) {
    case 'commit': {
      await commitFiles(gh, effect.repo, effect.changes);
      return;
    }
    case 'patch-repo': {
      await gh.request('PATCH', `repos/${effect.repo}`, { body: effect.body });
      return;
    }
    case 'create-ruleset': {
      await createRuleset(gh, effect.scope, effect.body);
      return;
    }
    case 'update-ruleset': {
      await updateRuleset(gh, effect.scope, effect.id, effect.body);
      return;
    }
    case 'delete-ruleset': {
      await deleteRuleset(gh, effect.scope, effect.id);
      return;
    }
    default: {
      await runSetting(gh, effect);
    }
  }
}

async function runSetting(
  gh: GitHub,
  effect: Extract<
    Effect,
    { kind: 'enable-alerts' | 'set-properties' | 'define-property' | 'install' }
  >,
): Promise<void> {
  switch (effect.kind) {
    case 'enable-alerts': {
      await gh.request('PUT', `repos/${effect.repo}/vulnerability-alerts`);
      return;
    }
    case 'set-properties': {
      await gh.request('PATCH', `repos/${effect.repo}/properties/values`, {
        body: { properties: effect.values },
      });
      return;
    }
    case 'define-property': {
      const path = `orgs/${encodeURIComponent(effect.org)}/properties/schema/${effect.name}`;
      await gh.request('PUT', path, { body: effect.body });
      return;
    }
    case 'install': {
      const path = `user/installations/${effect.installationId}/repositories/${effect.repositoryId}`;
      await gh.request('PUT', path);
      return;
    }
  }
}

export type StepResult = {
  readonly id: string;
  readonly status: 'ok' | 'changed' | 'manual' | 'failed' | 'skipped' | 'planned';
  readonly detail: string;
};

/**
 * What to say about a failed step: the request, its status and GitHub's clipped reason, never the
 * raw response body. Steps run only from an owner's own terminal, never a public log.
 */
function failure(step: Step, error: unknown, hint: (status: number) => string): string {
  if (error instanceof GitHubError) {
    const reason = error.reason === undefined ? '' : ` (${error.reason})`;
    return `${step.detail}: ${error.message}${reason}${hint(error.status)}`;
  }
  return `${step.detail}: ${error instanceof Error ? error.message : String(error)}`;
}

export type ApplyOptions = {
  /** Words added to a refusal, by its status. */
  readonly hint?: (status: number) => string;
  /** Carry on past a failure, for steps that don't depend on each other. */
  readonly independent?: boolean;
};

/**
 * Carries out every `change` in order. The order usually matters (the caller must be on the
 * default branch before any ruleset blocks a direct commit), so the first failure stops the rest,
 * unless the steps are `independent`: then each runs and each failure is reported.
 */
export async function applySteps(
  gh: GitHub,
  steps: readonly Step[],
  options: ApplyOptions = {},
): Promise<StepResult[]> {
  const hint = options.hint ?? (() => '');
  const results: StepResult[] = [];
  let failed = false;
  for (const step of steps) {
    if (step.status !== 'change') {
      results.push({ id: step.id, status: step.status, detail: step.detail });
      continue;
    }
    if (failed && options.independent !== true) {
      results.push({ id: step.id, status: 'skipped', detail: step.detail });
      continue;
    }
    try {
      await run(gh, step.effect);
      results.push({ id: step.id, status: 'changed', detail: step.detail });
    } catch (error) {
      failed = true;
      results.push({ id: step.id, status: 'failed', detail: failure(step, error, hint) });
    }
  }
  return results;
}

/** The plan as results, for `--dry-run`: changes are `planned`, nothing is touched. */
export function planned(steps: readonly Step[]): StepResult[] {
  return steps.map((step) => ({
    id: step.id,
    status: step.status === 'change' ? 'planned' : step.status,
    detail: step.detail,
  }));
}

/** A hint for a refused request: which scopes the owner's `gh` login may lack. */
export function scopeHint(status: number): string {
  if (status === 403 || status === 404) {
    return ' (run `gh auth refresh -s admin:org,workflow` and check you are an owner of the org)';
  }
  // GraphQL reports a refusal inside a 200; the only GraphQL call is the commit of the caller.
  return status === 200
    ? ' (writing a workflow file needs the workflow scope: gh auth refresh -s workflow)'
    : '';
}

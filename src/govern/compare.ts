import type { RulesetBody } from './templates.js';

/**
 * Whether what GitHub answers already says what Talos would send. GitHub's answers carry more
 * than its requests (ids, links, defaults it filled in), so the comparison asks only that every
 * value Talos sets is there; an empty value Talos sets (`[]`, `false`, `null`) also matches a key
 * GitHub left out.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isList(value);
}

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isEmpty(value: unknown): boolean {
  return value === null || value === false || (isList(value) && value.length === 0);
}

function recordCovers(actual: Record<string, unknown>, desired: Record<string, unknown>): boolean {
  return Object.entries(desired).every(([key, value]) =>
    key in actual ? covers(actual[key], value) : isEmpty(value),
  );
}

/** Arrays match in any order: GitHub may return rules and actors in another order. */
function arrayCovers(actual: readonly unknown[], desired: readonly unknown[]): boolean {
  if (actual.length !== desired.length) return false;
  const free = [...actual];
  for (const want of desired) {
    const index = free.findIndex((have) => covers(have, want));
    if (index === -1) return false;
    free.splice(index, 1);
  }
  return true;
}

export function covers(actual: unknown, desired: unknown): boolean {
  if (isList(desired)) return isList(actual) && arrayCovers(actual, desired);
  if (isRecord(desired)) return isRecord(actual) && recordCovers(actual, desired);
  return Object.is(actual, desired);
}

/** GitHub ignores the id of an `OrganizationAdmin` bypass actor, so its answer may differ. */
function comparable(body: RulesetBody): Record<string, unknown> {
  return {
    ...body,
    bypass_actors: body.bypass_actors.map((actor) =>
      actor.actor_type === 'OrganizationAdmin'
        ? { actor_type: actor.actor_type, bypass_mode: actor.bypass_mode }
        : actor,
    ),
  };
}

/** Whether a ruleset GitHub returned already is the one Talos would write. */
export function rulesetMatches(actual: unknown, desired: RulesetBody): boolean {
  return covers(actual, comparable(desired));
}

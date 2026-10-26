import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';
import type { GitHub } from '../github/api.js';
import { labelListSchema } from '../ticket/schemas.js';
import { assetsDir } from '../version/self.js';

export type DesiredLabel = {
  readonly name: string;
  readonly color: string;
  readonly description: string;
};

const labelsFile = z
  .array(
    z.strictObject({
      name: z.string().min(1).max(50),
      color: z.string().regex(/^[0-9A-Fa-f]{6}$/, 'six hex digits, no #'),
      description: z.string().min(1).max(100),
    }),
  )
  .min(1);

/** Validates `labels.yml`: names unique without case, colours as hex, descriptions GitHub takes. */
export function parseLabels(text: string): DesiredLabel[] {
  const labels = labelsFile.parse(parse(text));
  const seen = new Set<string>();
  for (const label of labels) {
    const key = label.name.toLowerCase();
    if (seen.has(key)) throw new Error(`labels.yml names ${label.name} twice`);
    seen.add(key);
  }
  return labels;
}

/** The labels Talos ships (`assets/labels.yml`). */
export async function shippedLabels(): Promise<DesiredLabel[]> {
  return parseLabels(await readFile(new URL('labels.yml', assetsDir()), 'utf8'));
}

export type ExistingLabel = {
  readonly name: string;
  readonly color: string;
  readonly description?: string | null | undefined;
};

export type LabelPlan = {
  readonly create: readonly DesiredLabel[];
  /** `current` is the name the repository has now, which may differ in case. */
  readonly update: readonly (DesiredLabel & { readonly current: string })[];
};

/**
 * What label sync changes: missing labels are created, and ones that differ in case, colour or
 * description updated. Labels the repository has beyond these are its own and stay.
 */
export function labelPlan(
  desired: readonly DesiredLabel[],
  existing: readonly ExistingLabel[],
): LabelPlan {
  const byName = new Map(existing.map((label) => [label.name.toLowerCase(), label]));
  const create: DesiredLabel[] = [];
  const update: (DesiredLabel & { current: string })[] = [];
  for (const label of desired) {
    const current = byName.get(label.name.toLowerCase());
    if (current === undefined) {
      create.push(label);
      continue;
    }
    const same =
      current.name === label.name &&
      current.color.toLowerCase() === label.color.toLowerCase() &&
      (current.description ?? '') === label.description;
    if (!same) update.push({ ...label, current: current.name });
  }
  return { create, update };
}

/** Applies {@link labelPlan} to a repository; returns how many labels it created and updated. */
export async function syncLabels(
  gh: GitHub,
  repo: string,
  desired: readonly DesiredLabel[],
): Promise<{ created: number; updated: number }> {
  const existing = labelListSchema.parse(await gh.paginate<unknown>(`repos/${repo}/labels`));
  const plan = labelPlan(desired, existing);
  for (const label of plan.create) {
    await gh.request('POST', `repos/${repo}/labels`, {
      body: { name: label.name, color: label.color, description: label.description },
    });
  }
  for (const label of plan.update) {
    await gh.request('PATCH', `repos/${repo}/labels/${encodeURIComponent(label.current)}`, {
      body: { new_name: label.name, color: label.color, description: label.description },
    });
  }
  return { created: plan.create.length, updated: plan.update.length };
}

import { z } from 'zod';
import type { GitHub } from './api.js';

/** Where the gate's workflow lives: only a run of this file can speak for the gate. */
const GATE_PATH = '.github/workflows/gate.yml';

/**
 * Whether a run's workflow file is Talos's gate. A repository, or a PR, can add a workflow of its
 * own that runs on the same events and uploads an artifact called `talos-verdict`, so neither the
 * event nor the artifact's name says a run was the gate: the file's repository does.
 */
export function isGateFile(
  file: { readonly path: string; readonly repositoryName: string } | null,
  talosRepo: string,
): boolean {
  if (file === null) return false;
  const repository = file.repositoryName.toLowerCase().replace(/^https:\/\/github\.com\//, '');
  return repository === talosRepo.toLowerCase() && file.path === GATE_PATH;
}

const listSchema = z.object({
  workflow_runs: z.array(
    z.object({
      id: z.number().int(),
      node_id: z.string(),
      created_at: z.string(),
      head_branch: z.string().nullable(),
    }),
  ),
});

const FILES_QUERY = `
query TalosRunFiles($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on WorkflowRun { databaseId file { path repositoryName } }
  }
}`;

const filesSchema = z.object({
  nodes: z.array(
    z
      .object({
        databaseId: z.number().int().optional(),
        file: z.object({ path: z.string(), repositoryName: z.string() }).nullable().optional(),
      })
      .nullable(),
  ),
});

export type QueueRun = {
  readonly id: number;
  /** `gh-readonly-queue/<base>/pr-<N>-<sha>`: the branch GitHub made for the merge group. */
  readonly headBranch: string;
  readonly createdAt: string;
};

/**
 * The gate's runs in the merge queue since `since`, newest first, at most a hundred. Only the
 * merge queue runs code that review has passed, and only the gate's own file speaks for it.
 */
export async function queueGateRuns(
  gh: GitHub,
  repo: string,
  at: { readonly since: Date; readonly talosRepo: string },
): Promise<QueueRun[]> {
  const created = encodeURIComponent(`>=${at.since.toISOString().slice(0, 10)}`);
  const query = `event=merge_group&created=${created}&per_page=100`;
  const runs = listSchema
    .parse(await gh.request<unknown>('GET', `repos/${repo}/actions/runs?${query}`))
    .workflow_runs.filter((r) => Date.parse(r.created_at) >= at.since.getTime());
  if (runs.length === 0) return [];
  const ids = runs.map((r) => r.node_id);
  const files = filesSchema.parse(await gh.graphql<unknown>(FILES_QUERY, { ids }));
  const gate = new Set(
    files.nodes.flatMap((node) =>
      node?.databaseId !== undefined && isGateFile(node.file ?? null, at.talosRepo)
        ? [node.databaseId]
        : [],
    ),
  );
  return runs
    .filter((r) => gate.has(r.id))
    .map((r) => ({ id: r.id, headBranch: r.head_branch ?? '', createdAt: r.created_at }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

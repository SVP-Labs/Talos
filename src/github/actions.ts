import { z } from 'zod';
import type { GitHub } from './api.js';
import { runFields } from './checks.js';

const workflowRunSchema = z.object({
  id: z.number().int(),
  name: z.string().nullable().optional(),
  path: z.string(),
  event: z.string(),
  status: z.string().nullable(),
  conclusion: z.string().nullable(),
  head_sha: z.string(),
  head_branch: z.string().nullable(),
  run_attempt: z.number().int().optional(),
  created_at: z.string(),
  html_url: z.string().optional(),
});

const runsPage = z.object({
  total_count: z.number().int(),
  workflow_runs: z.array(workflowRunSchema),
});

const jobSchema = z.object({
  id: z.number().int(),
  run_id: z.number().int(),
  name: z.string(),
  ...runFields,
  html_url: z.string().nullable().optional(),
});

const artifactSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  size_in_bytes: z.number().int(),
  expired: z.boolean(),
  archive_download_url: z.string(),
});

export type WorkflowRun = z.infer<typeof workflowRunSchema>;
export type WorkflowJob = z.infer<typeof jobSchema>;
export type Artifact = z.infer<typeof artifactSchema>;

export type WorkflowRunFilter = {
  /** A workflow's file name (`gate.yml`) or id; all workflows when absent. */
  readonly workflow?: string;
  readonly headSha?: string;
  readonly branch?: string;
  readonly event?: string;
  /** `completed`, `success`, `failure`, `in_progress` and the other statuses GitHub accepts. */
  readonly status?: string;
  /** At most 100, newest first; defaults to 30. */
  readonly limit?: number;
};

/** The newest workflow runs matching the filter: one page, since a repository has thousands. */
export async function listWorkflowRuns(
  gh: GitHub,
  repo: string,
  filter: WorkflowRunFilter = {},
): Promise<WorkflowRun[]> {
  const query = new URLSearchParams({
    per_page: String(Math.min(Math.max(filter.limit ?? 30, 1), 100)),
  });
  if (filter.headSha !== undefined) query.set('head_sha', filter.headSha);
  if (filter.branch !== undefined) query.set('branch', filter.branch);
  if (filter.event !== undefined) query.set('event', filter.event);
  if (filter.status !== undefined) query.set('status', filter.status);
  const base =
    filter.workflow === undefined
      ? `repos/${repo}/actions/runs`
      : `repos/${repo}/actions/workflows/${encodeURIComponent(filter.workflow)}/runs`;
  const raw = await gh.request<unknown>('GET', `${base}?${query.toString()}`);
  return runsPage.parse(raw).workflow_runs;
}

/** The jobs of a run's latest attempt. */
export async function listRunJobs(gh: GitHub, repo: string, runId: number): Promise<WorkflowJob[]> {
  const raw = await gh.paginate<unknown>(
    `repos/${repo}/actions/runs/${runId}/jobs?filter=latest`,
    'jobs',
  );
  return z.array(jobSchema).parse(raw);
}

export async function listRunArtifacts(
  gh: GitHub,
  repo: string,
  runId: number,
): Promise<Artifact[]> {
  const raw = await gh.paginate<unknown>(
    `repos/${repo}/actions/runs/${runId}/artifacts`,
    'artifacts',
  );
  return z.array(artifactSchema).parse(raw);
}

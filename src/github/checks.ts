import { z } from 'zod';
import type { GitHub } from './api.js';

const checkRunSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  head_sha: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  started_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  details_url: z.string().nullable().optional(),
  external_id: z.string().nullable().optional(),
  app: z.object({ id: z.number().int(), slug: z.string().optional() }).nullable().optional(),
});

export type CheckRun = z.infer<typeof checkRunSchema>;

export type CheckRunFilter = {
  /** The check run's name, such as `talos/review`. */
  readonly name?: string;
  /** The App that created it, by slug (`talos-reviewer`, without `[bot]`). */
  readonly app?: string;
};

/** The latest check runs on a commit (or branch or tag), optionally by name and App. */
export async function listCheckRuns(
  gh: GitHub,
  repo: string,
  ref: string,
  filter: CheckRunFilter = {},
): Promise<CheckRun[]> {
  const query = new URLSearchParams({ filter: 'latest' });
  if (filter.name !== undefined) query.set('check_name', filter.name);
  const raw = await gh.paginate<unknown>(
    `repos/${repo}/commits/${encodeURIComponent(ref)}/check-runs?${query.toString()}`,
    'check_runs',
  );
  const runs = z.array(checkRunSchema).parse(raw);
  const app = filter.app?.replace(/\[bot\]$/, '');
  return app === undefined ? runs : runs.filter((run) => run.app?.slug === app);
}

export type Conclusion =
  'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required';

export type Annotation = {
  readonly path: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly annotation_level: 'notice' | 'warning' | 'failure';
  readonly message: string;
  readonly title?: string;
};

export type CheckOutput = {
  readonly title: string;
  readonly summary: string;
  readonly text?: string;
  /** GitHub takes at most 50 per request; the rest are dropped. */
  readonly annotations?: readonly Annotation[];
};

export type CheckRunFields = {
  readonly status?: 'queued' | 'in_progress' | 'completed';
  /** Setting one completes the run, at `completedAt` or now. */
  readonly conclusion?: Conclusion;
  readonly completedAt?: Date;
  readonly detailsUrl?: string;
  readonly externalId?: string;
  readonly output?: CheckOutput;
};

const MAX_ANNOTATIONS = 50;
const MAX_TEXT = 65_535;

function limited(text: string): string {
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1)}…`;
}

function defined(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

function body(fields: CheckRunFields): Record<string, unknown> {
  const { output } = fields;
  return defined({
    status: fields.status,
    conclusion: fields.conclusion,
    completed_at:
      fields.conclusion === undefined
        ? undefined
        : (fields.completedAt ?? new Date()).toISOString(),
    details_url: fields.detailsUrl,
    external_id: fields.externalId,
    output:
      output === undefined
        ? undefined
        : defined({
            title: output.title,
            summary: limited(output.summary),
            text: output.text === undefined ? undefined : limited(output.text),
            annotations: output.annotations?.slice(0, MAX_ANNOTATIONS),
          }),
  });
}

/** Creates a check run on `headSha`; needs `checks: write`, which only an App token has. */
export async function createCheckRun(
  gh: GitHub,
  repo: string,
  run: CheckRunFields & { readonly name: string; readonly headSha: string },
): Promise<CheckRun> {
  const raw = await gh.request<unknown>('POST', `repos/${repo}/check-runs`, {
    body: { name: run.name, head_sha: run.headSha, ...body(run) },
  });
  return checkRunSchema.parse(raw);
}

export async function updateCheckRun(
  gh: GitHub,
  repo: string,
  id: number,
  fields: CheckRunFields,
): Promise<CheckRun> {
  const raw = await gh.request<unknown>('PATCH', `repos/${repo}/check-runs/${id}`, {
    body: body(fields),
  });
  return checkRunSchema.parse(raw);
}

/** A check's state as agents read it, whatever produced it: a check run, a suite, a rollup. */
export type CheckState = 'green' | 'red' | 'pending' | 'unknown';

const GREEN = new Set(['success', 'neutral', 'skipped']);
const RED = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure']);

/**
 * One state for a set of runs (REST's lower case or GraphQL's upper case): red when any failed,
 * else pending while any is unfinished, green when all passed, unknown when there are none or a
 * conclusion says nothing (`stale`).
 */
export function stateOf(
  runs: readonly { readonly status: string; readonly conclusion: string | null }[],
): CheckState {
  if (runs.length === 0) return 'unknown';
  const conclusions = runs.map((run) => run.conclusion?.toLowerCase() ?? null);
  if (conclusions.some((c) => c !== null && RED.has(c))) return 'red';
  if (runs.some((run) => run.status.toLowerCase() !== 'completed')) return 'pending';
  return conclusions.every((c) => c !== null && GREEN.has(c)) ? 'green' : 'unknown';
}

import { z } from 'zod';
import { EngineError } from '../core/check.js';
import { printedBytes, VERDICT_CAPS } from '../engine/verdict-caps.js';
import type { GitHub } from '../github/api.js';
import { type Download, readArtifactFile } from '../github/artifacts.js';
import { isGateFile, queueGateRuns } from '../github/gate-runs.js';

const RUNS_QUERY = `
query TalosGateRuns($owner: String!, $name: String!, $sha: GitObjectID!) {
  repository(owner: $owner, name: $name) {
    object(oid: $sha) {
      ... on Commit {
        checkSuites(last: 50) {
          nodes { createdAt workflowRun { databaseId file { path repositoryName } } }
        }
      }
    }
  }
}`;

const runsSchema = z.object({
  repository: z.object({
    object: z
      .object({
        checkSuites: z.object({
          nodes: z.array(
            z.object({
              createdAt: z.string(),
              workflowRun: z
                .object({
                  databaseId: z.number().int(),
                  file: z.object({ path: z.string(), repositoryName: z.string() }).nullable(),
                })
                .nullable(),
            }),
          ),
        }),
      })
      .nullable(),
  }),
});

const pullSchema = z.object({
  head: z.object({ sha: z.string() }),
  base: z.object({ ref: z.string() }),
});

const CAP = VERDICT_CAPS;

const count = z.number().int().nonnegative();
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const rule = z.string().min(1).max(CAP.rule);
const path = z.string().max(CAP.path).nullable();

/**
 * Re-checked on the way out: a verdict passes through only in its own capped shape, the one
 * `docs/contracts/verdict.schema.json` publishes, and only with the fields that shape names. A
 * verdict past any cap, its bytes included, is none the gate wrote.
 */
const verdictSchema = z
  .object({
    schema: z.literal('talos.verdict/1'),
    talos: z.string().min(1).max(CAP.talos),
    repo: z.string().nullable(),
    pr: z.number().int().positive().nullable(),
    mode: z.enum(['draft', 'ready', 'merge-group']),
    base: sha,
    head: sha,
    status: z.enum(['green', 'red', 'engine-error']),
    counts: z.object({
      blocking: count,
      existing: count,
      faults: count,
      byRule: z
        .record(rule, z.number().int().positive())
        .refine((rules) => Object.keys(rules).length <= CAP.rules),
    }),
    blocking: z
      .array(
        z.object({
          sha,
          rule,
          why: z.enum(['new', 'changed-line', 'security', 'lost', 'existing', 'info']),
          file: path,
          line: z.number().int().positive().nullable(),
          message: z.string().max(CAP.message),
        }),
      )
      .max(CAP.listed),
    faults: z
      .array(
        z.object({
          sha,
          os: z.enum(['linux', 'windows', 'macos']),
          check: z.string().min(1).max(CAP.check),
          reason: z.string().max(CAP.reason),
        }),
      )
      .max(CAP.faults),
    flaky: z.array(z.object({ id: z.string().max(CAP.test), file: path })).max(CAP.listed),
    truncated: z.boolean(),
  })
  .refine((verdict) => printedBytes(verdict) <= CAP.bytes);

/** The artifact's text as a verdict, or `undefined` when it is no verdict Talos can read. */
function readVerdict(text: string): z.infer<typeof verdictSchema> | undefined {
  try {
    return verdictSchema.safeParse(JSON.parse(text)).data;
  } catch {
    return undefined;
  }
}

type GateRun = { readonly id: number; readonly createdAt: string };

/** The newest gate run on a commit: a run whose workflow file is Talos's gate. */
async function gateRunOn(
  gh: GitHub,
  repo: string,
  sha: string,
  talosRepo: string,
): Promise<GateRun | undefined> {
  const [owner, name] = repo.split('/');
  const data = runsSchema.parse(await gh.graphql<unknown>(RUNS_QUERY, { owner, name, sha }));
  const runs = (data.repository.object?.checkSuites.nodes ?? [])
    .filter((suite) => isGateFile(suite.workflowRun?.file ?? null, talosRepo))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const id = runs[0]?.workflowRun?.databaseId;
  return id === undefined ? undefined : { id, createdAt: runs[0]?.createdAt ?? '' };
}

/**
 * The gate's newest run on a merge group of the PR since its head's run: the verdict that took
 * the PR out of the queue, when one did. GitHub names a group's branch after the PR it tests.
 */
async function queueRunAfter(
  deps: FindingsDeps,
  at: { readonly repo: string; readonly pr: number; readonly base: string; readonly head: GateRun },
): Promise<GateRun | undefined> {
  const since = new Date(at.head.createdAt);
  if (Number.isNaN(since.getTime())) return undefined;
  const prefix = `gh-readonly-queue/${at.base}/pr-${at.pr}-`;
  const runs = await queueGateRuns(deps.gh, at.repo, { since, talosRepo: deps.talosRepo });
  const run = runs.find((r) => r.headBranch.startsWith(prefix) && r.createdAt > at.head.createdAt);
  return run === undefined ? undefined : { id: run.id, createdAt: run.createdAt };
}

export type FindingsDeps = {
  readonly gh: GitHub;
  readonly download: Download;
  readonly talosRepo: string;
};

/** The run's `verdict.json`, `undefined` with none, or why its archive can't be read. */
async function verdictFile(
  deps: FindingsDeps,
  repo: string,
  runId: number,
): Promise<{ readonly text?: string; readonly error?: string }> {
  const wanted = { repo, runId, artifact: 'talos-verdict', file: 'verdict.json' };
  try {
    const text = await readArtifactFile(deps.gh, deps.download, wanted);
    return text === undefined ? {} : { text };
  } catch (error) {
    if (!(error instanceof EngineError)) throw error;
    return { error: error.message.slice(0, CAP.message) };
  }
}

/**
 * The latest gate verdict for a PR (`talos.verdict/1`) with the `run` that left it: its head's,
 * or, when the merge queue judged the PR since, the queue's (`mode: merge-group`). Status
 * `unknown` when no gate run left one, with `error` when the one it left can't be read.
 */
export async function prFindings(
  deps: FindingsDeps,
  repo: string,
  pr: number,
): Promise<Record<string, unknown>> {
  const pull = pullSchema.parse(await deps.gh.request<unknown>('GET', `repos/${repo}/pulls/${pr}`));
  const head = pull.head.sha;
  const unknown = { schema: 'talos.verdict/1', status: 'unknown', repo, pr, head };
  const headRun = await gateRunOn(deps.gh, repo, head, deps.talosRepo);
  if (headRun === undefined) return unknown;
  const queued = await queueRunAfter(deps, { repo, pr, base: pull.base.ref, head: headRun });
  const runId = (queued ?? headRun).id;
  const { text, error } = await verdictFile(deps, repo, runId);
  if (error !== undefined) return { ...unknown, error };
  if (text === undefined) return unknown;
  const verdict = readVerdict(text);
  if (verdict === undefined) {
    return { ...unknown, error: 'the gate run left a verdict Talos cannot read' };
  }
  return { ...verdict, repo, pr, head, run: runId };
}

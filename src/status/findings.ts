import { z } from 'zod';
import type { Exec } from '../exec/exec.js';
import type { GitHub } from '../github/api.js';
import { type Download, readArtifactFile } from '../github/artifacts.js';

/** Where the gate's workflow lives: only a run of this file can speak for the gate. */
const GATE_PATH = '.github/workflows/gate.yml';

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

const pullSchema = z.object({ head: z.object({ sha: z.string() }) });

const MAX_LISTED = 20;
const MAX_FAULTS = 5;
const MAX_MESSAGE = 200;
const MAX_REASON = 300;

const count = z.number().int().nonnegative();
const sha = z.string().regex(/^[0-9a-f]{40}$/);

/**
 * Re-checked on the way out: a verdict passes through only in its own capped shape, the one
 * `docs/contracts/verdict.schema.json` publishes, and only with the fields that shape names.
 */
const verdictSchema = z.object({
  schema: z.literal('talos.verdict/1'),
  talos: z.string().min(1),
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
    byRule: z.record(z.string(), z.number().int().positive()),
  }),
  blocking: z
    .array(
      z.object({
        sha,
        rule: z.string().min(1),
        why: z.enum(['new', 'changed-line', 'security', 'lost', 'existing', 'info']),
        file: z.string().nullable(),
        line: z.number().int().positive().nullable(),
        message: z.string().max(MAX_MESSAGE),
      }),
    )
    .max(MAX_LISTED),
  faults: z
    .array(
      z.object({
        sha,
        os: z.enum(['linux', 'windows', 'macos']),
        check: z.string().min(1),
        reason: z.string().max(MAX_REASON),
      }),
    )
    .max(MAX_FAULTS),
  flaky: z.array(z.object({ id: z.string(), file: z.string().nullable() })).max(MAX_LISTED),
  truncated: z.boolean(),
});

/** The artifact's text as a verdict, or `undefined` when it is no verdict Talos can read. */
function readVerdict(text: string): z.infer<typeof verdictSchema> | undefined {
  try {
    return verdictSchema.safeParse(JSON.parse(text)).data;
  } catch {
    return undefined;
  }
}

function isGateRun(
  file: { path: string; repositoryName: string } | null,
  talosRepo: string,
): boolean {
  if (file === null) return false;
  const repository = file.repositoryName.toLowerCase().replace(/^https:\/\/github\.com\//, '');
  return repository === talosRepo.toLowerCase() && file.path === GATE_PATH;
}

/**
 * The newest gate run on a commit. A PR can add a workflow of its own that uploads an artifact
 * called `talos-verdict`, so a run counts only when its workflow file is Talos's gate.
 */
async function gateRunOn(
  gh: GitHub,
  repo: string,
  sha: string,
  talosRepo: string,
): Promise<number | undefined> {
  const [owner, name] = repo.split('/');
  const data = runsSchema.parse(await gh.graphql<unknown>(RUNS_QUERY, { owner, name, sha }));
  const runs = (data.repository.object?.checkSuites.nodes ?? [])
    .filter((suite) => isGateRun(suite.workflowRun?.file ?? null, talosRepo))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return runs[0]?.workflowRun?.databaseId;
}

export type FindingsDeps = {
  readonly gh: GitHub;
  readonly download: Download;
  readonly exec: Exec;
  readonly talosRepo: string;
};

/**
 * The latest gate verdict for a PR's head (`talos.verdict/1`) with the `run` that left it, or
 * status `unknown` when no gate run left one, with `error` when the one it left can't be read.
 */
export async function prFindings(
  deps: FindingsDeps,
  repo: string,
  pr: number,
): Promise<Record<string, unknown>> {
  const pull = pullSchema.parse(await deps.gh.request<unknown>('GET', `repos/${repo}/pulls/${pr}`));
  const head = pull.head.sha;
  const unknown = { schema: 'talos.verdict/1', status: 'unknown', repo, pr, head };
  const runId = await gateRunOn(deps.gh, repo, head, deps.talosRepo);
  if (runId === undefined) return unknown;
  const text = await readArtifactFile(deps.gh, deps.download, deps.exec, {
    repo,
    runId,
    artifact: 'talos-verdict',
    file: 'verdict.json',
  });
  if (text === undefined) return unknown;
  const verdict = readVerdict(text);
  if (verdict === undefined) {
    return { ...unknown, error: 'the gate run left a verdict Talos cannot read' };
  }
  return { ...verdict, repo, pr, head, run: runId };
}

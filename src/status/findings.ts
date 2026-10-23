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
const MAX_MESSAGE = 200;

/** Re-checked on the way out: a verdict passes through only in its own capped shape. */
const verdictSchema = z
  .object({
    schema: z.literal('talos.verdict/1'),
    status: z.enum(['green', 'red', 'engine-error']),
    blocking: z.array(z.object({ message: z.string().max(MAX_MESSAGE) }).loose()).max(MAX_LISTED),
  })
  .loose();

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

/** The latest gate verdict for a PR's head (`talos.verdict/1`), or status `unknown`. */
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
  const verdict = verdictSchema.safeParse(JSON.parse(text));
  if (!verdict.success) {
    return { ...unknown, error: 'the gate run left a verdict Talos cannot read' };
  }
  return { ...verdict.data, repo, pr, head, run: runId };
}

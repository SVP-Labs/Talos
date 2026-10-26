import { z } from 'zod';
import { type GateTally, tallyJobs } from './channels.js';
import { listRunJobs } from '../github/actions.js';
import type { GitHub } from '../github/api.js';
import { listInstallationRepositories, propertyOf } from '../github/repos.js';

/**
 * Gate runs on canary repositories, read as `talos-release` with a token minted for them alone
 * (actions: read). The gate is the organisation's required workflow, so its runs are listed
 * among each repository's own; the gate's job names carry the release, which is how a run is told
 * apart from the rest.
 */

const GATE_EVENTS: ReadonlySet<string> = new Set(['pull_request', 'merge_group']);
const MAX_RUNS = 300;

const runSchema = z.object({ id: z.number().int(), event: z.string() });

/** The repositories on the canary channel that the token reaches, archived ones left out. */
export async function canaryRepositories(gh: GitHub): Promise<string[]> {
  const repos = await listInstallationRepositories(gh);
  return repos
    .filter((repo) => !repo.archived && propertyOf(repo, 'talos') === 'canary')
    .map((repo) => repo.fullName);
}

async function gateRunIds(gh: GitHub, repo: string, since: string): Promise<number[]> {
  const created = encodeURIComponent(`>=${since}`);
  const raw = await gh.paginate<unknown>(
    `repos/${repo}/actions/runs?status=completed&created=${created}`,
    'workflow_runs',
  );
  return z
    .array(runSchema)
    .parse(raw)
    .filter((run) => GATE_EVENTS.has(run.event))
    .slice(0, MAX_RUNS)
    .map((run) => run.id);
}

/**
 * Every gate run under `version` on the given repositories since `since` (the release's tag,
 * before which no run can have used it). Stops early at the first engine error, which settles
 * the question.
 */
export async function tallyGateRuns(
  gh: GitHub,
  repos: readonly string[],
  version: string,
  since: string,
): Promise<GateTally> {
  let runs = 0;
  for (const repo of repos) {
    for (const id of await gateRunIds(gh, repo, since)) {
      const tally = tallyJobs(await listRunJobs(gh, repo, id), version);
      runs += tally.runs;
      if (tally.engineErrors > 0) return { runs, engineErrors: tally.engineErrors };
    }
  }
  return { runs, engineErrors: 0 };
}

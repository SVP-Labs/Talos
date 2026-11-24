import { z } from 'zod';
import { issueOfBranch, releasedLabels } from './claim.js';
import {
  addComment,
  branchHead,
  changeLabels,
  deleteBranch,
  encodePath,
  getIssue,
  openPullsFrom,
} from './github.js';
import { LABEL } from './labels.js';
import { type Issue, refSchema, timelineSchema } from './schemas.js';
import { GitHubError, type GitHub } from '../github/api.js';

/** A claim idle this long is released, unless a PR from its branch is open, draft or ready. */
export const STALE_HOURS = 4;

const HOUR = 3_600_000;

export type Activity = {
  /** When the ticket was last labelled `status/in-progress`: the claim. */
  readonly claimedAt?: string | undefined;
  /** The committer date of the branch's head. */
  readonly pushedAt?: string | undefined;
  /**
   * A PR from the branch is open, draft or ready: a draft can wait on its owner for days, and
   * deleting its branch would close it.
   */
  readonly openPull: boolean;
};

export type Staleness = {
  readonly stale: boolean;
  readonly idleHours: number | null;
  readonly why: 'pull-open' | 'no-activity-known' | 'active' | 'idle';
};

/**
 * Idle time runs from the newer of the claim and the last push, so a branch created at an old
 * `main` isn't stale for that alone.
 */
export function staleness(activity: Activity, now: Date): Staleness {
  if (activity.openPull) return { stale: false, idleHours: null, why: 'pull-open' };
  const times = [activity.claimedAt, activity.pushedAt]
    .map((t) => (t === undefined ? Number.NaN : Date.parse(t)))
    .filter((t) => !Number.isNaN(t));
  if (times.length === 0) return { stale: false, idleHours: null, why: 'no-activity-known' };
  const idle = now.getTime() - Math.max(...times);
  const idleHours = Math.max(0, Math.floor(idle / HOUR));
  return idle > STALE_HOURS * HOUR
    ? { stale: true, idleHours, why: 'idle' }
    : { stale: false, idleHours, why: 'active' };
}

export type TicketBranch = { readonly branch: string; readonly issue: number };

/** Every `<P>-<N>` branch: every claim, open or left behind. */
export async function ticketBranches(
  gh: GitHub,
  repo: string,
  prefix: string,
): Promise<TicketBranch[]> {
  const branchPrefix = `${prefix}-`;
  const data = await gh.request<unknown>(
    'GET',
    `repos/${repo}/git/matching-refs/heads/${encodePath(branchPrefix)}`,
  );
  return z
    .array(refSchema)
    .parse(data)
    .flatMap((ref) => {
      const branch = ref.ref.replace(/^refs\/heads\//, '');
      const issue = issueOfBranch(prefix, branch);
      return issue === undefined ? [] : [{ branch, issue }];
    });
}

async function claimedAt(gh: GitHub, repo: string, issue: number): Promise<string | undefined> {
  const events = timelineSchema.parse(
    await gh.paginate<unknown>(`repos/${repo}/issues/${issue}/timeline`),
  );
  return events
    .filter((e) => e.event === 'labeled' && e.label?.name === LABEL.inProgress)
    .map((e) => e.created_at)
    .filter((t) => t !== undefined)
    .at(-1);
}

async function activityOf(gh: GitHub, repo: string, claim: TicketBranch): Promise<Activity> {
  const pulls = await openPullsFrom(gh, repo, claim.branch);
  if (pulls.length > 0) return { openPull: true };
  const head = await branchHead(gh, repo, claim.branch);
  return {
    openPull: false,
    claimedAt: await claimedAt(gh, repo, claim.issue),
    pushedAt: head?.date,
  };
}

export type SweepClients = {
  /** Issues: labels and comments. */
  readonly gh: GitHub;
  /** Deleting a branch needs `contents: write`, which the reviewer App doesn't hold. */
  readonly refs: GitHub;
};

type Stale = {
  readonly issue: Issue;
  readonly branch: string;
  readonly idleHours: number;
};

/**
 * Releases a claim labels first and branch last, so that a step refused part-way leaves the
 * branch, which the next sweep finds and finishes; a deleted branch with the claim's labels still
 * on its issue would be stranded, since every sweep starts from the branches.
 */
async function releaseStale(c: SweepClients, repo: string, stale: Stale): Promise<void> {
  await changeLabels(c.gh, repo, stale.issue.number, releasedLabels(stale.issue));
  await deleteBranch(c.refs, repo, stale.branch);
  const idle = `${stale.idleHours} h (limit ${STALE_HOURS} h)`;
  if (stale.issue.state === 'open') {
    await addComment(
      c.gh,
      repo,
      stale.issue.number,
      `🔓 released: the claim was idle for ${idle}; branch \`${stale.branch}\` is deleted ` +
        'and the ticket is open to claim again.',
    );
  }
}

type SweepFailure = { readonly branch: string; readonly error: string };

export type SweepResult = {
  readonly released: readonly number[];
  readonly kept: number;
  readonly failures: readonly SweepFailure[];
};

/** A refusal's method, path and status are safe to report; anything else might hold repository
 *  content. */
function safeFailure(error: unknown): string {
  return error instanceof GitHubError ? error.message : 'an error in the sweep';
}

/** Releases every claim idle longer than {@link STALE_HOURS}; one failure doesn't stop the rest. */
export async function sweepStaleClaims(
  c: SweepClients,
  at: { readonly repo: string; readonly prefix: string; readonly now: Date },
): Promise<SweepResult> {
  const released: number[] = [];
  const failures: SweepFailure[] = [];
  let kept = 0;
  for (const claim of await ticketBranches(c.gh, at.repo, at.prefix)) {
    try {
      const issue = await getIssue(c.gh, at.repo, claim.issue);
      if (issue === undefined || issue.isPull) {
        kept += 1;
        continue;
      }
      const verdict = staleness(await activityOf(c.gh, at.repo, claim), at.now);
      if (!verdict.stale || verdict.idleHours === null) {
        kept += 1;
        continue;
      }
      await releaseStale(c, at.repo, { ...claim, issue, idleHours: verdict.idleHours });
      released.push(claim.issue);
    } catch (error) {
      failures.push({ branch: claim.branch, error: safeFailure(error) });
    }
  }
  return { released, kept, failures };
}

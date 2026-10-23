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
import { type Issue, type Pull, refSchema, timelineSchema } from './schemas.js';
import type { GitHub } from '../github/api.js';

/** A claim idle this long is released, unless a PR from it is ready for review. */
export const STALE_HOURS = 4;

const HOUR = 3_600_000;

export type Activity = {
  /** When the ticket was last labelled `status/in-progress`: the claim. */
  readonly claimedAt?: string | undefined;
  /** The committer date of the branch's head. */
  readonly pushedAt?: string | undefined;
  /** When the draft PR from the branch last changed. */
  readonly draftUpdatedAt?: string | undefined;
  /** A PR from the branch is open and ready for review: review time is never idle time. */
  readonly readyPull: boolean;
};

export type Staleness = {
  readonly stale: boolean;
  readonly idleHours: number | null;
  readonly why: 'in-review' | 'no-activity-known' | 'active' | 'idle';
};

/**
 * Idle time runs from the newest of the claim, the last push and the draft PR's last change, so
 * a branch created at an old `main` isn't stale for that alone.
 */
export function staleness(activity: Activity, now: Date): Staleness {
  if (activity.readyPull) return { stale: false, idleHours: null, why: 'in-review' };
  const times = [activity.claimedAt, activity.pushedAt, activity.draftUpdatedAt]
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

async function activityOf(
  gh: GitHub,
  repo: string,
  claim: TicketBranch,
): Promise<{ activity: Activity; draft: Pull | undefined }> {
  const pulls = await openPullsFrom(gh, repo, claim.branch);
  const draft = pulls.find((p) => p.draft);
  if (pulls.some((p) => !p.draft)) return { activity: { readyPull: true }, draft };
  const head = await branchHead(gh, repo, claim.branch);
  const activity: Activity = {
    readyPull: false,
    claimedAt: await claimedAt(gh, repo, claim.issue),
    pushedAt: head?.date,
    draftUpdatedAt: draft?.updatedAt,
  };
  return { activity, draft };
}

export type SweepClients = {
  /** Issues: labels and comments, on the issue and on the draft. */
  readonly gh: GitHub;
  /** Deleting a branch needs `contents: write`, which the reviewer App doesn't hold. */
  readonly refs: GitHub;
};

type Stale = {
  readonly issue: Issue;
  readonly branch: string;
  readonly draft: Pull | undefined;
  readonly idleHours: number;
};

/**
 * Releases a claim labels first and branch last, so that a step refused part-way leaves the
 * branch, which the next sweep finds and finishes; a deleted branch with the claim's labels still
 * on its issue would be stranded, since every sweep starts from the branches. Deleting the branch
 * closes its draft, so no pull request needs writing.
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
  if (stale.draft !== undefined) {
    await addComment(
      c.gh,
      repo,
      stale.draft.number,
      `Closed by Talos: the claim on #${stale.issue.number} was idle for ${idle}. ` +
        'The commits stay on this pull request.',
    ).catch(() => undefined);
  }
}

export type SweepResult = {
  readonly released: readonly number[];
  readonly kept: number;
  readonly failed: number;
};

/** Releases every claim idle longer than {@link STALE_HOURS}; one failure doesn't stop the rest. */
export async function sweepStaleClaims(
  c: SweepClients,
  at: { readonly repo: string; readonly prefix: string; readonly now: Date },
): Promise<SweepResult> {
  const released: number[] = [];
  let kept = 0;
  let failed = 0;
  for (const claim of await ticketBranches(c.gh, at.repo, at.prefix)) {
    try {
      const issue = await getIssue(c.gh, at.repo, claim.issue);
      if (issue === undefined || issue.isPull) {
        kept += 1;
        continue;
      }
      const { activity, draft } = await activityOf(c.gh, at.repo, claim);
      const verdict = staleness(activity, at.now);
      if (!verdict.stale || verdict.idleHours === null) {
        kept += 1;
        continue;
      }
      await releaseStale(c, at.repo, { ...claim, issue, draft, idleHours: verdict.idleHours });
      released.push(claim.issue);
    } catch {
      failed += 1;
    }
  }
  return { released, kept, failed };
}

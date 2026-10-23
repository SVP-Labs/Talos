import type { JobContext, JobOutcome } from '../jobs/context.js';

/**
 * `talos/review` for the event in `ctx`: the reviewer's AI review where agents are on, the
 * owner's approval or the debt-and-chore conditions, published as a check run on the PR's head
 * or the merge group's head.
 */
export function reviewJob(_ctx: JobContext): Promise<JobOutcome[]> {
  return Promise.resolve([]);
}
